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
 * /majordome: governance surface (dashboard/list/show/forget/export/reindex/on/off).
 *
 * Fail-open everywhere: no key, no classifier, judge error → skip that step,
 * log the reason, never throw into pi. MAJORDOME_OFF=1 disables; the index
 * is plain JSONL under ~/.pi/majordome/ — inspectable, purgeable, exportable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blockCores, detectBoundaries, parseSession, sessionSlug, textof, tokens } from "./ext/core.ts";
import { blockMeta, dimVector, induceDims, loadKey, resetClassifyFn, routingIntent, setClassifyFn, hasJev } from "./ext/judges.ts";
import { injectionText, route } from "./ext/router.ts";
import { appendBlock, appendDecision, lastDecisions, loadBlocks, loadVocab, majordomeDir, rewriteBlocks, saveVocab, type Block } from "./ext/store.ts";

interface St {
	on: boolean;
	reason: string;
	sessionFile: string | null;
	blocks: Block[];
	vocab: string[];
	indexedKeys: Set<string>;
	routeCache: { query: string; result: Awaited<ReturnType<typeof route>> } | null;
	uiCtx: { hasUI: boolean; ui: { setStatus(k: string, v: string): void } } | null;
	injects: number;
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
};

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
				saveVocab(st.vocab);
			}
		}

		const meta = await blockMeta(core.text);
		const vec = st.vocab.length ? await dimVector(core.text, st.vocab, "segment") : null;
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
		appendBlock(block);
		st.blocks.push(block);
		closed++;
	}
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
		st.vocab = loadVocab();
		if (!st.on) st.reason = st.reason || "MAJORDOME_OFF";
		if (!loadKey()) st.reason = "no TypeLLM key (npx tsx ext/judges.ts writes one; TYPELLM_API_KEY env works too)";

		// wire Jev through pi's classifier registry when available (seam default)
		const reg = (ctx as any)?.modelRegistry;
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
			if (!st.routeCache || st.routeCache.query !== query) {
				const turnCount = currentTurnCount();
				const recent = [...msgs.slice(0, lastUserIdx)].reverse().find((m) => m?.role === "assistant");
				const result = await route({
					userMessage: query,
					blocks: st.blocks,
					currentSession: sessionSlug(st.sessionFile),
					currentTurn: turnCount,
					routingIntent: (m) => routingIntent(m, recent ? textof(recent.content) : ""),
					queryDims: (q) => (st.vocab.length ? dimVector(q, st.vocab, "message") : Promise.resolve(null)),
					tokens,
				});
				st.routeCache = { query, result };
			}
			const r = st.routeCache.result;
			// measured noise gate (bench/results/live): true positive 0.707, all
			// noise ≤ 0.58 — suppress weak dims matches and empty lex matches
			const suppressed = !r?.winner?.gist
				|| (r.arm === "dims" && r.score < 0.6)
				|| (r.arm === "lex" && r.score === 0);
			if (suppressed) {
				appendDecision({
					ts: new Date().toISOString(), query, intent: r?.intent ?? "continuation",
					arm: r?.arm ?? "-", winner: null, score: null, injected: false,
				});
				return;
			}
			// tail injection: request-local mutation of the final user message —
			// pi restores canonical state afterward; the tail is cache-free anyway
			lastUser.content = `${textof(lastUser.content)}\n\n${injectionText(r.winner)}`;
			st.injects++;
			appendDecision({
				ts: new Date().toISOString(), query, intent: r.intent, arm: r.arm,
				winner: r.winner.id, score: Math.round(r.score * 1000) / 1000, injected: true,
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
		description: "Topic memory: dashboard, list, show, forget, export, reindex, on/off",
		handler: async (args, ctx) => {
			const [cmd, a, b] = (args ?? "").trim().split(/\s+/);
			const notify = (m: string) => ctx.ui.notify(m, "info");
			st.blocks = loadBlocks();

			if (!cmd) {
				const bySess = new Map<string, number>();
				for (const bl of st.blocks) bySess.set(bl.session, (bySess.get(bl.session) ?? 0) + 1);
				const lines = [
					`pi-majordome — topic memory  [${st.on ? "on" : `off (${st.reason})`}]`,
					`index: ${st.blocks.length} blocks · ${bySess.size} sessions · ${st.vocab.length} dims · judges: ${hasJev() ? "jev+typellm" : loadKey() ? "typellm" : "none"}`,
					...[...bySess].map(([s, n]) => `  ${s}  ${n}b`),
					`routing log (last 3):`,
					...lastDecisions(3).map((d) => `  ${d.ts.slice(11, 16)} "${d.query.slice(0, 40)}" ${d.intent} → ${d.arm} ${d.winner ?? "-"} ${d.score ?? ""}${d.injected ? " ✓" : ""}`),
					`/majordome list · show <id> · forget <id|session|all> · export <id> [path] · reindex · on · off`,
				];
				notify(lines.join("\n"));
				return;
			}
			if (cmd === "list") {
				const sel = a ? st.blocks.filter((x) => x.session.includes(a)) : st.blocks;
				notify(sel.length
					? sel.map((x) => `${x.id}\n  turns ${x.firstTurn}–${x.lastTurn} · ${x.intent ?? "?"} · ${x.gist ?? "(no gist — reindex to backfill)"}`).join("\n")
					: "no blocks indexed yet");
				return;
			}
			if (cmd === "show") {
				const blk = st.blocks.find((x) => x.id === a || x.id.endsWith(`:${a}`));
				if (!blk) return notify(`no block ${a ?? "(id?)"}`);
				notify(JSON.stringify(blk, null, 1));
				return;
			}
			if (cmd === "forget") {
				if (a === "all") {
					rewriteBlocks([]);
					notify(`forgot everything (${st.blocks.length} blocks)`);
				} else {
					const keep = st.blocks.filter((x) => !(x.id === a || x.session === a));
					rewriteBlocks(keep);
					notify(`forgot ${st.blocks.length - keep.length} block(s); session JSONLs untouched`);
				}
				st.blocks = loadBlocks();
				st.indexedKeys = new Set(st.blocks.map((x) => x.id));
				status();
				return;
			}
			if (cmd === "export") {
				const targets = a === "all" || !a ? st.blocks : st.blocks.filter((x) => x.id === a || x.session.includes(a));
				if (!targets.length) return notify("nothing to export");
				const dir = b ?? join(majordomeDir(), "exports");
				mkdirSync(dir, { recursive: true });
				for (const x of targets) {
					const md = [
						"---",
						`id: ${x.id}`,
						`session: ${x.session}`,
						`turns: ${x.firstTurn}-${x.lastTurn}`,
						`intent: ${x.intent ?? ""}`,
						`closed_at: ${x.closedAt}`,
						`dims: ${JSON.stringify(x.dims)}`,
						"---",
						"",
						`# ${x.gist ?? x.head}`,
						"",
						x.gist ? x.gist : "(gist pending — run /majordome reindex)",
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
					let files: string[] = [];
					try {
						const { readdirSync, statSync } = await import("node:fs");
						for (const d of readdirSync(dir)) {
							const sub = join(dir, d);
							try {
								for (const f of readdirSync(sub)) if (f.endsWith(".jsonl")) files.push(join(sub, f));
							} catch { /* not a dir */ }
							void statSync;
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
				rewriteBlocks(loadBlocks().filter((x) => x.session !== sessionSlug(st.sessionFile!)));
				st.blocks = loadBlocks();
				st.indexedKeys = new Set(st.blocks.map((x) => x.id));
				const n = await indexSession();
				notify(`reindexed current session: ${n} block(s) closed (judges: ${loadKey() ? "live" : "absent — gistless"})`);
				status();
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
			notify(`unknown subcommand "${cmd}" — try bare /majordome`);
		},
	});
}
