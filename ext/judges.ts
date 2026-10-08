/**
 * pi-majordome judges — the two-judge seam.
 *
 *   TypeLLM (strings + DAG): block-close intent/gist, dim induction, query
 *   rewrite, routing intent DAG. Key chain mirrors pi-codemap:
 *     1. ~/.config/pi-majordome/typellm.key   2. TYPELLM_API_KEY env
 *
 *   Numbers (block/query dim vectors): Jev via pi's classifier registry when
 *   wired (seam default, calibration-grade); guarded TypeLLM number fallback
 *   otherwise — the A/B-proven config flip, automatic.
 *
 * Degenerate guard (both judges): null dims OR all-0/all-1 vectors are
 * failures → retried (the slice-3 flake mode; silent zero-fill poisons
 * retrieval). Fail-open: callers get null and skip, never throw into pi.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { trail } from "./trail.ts";
import { majordomeDir } from "./store.ts";
import { loadUserPrefs, prefLines } from "./userprefs.ts";

export const HOSTED_URL = "https://api.typellm.ai";
const TIMEOUT_MS = 30_000;

export function defaultKeyFile(): string {
	return process.env.MAJORDOME_KEY_FILE?.trim() || join(homedir(), ".config", "pi-majordome", "typellm.key");
}

export function loadKey(): string | null {
	if (existsSync(defaultKeyFile())) {
		const k = readFileSync(defaultKeyFile(), "utf8").trim();
		if (k) return k;
	}
	return process.env.TYPELLM_API_KEY?.trim() || null;
}

// ── TypeLLM transport ───────────────────────────────────────────────────────

/** Exported for bench seams that must ride the exact judge transport
 * (shapebench live tier: draft/grade shaped-vs-default answers) and for
 * panel.ts (second-pass + cost telemetry). `usage` is
 * the transport's token report verbatim (shape handled by tokensOf) when the
 * response exposes one — cost telemetry only, verdict semantics unchanged. */
export async function generate(
	context: string,
	questions: Record<string, unknown>,
	recent?: string,
): Promise<{ result: Record<string, unknown>; usage?: unknown } | null> {
	const key = loadKey();
	if (!key) return null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const resp = await fetch(`${HOSTED_URL}/v1/generate`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ context, questions }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			const json: any = await resp.json().catch(() => null);
			if (!resp.ok) throw new Error(json?.error?.message ?? `HTTP ${resp.status}`);
			if (json?.result && typeof json.result === "object") {
				return json.usage !== undefined ? { result: json.result, usage: json.usage } : { result: json.result };
			}
		} catch {
			// retry once, then fail open
		}
	}
	return null;
}

// ── dims guard (port of _parse_dims, both judges) ───────────────────────────

/** null on missing dims OR degenerate all-0/all-1 vectors (valid floats, zero
 * discrimination — the observed flake; retried clean 4/4 in the thinking A/B). */
export function parseDims(vals: (number | boolean | null | undefined)[], n: number): Map<string, number> | null {
	if (vals.length !== n || vals.some((v) => v === null || v === undefined)) return null;
	const nums = vals.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : Number(v)));
	if (nums.some((v) => !Number.isFinite(v))) return null;
	if (nums.every((v) => v === 0) || nums.every((v) => v === 1)) return null;
	return new Map();
}

// ── estTokens (judge-cost telemetry) ──────────────────────────────────────

/** Token estimate from a judge transport response; null when none is
 * reported — the trail line then records the call without an estimate (old
 * lines and Jev/agent paths count calls only). Shapes handled: bare number,
 * OpenAI-style {total_tokens}, and part-summed {input_tokens, output_tokens,
 * thinking_tokens, prompt_tokens, completion_tokens} (the live TypeLLM
 * transport reports input+thinking with no total). */
export function tokensOf(r: { usage?: unknown } | null | undefined): number | null {
	const u: any = r?.usage;
	if (u == null) return null;
	if (typeof u === "number") return u > 0 ? Math.round(u) : null;
	if (typeof u.total_tokens === "number") return u.total_tokens > 0 ? Math.round(u.total_tokens) : null;
	let n = 0;
	let seen = false;
	for (const k of ["input_tokens", "prompt_tokens", "output_tokens", "completion_tokens", "thinking_tokens"]) {
		if (typeof u[k] === "number" && u[k] > 0) {
			n += u[k];
			seen = true;
		}
	}
	return seen && n > 0 ? Math.round(n) : null;
}

/** Spread-ready trail field: `{ estTokens: n }` when the transport reported
 * usage, `{}` otherwise (keeps trail lines honest and schema-stable). */
function tkf(r: { usage?: unknown } | null | undefined): Record<string, unknown> {
	const n = tokensOf(r);
	return n ? { estTokens: n } : {};
}

// ── block-close meta (TypeLLM strings) ──────────────────────────────────────

const INTENTS = new Set(["implementation", "investigation", "evaluation", "documentation", "discussion"]);

export interface BlockMeta {
	intent: string | null;
	gist: string | null;
	lesson: boolean; // fail-open false: only a confident yes classifies a lesson
}

/** Lesson verdict parser (fail-open false): yes/true only; missing, malformed
 * or junk reads "not a lesson" — a lesson class that grew by accident would
 * poison recall boosts, the one-pager section and consolidation pairing. */
function lessonOf(v: unknown): boolean {
	if (v === true) return true;
	return typeof v === "string" && /^(yes|true)$/i.test(v.trim());
}

/** intent + gist + lesson classification, ONE batched call. The lesson
 * question rides the existing block-close seam ("does this block record a
 * mistake/error/lesson worth remembering as guidance?") — no new call, no
 * new judge. Null on any failure — block indexes without meta and the next
 * reindex can backfill; lesson rides the trail either way (fail-open false). */
export async function blockMeta(text: string): Promise<BlockMeta | null> {
	if (!loadKey() && streamFn) {
		// divert to the agent's own model: extraction without TypeLLM
		try {
			const out = await streamFn(
				`You will be given a segment of a coding-agent session. Reply with EXACTLY three lines and nothing else:\nintent: <one of implementation, investigation, evaluation, documentation, discussion>\ngist: <one sentence: what was done or decided>\nlesson: <yes|no — does this block record a mistake, error or lesson worth remembering as guidance (a gotcha, a fix worth remembering, a don't-do-that learning)? Pure feature work with no lesson = no>\n\nSegment:\n${text.slice(0, 6000)}`,
			);
			if (out) {
				const intent = out.match(/intent:\s*([a-z]+)/i)?.[1]?.toLowerCase() ?? null;
				const gist = out.match(/gist:\s*(.+)/i)?.[1]?.trim();
				if (gist) {
					const lesson = lessonOf(out.match(/lesson:\s*(.+)/i)?.[1]);
					trail("blockMeta", { judge: "agent", ok: true, intent: intent ?? null, lesson });
					return { intent: intent && INTENTS.has(intent) ? intent : null, gist, lesson };
				}
			}
			// gap-rule: the agent-model call happened but produced no gist — a
			// fail-open judge call is still a judge call (cost must see it)
			trail("blockMeta", { judge: "agent", ok: false, lesson: false });
		} catch {
			trail("blockMeta", { judge: "agent", ok: false, lesson: false });
		}
		return null;
	}
	const r = await generate(text.slice(0, 6000), {
		intent: {
			type: "string",
			enum: ["implementation", "investigation", "evaluation", "documentation", "discussion"],
			instructions: "Primary intent of this segment.",
		},
		gist: { type: "string", instructions: "One sentence: what was done or decided." },
		lesson: {
			type: "string",
			enum: ["yes", "no"],
			instructions:
				"Does this block record a mistake, error or lesson worth remembering as guidance — a gotcha, a fix worth remembering, a don't-do-that learning? Pure feature work, progress notes and plain decisions = no.",
		},
	});
	const res = r?.result ?? {};
	const ok = typeof res.gist === "string" && !!res.gist.trim();
	const lesson = lessonOf(res.lesson);
	trail("blockMeta", { judge: "typellm", ok, intent: typeof res.intent === "string" ? res.intent : null, lesson, ...tkf(r) });
	if (!ok) return null;
	return { intent: typeof res.intent === "string" ? res.intent : null, gist: res.gist.trim(), lesson };
}

/** 4-6 induced dim names for a segment (slice-three induction). */
export async function induceDims(text: string): Promise<string[]> {
	const r = await generate(text.slice(0, 3000), {
		dims: {
			type: "string",
			instructions:
				"Name 4-6 short snake_case feature dimensions that discriminate what this conversation segment is about AND what was done in it. Output comma-separated names only, no explanations.",
		},
	});
	const v = r?.result?.dims;
	if (typeof v !== "string") {
		trail("induceDims", { judge: "typellm", ok: false, ...tkf(r) });
		return [];
	}
	const dims = v
		.split(",")
		.map((n) => n.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""))
		.filter((n) => n.length >= 3)
		.slice(0, 6);
	trail("induceDims", { judge: "typellm", ok: dims.length > 0, n: dims.length, ...tkf(r) });
	return dims;
}

/** Recall query → terse content terms (strip meta framing; the all-zero attack). */
export async function rewriteQuery(text: string): Promise<string | null> {
	const r = await generate(text, {
		search_terms: {
			type: "string",
			instructions:
				"Rewrite this user query as 5-12 terse search keywords describing the topic CONTENT the user wants recalled. Strip meta framing (make a summary of, remind me, tell me about, can you explain) and output only the content terms, comma-separated.",
		},
	});
	const v = r?.result?.search_terms;
	const ok = typeof v === "string" && !!v.trim();
	trail("rewriteQuery", { judge: "typellm", ok, ...tkf(r) });
	return ok ? (v as string).trim() : null;
}

// ── query decomposition (v1, multi-topic asks) ──────────────────────────────

export interface SubQuestion {
	q: string; // the self-contained question
	tag: string; // 1-2 word topic (section label downstream)
}

export interface Decomposition {
	subquestions: SubQuestion[];
	confidence: number; // 0-1 that the split reflects what the user wants
	vague: boolean; // too ambiguous to split reliably
}

const DECOMPOSE_INSTRUCTIONS =
	"Split this user input into at most 3 self-contained sub-questions. For each: q = the self-contained question, tag = 1-2 word topic. " +
	"Order by likelihood \u2014 the FIRST reading is the default (silence proceeds there). " +
	"If consecutive questions continue the SAME topic, keep them together (cohesion). " +
	"Output one sub-question per line as `tag :: question` (3 lines max, no numbering, no commentary).";

/** vague=true only on a confident yes (same fail-open shape as lessonOf). */
function vagueOf(v: unknown): boolean {
	if (v === true) return true;
	if (v && typeof v === "object" && typeof (v as any).noul === "boolean") return (v as any).noul;
	return typeof v === "string" && /^(yes|true)$/i.test(v.trim());
}

/** Lenient sub-question list: array of {q, tag} objects (structured output)
 * OR one sub-question per line as `tag :: question` (string transports; the
 * line form tolerates leading numbering). Junk entries are skipped, never
 * fatal; the cap is 3 — the spec's cohesion bound. */
export function subquestionsOf(v: unknown): SubQuestion[] {
	const cap = (arr: SubQuestion[]): SubQuestion[] => arr.slice(0, 3);
	if (Array.isArray(v)) {
		const out: SubQuestion[] = [];
		for (const e of v) {
			const o = e as Record<string, unknown> | null;
			const q = typeof o?.q === "string" ? o.q.trim() : typeof o?.question === "string" ? (o.question as string).trim() : "";
			if (!q) continue;
			const tag = typeof o?.tag === "string" ? o.tag.trim().slice(0, 24) : "";
			out.push({ q, tag: tag || "topic" });
		}
		return cap(out);
	}
	if (typeof v === "string") {
		const out: SubQuestion[] = [];
		for (const line of v.split("\n")) {
			const t = line.replace(/^\s*\d+[.)]\s*/, "").trim();
			if (!t) continue;
			const m = t.match(/^(.{1,24}?)\s*(?:::|\||—|–|:)\s*(.+)$/);
			if (m && m[2].trim()) out.push({ q: m[2].trim(), tag: m[1].trim().slice(0, 24) || "topic" });
			else out.push({ q: t, tag: "topic" });
		}
		return cap(out);
	}
	return [];
}

/** Verdict → Decomposition; null when no usable sub-questions or confidence
 * (fail-open: callers keep today's single-pipeline behavior — never a guessed
 * split). Exported as the offline fixture seam, same role as parseDims. */
export function settleDecompose(res: Record<string, unknown>, judge: string, usage?: unknown): Decomposition | null {
	const subs = subquestionsOf(res.subquestions);
	const raw = res.confidence;
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
	const conf = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
	if (!subs.length || conf === null) {
		trail("decomposeQuery", { judge, ok: false, ...tkf({ usage }) });
		return null;
	}
	const out: Decomposition = { subquestions: subs, confidence: conf, vague: vagueOf(res.vague) };
	trail("decomposeQuery", { judge, ok: true, n: subs.length, confidence: out.confidence, vague: out.vague, ...tkf({ usage }) });
	return out;
}

/** Split a user message into ≤3 self-contained sub-questions — ONE structured
 * call (subquestions + confidence + vague). TypeLLM primary; classifier seam
 * when no key (stub/fail-open — a classifier that cannot emit lists degrades
 * to a 1-line answer, and callers treat ≤1 sub-question as no decomposition).
 * Null on any failure — callers fail open to today's single-pipeline recall. */
export async function decomposeQuery(text: string): Promise<Decomposition | null> {
	if (loadKey()) {
		const r = await generate(text.slice(0, 1200), {
			subquestions: { type: "string", instructions: DECOMPOSE_INSTRUCTIONS },
			confidence: {
				type: "number",
				instructions: "0-1 confidence that you understood what the user wants well enough to split it reliably. Use the full range; 0.9+ only when the split is unambiguous.",
			},
			vague: {
				type: "string",
				enum: ["yes", "no"],
				instructions: "yes if the input is too ambiguous to split reliably (missing subjects, unclear referents); casually phrased but readable input is no.",
			},
		});
		if (!r?.result) {
			trail("decomposeQuery", { judge: "typellm", ok: false }); // gap-rule: dead transport is still a judge call
			return null;
		}
		return settleDecompose(r.result, "typellm", r.usage);
	}
	if (classifyFn) {
		try {
			const res = await classifyFn(
				{ msg: text.slice(0, 500) },
				{
					subquestions: {
						type: "choice",
						instructions: DECOMPOSE_INSTRUCTIONS,
						criteria: { splittable: "2-3 self-contained sub-questions exist", single: "one topic only — no split" },
					},
					confidence: { type: "noul", instructions: "State field 'msg' is a user chat message. yes if you understood it well enough to split it reliably, no otherwise." },
					vague: { type: "noul", instructions: "Is msg too ambiguous to split reliably (missing subjects, unclear referents)? Answer yes/no." },
				},
			);
			if (!res?.answers) {
				trail("decomposeQuery", { judge: "jev", ok: false }); // gap-rule: unusable answer is still a judge call
				return null;
			}
			return settleDecompose(res.answers, "jev", res.usage);
		} catch {
			trail("decomposeQuery", { judge: "jev", ok: false }); // gap-rule: classifier raised — fail-open call recorded
			return null;
		}
	}
	return null;
}

/** Self-Index key evolution (v2.4): 3-5 terse retrieval phrases that would
 * surface `segment` for `query`. Faithfulness/specificity gated at the call
 * site; fail-open empty. */
export async function keyPhrases(segment: string, query: string): Promise<string[]> {
	const r = await generate(`Query it should answer: ${query.slice(0, 200)}\n\nSegment:\n${segment.slice(0, 2500)}`, {
		phrases: {
			type: "string",
			instructions: "Output 3-5 terse search phrases (comma-separated) that would retrieve this segment for the query. Use content words from the segment (or close synonyms) — never just echo the query framing.",
		},
	});
	const v = r?.result?.phrases;
	const ok = typeof v === "string" && !!v.trim();
	trail("keyPhrases", { judge: "typellm", ok, ...tkf(r) });
	return ok ? (v as string).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5) : [];
}

// ── routing intent DAG (TypeLLM-only depends_on capability) ─────────────────

export interface RoutingIntent {
	intent: "definition_recall" | "incident_specific" | "continuation";
	searchTerms: string;
	needClarification: boolean;
	clarifyWhy: string;
}

export async function routingIntent(userMessage: string, recentAssistant?: string): Promise<RoutingIntent | null> {
	// Jev-only config: intent is a plain choice question (no DAG, no rewrite —
	// the raw query serves as search terms; dims come from Jev noul batteries)
	if (!loadKey() && classifyFn) {
		try {
			const res = await classifyFn(
				{ msg: userMessage.slice(0, 500), recent: (recentAssistant ?? "").slice(-300) },
				{
					intent: {
						type: "choice",
						instructions:
							"Classify the user message in a coding-agent chat. continuation: ONLY a pure proceed-order with no question and no new information (go, ok, continue). definition_recall: asks what something is, how it works, or to recall past work — even casually phrased. incident_specific: refers to a concrete event (a crash, a bug, a run). When unsure between continuation and a recall class, choose the recall class.",
						criteria: {
							definition_recall: "asks what something is / how it works / remind me / summarize past work",
							incident_specific: "refers to a concrete event: a crash, a bug, a specific run, something broken",
							continuation: "pure proceed-order or acknowledgment, no question, no new information",
						},
					},
					need_clarification: {
						type: "noul",
						instructions:
							"State has 'msg' (the new user message) and 'recent' (the assistant's last message). Is msg too vague to act on well — a reference ('the thing', 'it', 'that issue') that NEITHER msg NOR recent resolves, or a missing subject/goal — such that ONE clarifying question would materially change what the agent does? References resolved by recent are NOT vague. Answer yes/no.",
					},
				},
			);
			const a = res?.answers?.intent as string | { choice?: string } | undefined;
			const label = typeof a === "string" ? a : (a as any)?.choice;
			const tk = tkf(res);
			if (!label || label === "continuation") {
				// gap-rule: the judge answered — a continuation verdict routes to no
				// recall but still costs a call; a missing label failed open
				trail("routingIntent", { judge: "jev", ok: !!label, intent: label ?? null, continuation: label === "continuation", ...tk });
				return null;
			}
			const nc = res?.answers?.need_clarification as { noul?: boolean } | boolean | undefined;
			const need = nc === true || (nc as any)?.noul === true;
			trail("routingIntent", { judge: "jev", intent: label, clarify: need, ...tk });
			return {
				intent: label,
				searchTerms: "",
				needClarification: need,
				clarifyWhy: "",
			};
		} catch {
			trail("routingIntent", { judge: "jev", ok: false }); // gap-rule: classifier raised — fail-open call recorded
			return null;
		}
	}
	const context = recentAssistant?.trim()
		? `[recent assistant message]\n${recentAssistant.trim().slice(-400)}\n\n[user message]\n${userMessage}`
		: userMessage;
	const r = await generate(context, {
		intent: {
			type: "string",
			enum: ["definition_recall", "incident_specific", "continuation"],
			instructions:
				"Classify the USER MESSAGE in this coding-agent chat (the recent assistant message, when present, shows what was just happening). " +
				"continuation: ONLY a pure proceed-order or short acknowledgment with no question and no new information (go, ok, continue, yes do it, execute the plan). " +
				"definition_recall: asks what something is, how something works, or asks to summarize/remind/recall past work or decisions — even casually phrased, mid-work, or as a complaint. " +
				"incident_specific: refers to a concrete event (a crash, a bug, a specific run, something broken). " +
				"When unsure between continuation and a recall class, choose the recall class.",
		},
		search_terms: {
			type: "string",
			when: { intent: ["definition_recall", "incident_specific"] },
			instructions: "5-12 terse content keywords for retrieving the relevant past work. Strip meta framing.",
		},
		need_clarification: {
			type: "string",
			enum: ["yes", "no"],
			when: { intent: ["definition_recall", "incident_specific"] },
			instructions:
				"yes if the USER MESSAGE is too vague to act on well — a reference ('the thing', 'it', 'that issue') that neither the user message nor the recent assistant message resolves, or a missing subject/goal — and ONE clarifying question would materially change what the agent does. no if the request is clear enough to proceed, including references the recent assistant message resolves.",
		},
		clarify_why: {
			type: "string",
			when: { need_clarification: "yes" },
			instructions: "The single missing piece, max 12 words.",
		},
	}, recentAssistant);
	const res = r?.result ?? {};
	const tk = tkf(r);
	if (typeof res.intent !== "string") {
		trail("routingIntent", { judge: "typellm", ok: false, ...tk });
		return null;
	}
	trail("routingIntent", {
		judge: "typellm",
		intent: res.intent,
		rewrite: typeof res.search_terms === "string" && !!res.search_terms,
		clarify: res.need_clarification === "yes",
		...tk,
	});
	return {
		intent: res.intent as RoutingIntent["intent"],
		searchTerms: typeof res.search_terms === "string" ? res.search_terms : "",
		needClarification: res.need_clarification === "yes",
		clarifyWhy: typeof res.clarify_why === "string" ? res.clarify_why : "",
	};
}

/** Post-retrieval single-pair check: does the user's message REVERSE a
 * decision recorded in the recalled block? One judge call, only on strong
 * hits (score ≥ 0.7) — fail-open false. */
export async function contradicts(query: string, gist: string): Promise<boolean> {
	if (loadKey()) {
		const r = await generate(
			`User message: ${query.slice(0, 400)}\n\nExisting work summary: ${gist.slice(0, 400)}`,
			{
				contradiction: {
					type: "string",
					enum: ["yes", "no", "unsure"],
					instructions:
						"Does the user message contradict or reverse a decision or outcome in the existing work summary? yes ONLY on a real conflict (opposite choice, reversal) — a new aspect or extension is no.",
				},
			},
		);
		const verdict = r?.result?.contradiction === "yes";
		// ok here means the transport answered at all — a dead call must not read
		// as a confident "no"
		trail("contradicts", { judge: "typellm", ok: !!r?.result, verdict, ...tkf(r) });
		return verdict;
	}
	if (classifyFn) {
		try {
			const res = await classifyFn(
				{ msg: query.slice(0, 300), gist: gist.slice(0, 300) },
				{
					contradiction: {
						type: "noul",
						instructions:
							"Does the user message contradict or reverse a decision or outcome described in the gist (opposite choice, reversal — not merely a new aspect)? Answer yes/no.",
					},
				},
			);
			const a = res?.answers?.contradiction;
			const verdict = a === true || (a as any)?.noul === true;
			trail("contradicts", { judge: "jev", ok: !!res?.answers, verdict, ...tkf(res) });
			return verdict;
		} catch {
			trail("contradicts", { judge: "jev", ok: false }); // gap-rule: classifier raised — fail-open call recorded
			return false;
		}
	}
	return false;
}

// ── docs verdict (magic-docs v2): the deterministic-value posthook ─────────

export type DocsKind = "readme" | "changelog" | "adr";
export interface DocsVerdict {
	docsWorthy: boolean;
	kind: DocsKind | null;
	why: string; // ≤120 chars
}

const DOCS_KINDS: readonly DocsKind[] = ["readme", "changelog", "adr"];

/** docs_worthy answer → true/false, null when malformed (fail-open, not false:
 * a malformed verdict must fall back to the arithmetic rule, not silence it). */
function docsWorthyOf(v: unknown): boolean | null {
	if (v === "yes" || v === true) return true;
	if (v === "no" || v === false) return false;
	if (v && typeof v === "object" && typeof (v as any).noul === "boolean") return (v as any).noul;
	return null;
}

/** Would this turn's implementation work warrant a repo docs pass (README /
 * CHANGELOG / ADR)? A separate small per-turn call: blockMeta is per-block and
 * shared with the init/reindex sweeps, so batching the turn-level verdict
 * there would spam every sweep and couple two concerns. Fail-open null (no
 * judge, error, malformed) → the caller keeps its arithmetic 3-block rule.
 * The verdict lands on the trail either way, never in message text. */
export async function docsVerdict(work: string): Promise<DocsVerdict | null> {
	const settle = (res: Record<string, unknown>, judge: string, usage?: unknown): DocsVerdict | null => {
		const w = docsWorthyOf(res.docs_worthy);
		if (w === null) {
			trail("docsVerdict", { judge, ok: false, ...tkf({ usage }) });
			return null;
		}
		const kRaw = typeof res.kind === "string" ? res.kind : typeof (res.kind as any)?.choice === "string" ? (res.kind as any).choice : "";
		const kind = DOCS_KINDS.includes(kRaw.toLowerCase() as DocsKind) ? (kRaw.toLowerCase() as DocsKind) : null;
		const out: DocsVerdict = { docsWorthy: w, kind: w ? kind : null, why: typeof res.why === "string" ? res.why.slice(0, 120) : "" };
		trail("docsVerdict", { judge, ok: true, docsWorthy: out.docsWorthy, kind: out.kind, why: out.why, ...tkf({ usage }) });
		return out;
	};
	if (loadKey()) {
		const r = await generate(
			`Implementation work completed in this turn of a coding-agent session:\n${work.slice(0, 2000)}`,
			{
				docs_worthy: {
					type: "string",
					enum: ["yes", "no"],
					instructions:
						"Would this work warrant a docs pass in the repo (README: usage/API/behavior changed; CHANGELOG: notable change for release notes; ADR: a decision with tradeoffs)? Local renames, comment/typo fixes, tests-only churn, internal refactors with unchanged behavior = no.",
				},
				kind: {
					type: "string",
					enum: ["readme", "changelog", "adr"],
					instructions: "Best-fit doc: readme (how to use it / API changed), changelog (release-note-worthy change), adr (architecture or decision record).",
				},
				why: { type: "string", instructions: "Reason, max 12 words." },
			},
		);
		if (!r?.result) {
			trail("docsVerdict", { judge: "typellm", ok: false }); // gap-rule: dead transport is still a judge call
			return null;
		}
		return settle(r.result, "typellm", r.usage);
	}
	if (classifyFn) {
		try {
			const res = await classifyFn(
				{ work: work.slice(0, 1200) },
				{
					docs_worthy: {
						type: "noul",
						instructions:
							"State field 'work' summarizes a coding-agent turn's implementation work. Does it warrant a repo docs update (README/CHANGELOG/ADR)? Local renames, typo fixes, tests-only churn = no. Answer yes/no.",
					},
					kind: {
						type: "choice",
						instructions: "If docs-worthy, which doc fits best?",
						criteria: { readme: "usage or API changed", changelog: "notable change, release-note-worthy", adr: "a decision with tradeoffs was recorded" },
					},
				},
			);
			if (!res?.answers) {
				trail("docsVerdict", { judge: "jev", ok: false }); // gap-rule: unusable answer is still a judge call
				return null;
			}
			return settle(res.answers, "jev", res.usage);
		} catch {
			trail("docsVerdict", { judge: "jev", ok: false });
			return null;
		}
	}
	return null;
}

// ── output-shape verdict (the third routing axis) ───────────────────────

export const OUTPUT_SHAPES = ["default", "terse", "diagram-first", "table", "walkthrough", "artifact"] as const;
export type OutputShape = (typeof OUTPUT_SHAPES)[number];

export interface ShapeVerdict {
	shape: OutputShape;
	why: string; // one line, ≤80 chars
	confidence?: number; // v0.6.6 return_probabilities — mechanical <0.6 → default downgrade
}

function shapeOf(v: unknown): OutputShape | null {
	if (typeof v !== "string" && typeof (v as any)?.choice !== "string" && typeof (v as any)?.value !== "string") return null;
	const s = (typeof v === "string" ? v : ((v as any).choice ?? (v as any).value)).trim().toLowerCase();
	return (OUTPUT_SHAPES as readonly string[]).includes(s) ? (s as OutputShape) : null;
}

const SHAPE_INSTRUCTIONS =
	"Pick the OUTPUT SHAPE this user message calls for in a coding-agent chat, given the user's standing preferences. " +
	"default: an ordinary mixed prose/code answer — including continuations (go, ok, continue), direct small tasks, and short factual questions. " +
	"terse: the user explicitly wants it short (just tell me, one line, tl;dr, short, quick) — a few sentences at most. " +
	"diagram-first: RESERVED for genuinely structural content — multi-system architecture, state machines, decision graphs with real fan-in/fan-out. Prose explains sequential logic better (rung 1); when unsure, choose default. If chosen, lead with the graph but keep prose substantial. " +
	"table: compares two or more options or attributes side by side (compare X and Y, pros and cons, which should we pick). " +
	"artifact: a substantial self-contained deliverable the user will keep (design note, plan, doc). 'Walk me through the whole design' or 'the overall design of X' asks for exactly this — a full write-up of the whole thing — even when phrased as 'walk me through'. " +
	"walkthrough: a step-by-step procedure or cause-chain narrative (how do I get from A to B, why did X fail, walk me through a concrete how-to). " +
	"When torn between shapes, choose default.";

/** Exported for selfcheck: the v0.6.6 confidence downgrade is pure. */
export function settleShape(res: Record<string, unknown>, judge: string, usage?: unknown): ShapeVerdict | null {
	const shape = shapeOf(res.shape);
	if (!shape) {
		trail("shapeVerdict", { judge, ok: false, ...tkf({ usage }) }); // fail-open: unparseable is null, never a guessed shape
		return null;
	}
	const whyRaw = typeof res.why === "string" ? res.why : typeof (res.why as any)?.choice === "string" ? (res.why as any).choice : "";
	const conf = typeof (res.shape as any)?.confidence === "number" ? (res.shape as any).confidence : undefined;
	// mechanical rung-1 fallback: low confidence lands on default, never a guessed shape
	const final: OutputShape = conf !== undefined && conf < 0.6 ? "default" : shape;
	const downgraded = final !== shape;
	const out: ShapeVerdict = { shape: final, why: whyRaw.replace(/\s+/g, " ").trim().slice(0, 80), ...(conf !== undefined ? { confidence: conf } : {}) };
	trail("shapeVerdict", { judge, ok: true, shape: out.shape, why: out.why, ...(conf !== undefined ? { confidence: conf } : {}), ...(downgraded ? { downgraded: true } : {}), ...tkf({ usage }) }); // never message text
	return out;
}

/** Preference lines for the shape judgment: user.json (the structured
 * personal tier — answer_shape + preference pairs, via ext/userprefs.ts)
 * first, then the user.md prose rules (MAJORDOME_USER_MD_FILE override,
 * comment/blank lines stripped). Both sources merge, user.json lines first,
 * capped at 12 total. Missing files = no context from that source. Cached
 * per session (process lifetime); resetUserPrefs() exists for benches and
 * re-reads. */
let userPrefsCache: string[] | null = null;
export function resetUserPrefs(): void {
	userPrefsCache = null;
}
export function userPrefLines(): string[] {
	if (userPrefsCache) return userPrefsCache;
	let lines: string[] = [];
	try {
		lines = prefLines(loadUserPrefs()); // user.json: answer_shape + preference pairs
	} catch { /* fail open — preferences must never break the judge */ }
	try {
		const md = process.env.MAJORDOME_USER_MD_FILE?.trim() || join(majordomeDir(), "user.md");
		lines = lines.concat(
			readFileSync(md, "utf8")
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith("#")),
		);
	} catch { /* missing prose file = no context from that source */ }
	userPrefsCache = lines.slice(0, 12);
	return userPrefsCache;
}

/** Pre-turn OUTPUT-SHAPE verdict on the user message (third routing axis:
 * intent decides WHAT to recall, dims/BM25 WHERE from, shape HOW to answer).
 * A separate small call in the docsVerdict pattern, NOT a routingIntent
 * field: routingIntent early-returns null on continuation and malformed
 * intents (both ladder paths), which would silently drop a valid shape
 * answer, and its injected-judge seam threads through route()'s pure
 * retrieval logic and every bench call site. Fail-open null (no judges,
 * error, unparseable) → the caller injects nothing — byte-identical
 * behavior. Suggest-only downstream: the tail hint ADVISES the agent, never
 * invokes tools. The verdict lands on the trail (shape + why), never message
 * text. */
export async function shapeVerdict(userMessage: string, prefLines: string[] = userPrefLines()): Promise<ShapeVerdict | null> {
	const pref = prefLines.length ? `\n\n[user's standing output preferences]\n${prefLines.join("\n").slice(0, 800)}` : "";
	if (loadKey()) {
		const r = await generate(`[user message]\n${userMessage.slice(0, 1500)}${pref}`, {
			shape: { type: "string", enum: [...OUTPUT_SHAPES], instructions: SHAPE_INSTRUCTIONS, return_probabilities: true },
			why: { type: "string", instructions: "One-line reason, max 12 words." },
		});
		if (!r?.result) {
			trail("shapeVerdict", { judge: "typellm", ok: false });
			return null;
		}
		return settleShape(r.result, "typellm", r.usage);
	}
	if (classifyFn) {
		try {
			const res = await classifyFn(
				{ msg: userMessage.slice(0, 500), prefs: prefLines.join(" | ").slice(0, 500) },
				{
					shape: {
						type: "choice",
						instructions: SHAPE_INSTRUCTIONS,
						criteria: {
							default: "ordinary answer; continuations, direct small tasks, short factual questions",
							terse: "explicit brevity ask (just tell me, one line, tl;dr, short, quick)",
							"diagram-first": "architecture/flow/structure explanation — lead with a graph",
							table: "side-by-side comparison of options or attributes",
							walkthrough: "step-by-step procedure or cause-chain (how-to, why did X fail)",
							artifact: "substantial self-contained deliverable to keep (design note, plan)",
						},
					},
				},
			);
			if (!res?.answers) {
				trail("shapeVerdict", { judge: "jev", ok: false });
				return null;
			}
			return settleShape(res.answers, "jev", res.usage);
		} catch {
			trail("shapeVerdict", { judge: "jev", ok: false });
			return null;
		}
	}
	return null;
}

// ── simplify verdict (worker completion gate) ───────────────────────────

export type SimplifyKind = "delete" | "merge" | "inline";
export interface SimplifyVerdict {
	simpler: boolean;
	kind: SimplifyKind | null;
	hints: string; // ≤200 chars
}

const SIMPLIFY_KINDS: readonly SimplifyKind[] = ["delete", "merge", "inline"];

function simplifyKindOf(v: unknown): SimplifyKind | null {
	const s = typeof v === "string" ? v : typeof (v as any)?.choice === "string" ? (v as any).choice : "";
	const t = s.trim().toLowerCase();
	return (SIMPLIFY_KINDS as readonly string[]).includes(t) ? (t as SimplifyKind) : null;
}

/** simpler answer → true/false, null when malformed (fail-open, not false:
 * a malformed verdict must produce NO hint, never a confident "nothing to
 * simplify"). */
function simplerOf(v: unknown): boolean | null {
	if (v === "yes" || v === true) return true;
	if (v === "no" || v === false) return false;
	if (v && typeof v === "object" && typeof (v as any).noul === "boolean") return (v as any).noul;
	return null;
}

/** Is there a simpler shape: what to DELETE / MERGE / INLINE in the work this
 * worker just completed? Judged ONCE per worker completion on that run's
 * closed implementation blocks (gists) — a separate small judge in the
 * docsVerdict/shapeVerdict pattern, NOT a routingIntent field (workers run
 * headless: the completion push is the only seam where the report exists as a
 * unit). SUGGEST-ONLY downstream: the verdict rides the worker's inbox line
 * as a hint the deck decides about — never auto-sends work back. Fail-open
 * null (no judges, error, malformed simpler/kind) → no hint, completion ships
 * unchanged. Verdict lands on the trail, never message text. */
export async function simplifyVerdict(work: string): Promise<SimplifyVerdict | null> {
	const settle = (res: Record<string, unknown>, judge: string, usage?: unknown): SimplifyVerdict | null => {
		const s = simplerOf(res.simpler);
		if (s === null) {
			trail("simplifyVerdict", { judge, ok: false, ...tkf({ usage }) });
			return null;
		}
		const kind = simplifyKindOf(res.kind);
		const out: SimplifyVerdict = {
			simpler: s,
			kind: s ? kind : null,
			hints: typeof res.hints === "string" ? res.hints.replace(/\s+/g, " ").trim().slice(0, 200) : "",
		};
		trail("simplifyVerdict", { judge, ok: true, simpler: out.simpler, kind: out.kind, ...tkf({ usage }) });
		return out;
	};
	if (loadKey()) {
		const r = await generate(
			`Implementation work completed by a coding-agent worker this run (gists of the closed blocks):\n${work.slice(0, 2000)}`,
			{
				simpler: {
					type: "string",
					enum: ["yes", "no"],
					instructions:
						"Is there a SIMPLER SHAPE for this completed work — something to delete (dead paths, speculative flags, unused branches), merge (near-duplicate modules/handlers), or inline (one-use abstractions, single-caller indirection)? Fresh simple scaffolding with nothing to simplify = no.",
				},
				kind: {
					type: "string",
					enum: ["delete", "merge", "inline"],
					instructions: "The dominant simplification, if simpler=yes.",
				},
				hints: { type: "string", instructions: "One actionable hint naming what to simplify, max 30 words." },
			},
		);
		if (!r?.result) {
			trail("simplifyVerdict", { judge: "typellm", ok: false }); // gap-rule: dead transport is still a judge call
			return null;
		}
		return settle(r.result, "typellm", r.usage);
	}
	if (classifyFn) {
		try {
			const res = await classifyFn(
				{ work: work.slice(0, 1200) },
				{
					simpler: {
						type: "noul",
						instructions:
							"State field 'work' summarizes implementation work a coding-agent worker just completed. Is there a simpler shape — something to delete (dead paths, speculative flags), merge (near-duplicates), or inline (one-use abstractions)? Fresh simple scaffolding = no. Answer yes/no.",
					},
					kind: {
						type: "choice",
						instructions: "The dominant simplification, if simpler=yes.",
						criteria: { delete: "dead paths / speculative flags / unused branches to remove", merge: "near-duplicate modules or handlers to fold together", inline: "one-use abstractions or single-caller indirection to inline" },
					},
					hints: { type: "string", instructions: "One actionable hint naming what to simplify, max 30 words." },
				},
			);
			if (!res?.answers) {
				trail("simplifyVerdict", { judge: "jev", ok: false }); // gap-rule: unusable answer is still a judge call
				return null;
			}
			return settle(res.answers, "jev", res.usage);
		} catch {
			trail("simplifyVerdict", { judge: "jev", ok: false });
			return null;
		}
	}
	return null;
}

// ── lifecycle pair verdict (v2.4 consolidation) ────────────────────────────────────

export interface LifecyclePairVerdict {
	contradicts: boolean; // newer reverses older's decision → older superseded
	triedAndFailed: boolean; // newer records older's approach as tried-and-failed/reverted → older failed
}

/** Same-topic pair check for consolidation: does the LATER block reverse or
 * record-as-failed the EARLIER block's decision/approach? One call, both
 * verdicts. Null on any failure — caller falls back to its lexical verdict
 * (never demotes without SOME recorded verdict). */
export async function lifecycleVerdict(olderText: string, newerText: string): Promise<LifecyclePairVerdict | null> {
	if (loadKey()) {
		const r = await generate(
			`Earlier decision or approach:\n${olderText.slice(0, 600)}\n\nLater work:\n${newerText.slice(0, 600)}`,
			{
				contradicts: {
					type: "string",
					enum: ["yes", "no", "unsure"],
					instructions:
						"Does the LATER work reverse, replace or contradict the EARLIER decision (opposite choice, dropped in favor of an alternative)? A new aspect, extension or documentation of the same decision is no.",
				},
				tried_and_failed: {
					type: "string",
					enum: ["yes", "no", "unsure"],
					instructions:
						"Does the LATER work record the EARLIER approach as tried-and-failed or reverted (attempted, did not work, rolled back)?",
				},
			},
		);
		const res = r?.result ?? {};
		const c = res.contradicts, f = res.tried_and_failed;
		const tk = tkf(r);
		if (c === undefined && f === undefined) {
			trail("lifecycleVerdict", { judge: "typellm", ok: false, ...tk });
			return null;
		}
		const out = { contradicts: c === "yes", triedAndFailed: f === "yes" };
		trail("lifecycleVerdict", { judge: "typellm", ok: true, contradicts: out.contradicts, triedAndFailed: out.triedAndFailed, ...tk });
		return out;
	}
	if (classifyFn) {
		try {
			const res = await classifyFn(
				{ older: olderText.slice(0, 300), newer: newerText.slice(0, 300) },
				{
					contradicts: {
						type: "noul",
						instructions:
							"State has 'older' (an earlier decision) and 'newer' (later work). Does newer reverse, replace or contradict the earlier decision — not merely extend or document it? Answer yes/no.",
					},
					tried_and_failed: {
						type: "noul",
						instructions:
							"Does the later work record the earlier approach as tried-and-failed or reverted? Answer yes/no.",
					},
				},
			);
			const a1 = res?.answers?.contradicts, a2 = res?.answers?.tried_and_failed;
			if (a1 === undefined && a2 === undefined) {
				trail("lifecycleVerdict", { judge: "jev", ok: false }); // gap-rule: unusable answer is still a judge call
				return null;
			}
			const out = {
				contradicts: a1 === true || (a1 as any)?.noul === true,
				triedAndFailed: a2 === true || (a2 as any)?.noul === true,
			};
			trail("lifecycleVerdict", { judge: "jev", ...out, ...tkf(res) });
			return out;
		} catch {
			trail("lifecycleVerdict", { judge: "jev", ok: false }); // gap-rule: classifier raised — fail-open call recorded
			return null;
		}
	}
	return null;
}

// ── CLI: setup | verify (same shape as pi-codemap's typellm.ts) ─────────

export function writeKeyFile(path: string, key: string): void {
	const k = key.trim();
	if (!k) throw new Error("empty API key");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, k);
	chmodSync(path, 0o600);
}

export async function verify(): Promise<void> {
	if (!loadKey()) throw new Error("no key: npx tsx ext/judges.ts setup (or TYPELLM_API_KEY env)");
	const r = await generate(
		"Receipt from Cafe Aurora\nFlat white £3.20\nTotal: £12.40\nPaid by card.",
		{
			merchant: { type: "string", instructions: "Return only the merchant name." },
			total: { type: "number", instructions: "Extract the total amount as a number." },
		},
	);
	if (!r) throw new Error("call failed (network or auth)");
	console.log(JSON.stringify({ result: r.result }, null, 2));
	console.error(`key OK (${defaultKeyFile()})`);
}

async function readStdinAll(): Promise<string> {
	const chunks: string[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk.toString());
	return chunks.join("");
}

async function setup(): Promise<void> {
	let key: string;
	if (process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		key = await new Promise<string>((resolve) =>
			rl.question(`Paste the TypeLLM API key (piped works too: echo $KEY | npx tsx ext/judges.ts setup): `, resolve),
		);
		rl.close();
	} else {
		key = (await readStdinAll()).split("\n")[0] ?? "";
	}
	writeKeyFile(defaultKeyFile(), key);
	const k = key.trim();
	console.error(`key written to ${defaultKeyFile()} (${k.length >= 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "***"}, chmod 600)`);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("judges.ts");
if (isMain) {
	(process.argv[2] === "setup" ? setup() : process.argv[2] === "verify" ? verify() : Promise.reject(new Error("usage: judges.ts setup|verify")))
		.then(() => process.exit(0))
		.catch((e: Error) => {
			console.error(String(e.message ?? e));
			process.exit(1);
		});
}

// ── Jev via pi's classifier registry (wired from index.ts on session_start) ─

export interface ClassifyResult {
	model: string;
	answers: Record<string, unknown>;
	usage?: unknown; // token report when the classifier registry exposes one (cost telemetry)
}
export type ClassifyFn = (state: Record<string, unknown>, questions: Record<string, unknown>) => Promise<ClassifyResult | null>;

let classifyFn: ClassifyFn | null = null;
/** Optional diversion transport: the user's own chat model (reg.complete).
 * Used for string extraction (gists) when no TypeLLM key exists. */
let streamFn: ((prompt: string) => Promise<string | null>) | null = null;
export function setStreamFn(fn: (prompt: string) => Promise<string | null>): void {
	streamFn = fn;
}
export function hasStreamFn(): boolean {
	return streamFn !== null;
}
/** Called by the extension factory once a context exposes modelRegistry. */
export function setClassifyFn(fn: ClassifyFn): void {
	classifyFn = fn;
}
export function hasJev(): boolean {
	return classifyFn !== null;
}
/** The wired classifier, null when none — panel.ts composes engines from
 * this (a missing engine is never fabricated). */
export function getClassifyFn(): ClassifyFn | null {
	return classifyFn;
}
export function resetClassifyFn(): void {
	classifyFn = null;
}

/** Probability battery over named dims. Jev first (noul 0/1), guarded TypeLLM
 * number fallback. Null on failure — callers skip vector scoring (fail-open). */
export async function dimVector(seg: string, dims: string[], segKind: "segment" | "message"): Promise<Map<string, number> | null> {
	const instructions = (d: string) =>
		segKind === "segment"
			? `State field 'seg' is a conversation segment from a coding-agent session. Is this segment primarily about '${d}'? Answer yes/no.`
			: `State field 'seg' is a user chat message from a coding-agent session. Is this message primarily about '${d}'? Answer yes/no.`;
	// gap-rule telemetry: this judge never trailed — one line per invocation
	// (retries are the transport's business), so /majordome stats sees the
	// per-block and per-query dim cost
	let attempts = 0;
	let lastJudge = "none";
	let tokens = 0;
	if (classifyFn) {
		for (let attempt = 0; attempt < 2; attempt++) {
			attempts++;
			lastJudge = "jev";
			try {
				const res = await classifyFn(
					{ seg: seg.slice(0, 2500) },
					Object.fromEntries(dims.map((d) => [d, { type: "noul", instructions: instructions(d) }])),
				);
				tokens += tokensOf(res) ?? 0;
				const answers = res?.answers ?? {};
				const vals = dims.map((d) => {
					const a = answers[d] as { noul?: boolean } | boolean | undefined;
					if (a === undefined || a === null) return null;
					return typeof a === "boolean" ? a : (a.noul ?? null);
				});
				const m = parseDims(vals, dims.length);
				if (m) {
					dims.forEach((d, i) => m.set(d, vals[i] === true || (vals[i] as any)?.noul === true ? 1 : 0));
					trail("dimVector", { judge: "jev", ok: true, attempts, ...(tokens ? { estTokens: tokens } : {}) });
					return m;
				}
			} catch {
				// fall through to retry / TypeLLM fallback
			}
		}
	}
	// guarded TypeLLM number fallback (the proven config flip, automatic)
	for (let attempt = 0; attempt < 3; attempt++) {
		attempts++;
		lastJudge = "typellm";
		const r = await generate(
			seg.slice(0, 2500),
			Object.fromEntries(
				dims.map((d) => [
					d,
					{ type: "number", instructions: `Probability 0.0-1.0 that this conversation segment is about '${d}'. Use the full range; 0.5 means genuinely mixed.` },
				]),
			),
		);
		tokens += tokensOf(r) ?? 0;
		const res = r?.result ?? {};
		const vals = dims.map((d) => {
			const v = res[d];
			return v === null || v === undefined ? null : Number(v);
		});
		const m = parseDims(vals, dims.length);
		if (m) {
			dims.forEach((d, i) => m.set(d, Number(vals[i])));
			trail("dimVector", { judge: "typellm", ok: true, attempts, ...(tokens ? { estTokens: tokens } : {}) });
			return m;
		}
	}
	trail("dimVector", { judge: lastJudge, ok: false, attempts }); // fail-open null — recorded
	return null;
}
