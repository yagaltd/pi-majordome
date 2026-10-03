/**
 * pi-majordome — topic memory for the pi coding agent.
 *
 * turn_end:  re-read the session JSONL (source of truth, never rewritten),
 *            close newly finished EMA blocks, judge them (TypeLLM strings +
 *            Jev/TypeLLM dims), append to the global side-car index.
 * context:   route the user message (intent DAG → time-travel → federated →
 *            specialist arm) and inject the winning block's ToC entry at the
 *            tail — request-local, so the transcript stays canonical and the
 *            provider cache stays intact (tail is the cache-free zone).
 * /majordome: governance surface — human-readable dashboard, table ToC,
 *            short ids (code-parser:1), show/forget/export/reindex/on/off.
 *
 * Fail-open everywhere: no key, no classifier, judge error → skip that step,
 * log the reason, never throw into pi. MAJORDOME_OFF=1 disables; the index
 * is plain JSONL under ~/.pi/majordome/ — inspectable, purgeable, exportable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blockCores, detectBoundaries, parseSession, sessionSlug, shortTag, textof, tokens } from "./ext/core.ts";
import { blockMeta, contradicts, dimVector, induceDims, loadKey, resetClassifyFn, routingIntent, setClassifyFn, setStreamFn, hasJev } from "./ext/judges.ts";
import { docsNudge, injectionText, judgeLine, scanDocsTouched, shouldJudgeLine, route } from "./ext/router.ts";
import { listKinds, composeKind } from "./ext/docs.ts";
import { appendBlock, appendDecision, lastDecisions, loadBlocks, loadMeta, loadVocab, majordomeDir, rewriteBlocks, saveMeta, saveVocab, type Block } from "./ext/store.ts";

interface St {
	on: boolean;
	reason: string;
	sessionFile: string | null;
	blocks: Block[];
	vocab: string[];
	indexedKeys: Set<string>;
	routeCache: { query: string; result: Awaited<ReturnType<typeof route>>; contraLine: string | null } | null;
	uiCtx: { hasUI: boolean; ui: { setStatus(k: string, v: string): void } } | null;
	injects: number;
	judgeMode: "off" | "soft" | "strict";
	docsNudge: string | null;
	docsCursor: Record<string, string>;
	lastNudgeCount: number;
}

const st: St = {
	on: process.env.MAJORDOME_OFF !== "1",
	reason: "",
	sessionFile: null,
	blocks: [],
	vocab: [],
	indexedKeys: new Set(),
	routeCache: null,
	uiCtx: null,
	injects: 0,
	judgeMode: (process.env.MAJORDOME_JUDGE as St["judgeMode"]) || "soft",
	docsNudge: null,
	docsCursor: {},
	lastNudgeCount: 0,
};


function shortId(b: Block): string {
	return `${shortTag(b.session)}:${b.firstTurn}`;
}
/** Resolve a full id or a short id (tag:n — first tag-contains + firstTurn match). */
function resolveId(input: string): Block | undefined {
	const exact = st.blocks.find((b) => b.id === input || b.id.endsWith(`:${input}`));
	if (exact) return exact;
	const m = input.match(/^(.+):(\d+)$/);
	if (m) {
		const tag = m[1].toLowerCase();
		return st.blocks.find((b) => shortTag(b.session).toLowerCase() === tag && b.firstTurn === Number(m[2]))
			?? st.blocks.find((b) => shortTag(b.session).toLowerCase().includes(tag) && b.firstTurn === Number(m[2]));
	}
	return undefined;
}
function pad(s: string, n: number): string {
	return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

/** Emit the pending docs nudge once at the tail, then clear. */
function emitDocsNudge(lastUser: any): void {
	if (!st.docsNudge) return;
	appendTail(lastUser, st.docsNudge);
	st.docsNudge = null;
}

/** Append a tail text BLOCK, preserving the content shape — downstream
 * context handlers may map/template-literal content; stringifying here
 * renders as [object Object] in whatever runs after us. */
function appendTail(lastUser: any, text: string): void {
	const block = { type: "text", text };
	if (Array.isArray(lastUser.content)) lastUser.content.push(block);
	else if (typeof lastUser.content === "string") lastUser.content += `\n\n${text}`;
	else lastUser.content = [block];
}

function currentTurnCount(): number {
	return st.sessionFile ? parseSession(st.sessionFile).length : 0;
}

function status(): void {
	if (!st.uiCtx?.hasUI) return;
	if (!st.on) st.uiCtx.ui.setStatus("majordome", `majordome off (${st.reason.slice(0, 40)})`);
	else if (!loadKey()) st.uiCtx.ui.setStatus("majordome", "majordome: recall off — run npx tsx ext/judges.ts setup");
	else {
		const n = st.blocks.length;
		st.uiCtx.ui.setStatus("majordome", `🧭 ${n}b · ${st.vocab.length}d${hasJev() ? "" : " ·lex"}`);
	}
}

/** Close every newly finished block of the current session (the EMA open tail
 * stays unindexed until the session moves past it — time-travel's guard). */
async function indexSession(): Promise<number> {
	if (!st.sessionFile || !st.on) return 0;
	const turns = parseSession(st.sessionFile);
	if (turns.length < 2) return 0;
	const firsts = detectBoundaries(turns, 0.07, 4);
	const cores = blockCores(turns, firsts);
	const slug = sessionSlug(st.sessionFile);
	let closed = 0;
	for (const core of cores) {
		if (core.lastTurn >= turns.length) continue; // open tail
		const id = `${slug}:${core.firstTurn}`;
		if (st.indexedKeys.has(id)) continue;
		st.indexedKeys.add(id);

		// grow the dims vocabulary while under cap (slice-3 induction)
		if (st.vocab.length < 40) {
			const induced = await induceDims(core.text);
			const fresh = induced.filter((d) => !st.vocab.includes(d));
			if (fresh.length) {
				st.vocab = [...st.vocab, ...fresh].slice(0, 40);
				saveMeta({ dims: st.vocab, docsCursor: st.docsCursor });
			}
		}

		let meta; let vec;
		try {
			meta = await blockMeta(core.text);
			vec = st.vocab.length ? await dimVector(core.text, st.vocab, "segment") : null;
		} catch (e) {
			try {
				appendFileSync(join(majordomeDir(), "errors.log"), `${new Date().toISOString()} ${id} judge: ${(e as Error)?.stack ?? e}\n`);
			} catch { /* ignore */ }
			meta = undefined; vec = null;
		}
		const block: Block = {
			id,
			session: slug,
			sessionFile: st.sessionFile,
			firstTurn: core.firstTurn,
			lastTurn: core.lastTurn,
			gist: meta?.gist ?? null,
			intent: meta?.intent ?? null,
			dims: vec ? Object.fromEntries(vec) : {},
			tokensHybrid: [...core.tokensHybrid].sort(),
			head: turns[core.firstTurn - 1].user.slice(0, 200),
			closedAt: new Date().toISOString(),
		};
		try {
			appendBlock(block);
		} catch (e) {
			try {
				appendFileSync(join(majordomeDir(), "errors.log"), `${new Date().toISOString()} ${id} append: ${(e as Error)?.stack ?? e}\n`);
			} catch { /* ignore */ }
			continue;
		}
		st.blocks.push(block);
		closed++;
	}
	// docs cursor: advance on docs touches; nudge when implementation drifts
	try {
		const touched = scanDocsTouched(readFileSync(st.sessionFile, "utf8"));
		for (const doc of touched) st.docsCursor[doc] = new Date().toISOString();
		if (touched.length || closed) {
			saveMeta({ dims: st.vocab, docsCursor: st.docsCursor });
			const n = docsNudge(st.blocks, st.sessionFile, st.docsCursor);
			if (n && st.blocks.filter((b) => b.sessionFile === st.sessionFile && b.intent === "implementation").length > st.lastNudgeCount) {
				st.docsNudge = n;
				st.lastNudgeCount = st.blocks.filter((b) => b.sessionFile === st.sessionFile && b.intent === "implementation").length;
			} else if (!n) st.docsNudge = null;
		}
	} catch { /* docs nudge never breaks indexing */ }
	if (closed) status();
	return closed;
}

export default function majordome(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		st.uiCtx = ctx as unknown as St["uiCtx"];
		try {
			st.sessionFile = (ctx as any)?.sessionManager?.sessionFile ?? null;
		} catch {
			st.sessionFile = null;
		}
		st.blocks = loadBlocks();
		st.indexedKeys = new Set(st.blocks.map((b) => b.id));
		const meta = loadMeta();
		st.vocab = meta.dims;
		st.docsCursor = meta.docsCursor;
		if (!st.on) st.reason = st.reason || "MAJORDOME_OFF";
		if (!loadKey()) st.reason = "no TypeLLM key (npx tsx ext/judges.ts setup; TYPELLM_API_KEY env works too)";

		// wire Jev through pi's classifier registry when available (seam default)
		const reg = (ctx as any)?.modelRegistry;
		// wire the agent's own chat model as string-extraction fallback
		// (no TypeLLM key? gists still happen — on the user's tokens)
		if (reg?.complete) {
			const chatModel = (ctx as any)?.model ?? null;
			if (chatModel) {
				setStreamFn(async (prompt: string) => {
					const res = await reg.complete(chatModel, {
						systemPrompt: "You are a terse session archivist. Follow the output format exactly.",
						messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
					});
					return textof((res as any)?.content);
				});
			}
		}
		if (reg && typeof reg.getAvailableOfType === "function" && typeof reg.classify === "function") {
			try {
				const models = (await reg.getAvailableOfType("classifier")) as any[];
				const jev = models?.find((m) => String(m?.id ?? "").includes("jev")) ?? models?.[0];
				if (jev) {
					setClassifyFn(async (state, questions) => {
						const res = await reg.classify(jev, { state, questions });
						return res ? { model: String(jev.id ?? "jev"), answers: (res as any).answers ?? (res as any) } : null;
					});
				}
			} catch {
				// no registry → dimVector falls back to guarded TypeLLM numbers
			}
		}
		status();
	});

	pi.on("turn_end", async () => {
		if (!st.on) return;
		try {
			await indexSession();
		} catch (e) {
			st.reason = `index error: ${String((e as Error).message ?? e).slice(0, 60)}`;
			try {
				appendFileSync(join(majordomeDir(), "errors.log"), `${new Date().toISOString()} session: ${(e as Error)?.stack ?? e}\n`);
			} catch { /* ignore */ }
		}
	});

	pi.on("context", async (event) => {
		if (!st.on || process.env.MAJORDOME_INJECT === "0") return;
		try {
			const msgs = event.messages as any[];
			const lastUserIdx = msgs.findLastIndex?.((m) => m?.role === "user") ?? -1;
			const lastUser = lastUserIdx >= 0 ? msgs[lastUserIdx] : undefined;
			const query = lastUser ? textof(lastUser.content).trim() : "";
			if (!query || query.startsWith("/") || query.startsWith("<")) return;
			if (!st.sessionFile || !loadKey()) return;

			// one DAG route per user turn (tool loops re-fire context with the same message)
			const fresh = !st.routeCache || st.routeCache.query !== query;
			if (fresh) {
				const turnCount = currentTurnCount();
				const recent = [...msgs.slice(0, lastUserIdx)].reverse().find((m) => m?.role === "assistant");
				const result = await route({
					userMessage: query,
					blocks: st.blocks,
					currentSession: sessionSlug(st.sessionFile),
					currentTurn: turnCount,
					currentSessionFile: st.sessionFile,
					routingIntent: (m) => routingIntent(m, recent ? textof(recent.content) : ""),
					queryDims: (q) => (st.vocab.length ? dimVector(q, st.vocab, "message") : Promise.resolve(null)),
					tokens,
				});
				// strong-hit post-checks (once per query): duplicate-work hint +
				// single-pair contradiction judgment on the winner
				let contraLine: string | null = null;
				if (result?.winner?.gist && result.score >= 0.7) {
					try {
						if (await contradicts(query, result.winner.gist)) {
							contraLine = "[majordome judge] This seems to REVERSE a decision recorded in the recalled block — confirm before acting.";
						}
					} catch { /* fail open */ }
				}
				st.routeCache = { query, result, contraLine };
			}
			const r = st.routeCache.result;
			// judge line: ambiguity verdict surfaces to the AGENT even when memory
			// is suppressed — the agent asks, majordome never talks to the user.
			// Debounced: skip when the agent's last message already ends in a
			// question (the user is probably answering it — no ping-pong).
			const recentAssistant = [...msgs.slice(0, lastUserIdx)].reverse().find((m) => m?.role === "assistant");
			const judge = st.judgeMode !== "off" && shouldJudgeLine(r, recentAssistant ? textof(recentAssistant.content) : "")
				? judgeLine(r!.clarifyWhy, st.judgeMode === "strict" ? "strict" : "soft")
				: null;
			// measured noise gate (bench/results/live): true positive 0.707, all
			// noise ≤ 0.63 — suppress weak dims matches and empty lex matches
			const minScore = Number(process.env.MAJORDOME_MIN_SCORE ?? 0.6);
			const suppressed = !r?.winner?.gist
				|| (r.arm === "dims" && r.score < minScore)
				|| (r.arm === "lex" && r.score === 0);
			if (suppressed) {
				if (fresh) appendDecision({
					ts: new Date().toISOString(), query, intent: r?.intent ?? "continuation",
					arm: r?.arm ?? "-", winner: r?.winner ? shortId(r.winner) : null,
					score: r?.winner ? Math.round(r.score * 100) / 100 : null, injected: false,
				});
				if (st.routeCache.contraLine) appendTail(lastUser, st.routeCache.contraLine);
				if (judge) appendTail(lastUser, judge);
				emitDocsNudge(lastUser);
				return;
			}
			// tail injection: request-local mutation of the final user message —
			// pi restores canonical state afterward; the tail is cache-free anyway
			const winner = r.winner;
			// resume hint only when resuming actually applies: an incident/redo
			// situation — a how-to-use question on existing work gets no hint
			const resume = r.intent === "incident_specific" && r.score >= 0.7;
			appendTail(lastUser, injectionText(winner, r.terms, resume));
			if (st.routeCache.contraLine) appendTail(lastUser, st.routeCache.contraLine);
			if (judge) appendTail(lastUser, judge);
			emitDocsNudge(lastUser);
			return;
			st.injects++;
			if (fresh) appendDecision({
				ts: new Date().toISOString(), query, intent: r.intent, arm: r.arm,
				winner: shortId(winner), score: Math.round(r.score * 1000) / 1000, injected: true,
			});
			status();
		} catch {
			// routing must never break a request
		}
	});

	pi.on("session_shutdown", () => {
		resetClassifyFn();
	});

	pi.registerCommand("majordome", {
		description: "Topic memory dashboard (bare) · list · show · forget · export · reindex · stats · log · on/off",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0];
			const a = parts[1];
			const b = parts.slice(2).join(" ");
			const notify = (m: string) => ctx.ui.notify(m, "info");
			st.blocks = loadBlocks();

			if (!cmd) {
				const byTag = new Map<string, number>();
				for (const bl of st.blocks) {
					const t = shortTag(bl.session);
					byTag.set(t, (byTag.get(t) ?? 0) + 1);
				}
				const decisions = lastDecisions(5);
				const lines = [
					"╭─ pi-majordome · topic memory",
					`│ state    ${st.on ? `on · judge ${st.judgeMode}` : `off (${st.reason})`} · judges ${hasJev() ? "jev+typellm" : loadKey() ? "typellm" : "none (recall off)"} · injected this session: ${st.injects}`,
					`│ index    ${st.blocks.length} blocks · ${byTag.size} projects · ${st.vocab.length} dims · ~/.pi/majordome/`,
					`│ projects ${[...byTag].map(([t, n]) => `${t} (${n})`).join(" · ") || "(empty — blocks close as topics move)"}`,
					"├─ routing log (latest first)",
					...(decisions.length
						? decisions.reverse().map((d) => {
							const mark = d.injected ? "✓" : d.winner ? "✗" : "—";
							const w = d.winner ? `${d.winner} ${d.score ?? ""}` : d.intent;
							return `│ ${mark} ${d.ts.slice(11, 16)} "${d.query.slice(0, 42)}" → ${w}`;
						})
						: ["│ (no routing decisions yet)"]),
					"├─ commands",
					"│ /majordome list · show <id> · forget <id|tag|all>",
					"│ /majordome export <id|tag|all> [dir] · reindex [all] · on · off",
					"│ ids are short: code-parser:1 (full ids also accepted)",
					"╰─",
				];
				notify(lines.join("\n"));
				return;
			}
			if (cmd === "list") {
				const sel = a ? st.blocks.filter((x) => shortTag(x.session).toLowerCase().includes(a.toLowerCase())) : st.blocks;
				if (!sel.length) return notify(a ? `no blocks matching "${a}"` : "no blocks indexed yet");
				const rows = sel.map((x) => ({
					id: shortId(x),
					turns: `${x.firstTurn}–${x.lastTurn}`,
					intent: x.intent ?? "?",
					gist: x.gist ?? "(no gist — /majordome reindex to backfill)",
				}));
				const w = [Math.max(...rows.map((r) => r.id.length)), 9, 14, 60];
				notify(
					["ID".padEnd(w[0]) + "  TURNS     INTENT         GIST", ...rows.map((r) => pad(r.id, w[0]) + "  " + pad(r.turns, w[1]) + " " + pad(r.intent, w[2]) + " " + r.gist)].join("\n"),
				);
				return;
			}
			if (cmd === "show") {
				const blk = a ? resolveId(a) : undefined;
				if (!blk) return notify(`no block ${a ?? "(id? — try /majordome list)"}`);
				const dims = Object.entries(blk.dims).filter(([, v]) => v > 0);
				notify([
					`block   ${shortId(blk)}`,
					`file    ${blk.sessionFile.split("/").slice(-2).join("/")}`,
					`turns   ${blk.firstTurn}–${blk.lastTurn} · closed ${blk.closedAt.slice(0, 16).replace("T", " ")}`,
					`intent  ${blk.intent ?? "?"}`,
					`gist    ${blk.gist ?? "(none)"}`,
					`first   "${blk.head}"`,
					`dims    ${dims.length ? dims.map(([d, v]) => `${d}=${v}`).join(" · ") : "(none)"}`,
					`recall  /majordome export ${shortId(blk)} for a markdown ADR`,
				].join("\n"));
				return;
			}
			if (cmd === "forget") {
				if (a === "all") {
					const n = st.blocks.length;
					rewriteBlocks([]);
					st.blocks = [];
					st.indexedKeys = new Set();
					notify(`forgot everything (${n} blocks)`);
				} else {
					const one = a ? resolveId(a) : undefined;
					const keep = st.blocks.filter((x) => {
						if (one) return x.id !== one.id;
						if (a) return !shortTag(x.session).toLowerCase().includes(a.toLowerCase());
						return true;
					});
					const n = st.blocks.length - keep.length;
					rewriteBlocks(keep);
					st.blocks = keep;
					st.indexedKeys = new Set(keep.map((x) => x.id));
					notify(n ? `forgot ${n} block(s); session JSONLs untouched` : `nothing matched "${a}"`);
				}
				status();
				return;
			}
			if (cmd === "docs") {
				const kinds = listKinds();
				if (!a || a === "kinds") {
					notify([
						"/majordome docs <kind> [tag|all] [show]",
						`kinds: ${kinds.join(" · ")}`,
						"  readme/changelog: grounded digest since that doc's cursor, sent to the agent to write it",
						"  custom: drop a template in ~/.pi/majordome/templates/<name>.md — instruction text with a {{digest}} placeholder (HTML explanation, release email, …)",
						"  add 'show' to preview without triggering the agent",
					].join("\n"));
					return;
				}
				if (a === "adr") {
					const targets = !b || b === "all" ? st.blocks : st.blocks.filter((x) => x === resolveId(b) || shortTag(x.session).toLowerCase().includes(b.toLowerCase()));
					if (!targets.length) return notify("nothing to export");
					const dir = join(majordomeDir(), "exports");
					mkdirSync(dir, { recursive: true });
					for (const x of targets) {
						const dims = Object.entries(x.dims).filter(([, v]) => v > 0);
						const md = ["---", `id: ${x.id}`, `project: ${shortTag(x.session)}`, `turns: ${x.firstTurn}-${x.lastTurn}`, `intent: ${x.intent ?? ""}`, `closed_at: ${x.closedAt}`, dims.length ? `dims: ${dims.map(([d, v]) => `${d}=${v}`).join(", ")}` : "dims: []", "---", "", `# ${x.gist ?? x.head}`, "", x.gist ?? "(gist pending — run /majordome reindex)", "", `First ask: "${x.head}"`, "", `Full transcript: \`${x.sessionFile}\` (turns ${x.firstTurn}–${x.lastTurn})`, ""].join("\n");
						writeFileSync(join(dir, x.id.replace(/[^a-z0-9_-]+/gi, "_") + ".md"), md);
					}
					notify(`exported ${targets.length} ADR(s) → ${dir}`);
					return;
				}
				const kind = a;
				const scopeArg = b && !["show"].includes(b) ? b : undefined;
				const showOnly = b === "show" || parts[3] === "show";
				const meta = loadMeta();
				const spec = kind === "readme" || kind === "changelog" ? { since: meta.docsCursor[kind === "readme" ? "README" : "CHANGELOG"] ?? "" } : {};
				const slug = st.sessionFile ? sessionSlug(st.sessionFile) : undefined;
				const scoped = filterBlocks(st.blocks, {
					tag: scopeArg === "all" ? undefined : scopeArg,
					slug: scopeArg ? undefined : slug,
					all: scopeArg === "all",
					since: (spec as any).since,
				});
				const composed = composeKind(kind, scoped);
				if (!composed) return notify(`unknown kind "${kind}" — kinds: ${kinds.join(" · ")}`);
				const dir = join(majordomeDir(), "exports");
				mkdirSync(dir, { recursive: true });
				const outFile = join(dir, `${kind}-${new Date().toISOString().slice(0, 10)}.md`);
				writeFileSync(outFile, `# majordome docs digest — ${kind}\n\n${composed.digest}\n`);
				if (showOnly) return notify(`digest (${scoped.length} blocks) → ${outFile}\n\n${composed.digest}`);
				// trigger the agent: instruction + digest as a message
				const msg = composed.instruction;
				const send = (pi as any).sendUserMessage ?? (pi as any).sendMessage;
				if (typeof send !== "function") return notify(`digest saved → ${outFile}\n(could not send to agent — hand it over manually)\n\n${msg}`);
				try {
					await send(msg);
					notify(`digest (${scoped.length} blocks) sent to the agent — it will write the ${kind} update. saved → ${outFile}`);
				} catch (e) {
					notify(`digest saved → ${outFile}\n(send failed: ${String((e as Error).message ?? e).slice(0, 60)})\n\n${msg}`);
				}
				return;
			}
			if (cmd === "export") {
				const targets = !a || a === "all"
					? st.blocks
					: st.blocks.filter((x) => x === resolveId(a) || shortTag(x.session).toLowerCase().includes(a.toLowerCase()));
				if (!targets.length) return notify("nothing to export");
				const dir = b || join(majordomeDir(), "exports");
				mkdirSync(dir, { recursive: true });
				for (const x of targets) {
					const dims = Object.entries(x.dims).filter(([, v]) => v > 0);
					const md = [
						"---",
						`id: ${x.id}`,
						`project: ${shortTag(x.session)}`,
						`turns: ${x.firstTurn}-${x.lastTurn}`,
						`intent: ${x.intent ?? ""}`,
						`closed_at: ${x.closedAt}`,
						dims.length ? `dims: ${dims.map(([d, v]) => `${d}=${v}`).join(", ")}` : "dims: []",
						"---",
						"",
						`# ${x.gist ?? x.head}`,
						"",
						x.gist ?? "(gist pending — run /majordome reindex)",
						"",
						`First ask: "${x.head}"`,
						"",
						`Full transcript: \`${x.sessionFile}\` (turns ${x.firstTurn}–${x.lastTurn})`,
						"",
					].join("\n");
					writeFileSync(join(dir, x.id.replace(/[^a-z0-9_-]+/gi, "_") + ".md"), md);
				}
				notify(`exported ${targets.length} block(s) → ${dir}`);
				return;
			}
			if (cmd === "reindex") {
				if (a === "all") {
					const dir = join(homedir(), ".pi", "agent", "sessions");
					const files: string[] = [];
					try {
						const { readdirSync } = await import("node:fs");
						for (const d of readdirSync(dir)) {
							const sub = join(dir, d);
							try {
								for (const f of readdirSync(sub)) if (f.endsWith(".jsonl")) files.push(join(sub, f));
							} catch { /* not a dir */ }
						}
					} catch { /* no sessions dir */ }
					rewriteBlocks([]);
					st.blocks = [];
					st.indexedKeys = new Set();
					let total = 0;
					for (const f of files) {
						const prev = st.sessionFile;
						st.sessionFile = f;
						try { total += await indexSession(); } catch { /* skip */ }
						st.sessionFile = prev;
					}
					notify(`reindexed all: ${total} blocks from ${files.length} sessions`);
					return;
				}
				if (!st.sessionFile) return notify("no session file");
				rewriteBlocks(loadBlocks().filter((x) => x.sessionFile !== st.sessionFile));
				st.blocks = loadBlocks();
				st.indexedKeys = new Set(st.blocks.map((x) => x.id));
				const n = await indexSession();
				notify(`reindexed current session: ${n} block(s) closed (judges: ${loadKey() ? "live" : "absent — gistless"})`);
				status();
				return;
			}
			if (cmd === "stats") {
				const all = lastDecisions(100000).reverse(); // oldest → newest
				if (!all.length) return notify("no routing decisions logged yet");
				const inj = all.filter((d) => d.injected);
				const sup = all.filter((d) => !d.injected && d.winner);
				const none = all.filter((d) => !d.injected && !d.winner);
				const cont = none.filter((d) => d.intent === "continuation");
				const avg = (arr: typeof all) => (arr.length ? Math.round((arr.reduce((s2, d) => s2 + (d.score ?? 0), 0) / arr.length) * 100) / 100 : 0);
				const arms = new Map<string, number>();
				for (const d of inj) arms.set(d.arm, (arms.get(d.arm) ?? 0) + 1);
				notify([
					"╭─ /majordome stats (decision log)",
					`│ turns seen      ${all.length}`,
					`│ no retrieval    ${none.length}  (continuation gate: ${cont.length})`,
					`│ injected        ${inj.length}  (avg score ${avg(inj)})`,
					`│ suppressed      ${sup.length}  (avg score ${avg(sup)} — gate rejects below it)`,
					`│ arms (injected) ${[...arms].map(([a2, n]) => `${a2} ${n}`).join(" · ") || "-"}`,
					"├─ reading the gate",
					`│ recall precision proxy: injected avg (${avg(inj)}) vs suppressed avg (${avg(sup)})`,
					`│ gate keeps injecting when the gap stays wide; if it narrows, raise MAJORDOME_MIN_SCORE`,
					"╰─",
				].join("\n"));
				return;
			}
			if (cmd === "log") {
				const n = Math.min(Number(a) || 15, 100);
				const rows = lastDecisions(100000).reverse().slice(0, n);
				if (!rows.length) return notify("no routing decisions logged yet");
				const lines = rows.map((d) => {
					const mark = d.injected ? "✓" : d.winner ? "✗" : "—";
					return `${mark} ${d.ts.slice(5, 16).replace("T", " ")} ${pad(d.arm, 5)} ${pad(d.winner ?? d.intent, 22)} ${pad(d.score != null ? String(d.score) : "", 5)} ${d.query.slice(0, 44)}`;
				});
				notify(["✓ injected  ✗ suppressed  — no retrieval", ...lines].join("\n"));
				return;
			}
			if (cmd === "judge") {
				if (a !== "off" && a !== "soft" && a !== "strict") return notify(`judge mode: ${st.judgeMode} (off | soft | strict — soft informs the agent, strict orders clarify-first)`);
				st.judgeMode = a;
				notify(`judge mode: ${st.judgeMode}`);
				return;
			}
			if (cmd === "on" || cmd === "off") {
				st.on = cmd === "on";
				if (st.on) st.reason = "";
				else st.reason = "manual off";
				st.routeCache = null;
				status();
				notify(`majordome ${st.on ? "on" : "off"}`);
				return;
			}
			notify(`unknown subcommand "${cmd}" — bare /majordome shows the dashboard`);
		},
	});
}
