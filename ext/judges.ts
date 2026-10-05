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

async function generate(
	context: string,
	questions: Record<string, unknown>,
	recent?: string,
): Promise<{ result: Record<string, unknown> } | null> {
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
			if (json?.result && typeof json.result === "object") return json;
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

// ── block-close meta (TypeLLM strings) ──────────────────────────────────────

const INTENTS = new Set(["implementation", "investigation", "evaluation", "documentation", "discussion"]);

export interface BlockMeta {
	intent: string | null;
	gist: string | null;
}

/** intent + gist, one batched call. Null on any failure — block indexes
 * without meta and the next reindex can backfill. */
export async function blockMeta(text: string): Promise<BlockMeta | null> {
	if (!loadKey() && streamFn) {
		// divert to the agent's own model: extraction without TypeLLM
		try {
			const out = await streamFn(
				`You will be given a segment of a coding-agent session. Reply with EXACTLY two lines and nothing else:\nintent: <one of implementation, investigation, evaluation, documentation, discussion>\ngist: <one sentence: what was done or decided>\n\nSegment:\n${text.slice(0, 6000)}`,
			);
			if (out) {
				const intent = out.match(/intent:\s*([a-z]+)/i)?.[1]?.toLowerCase() ?? null;
				const gist = out.match(/gist:\s*(.+)/i)?.[1]?.trim();
				if (gist) {
				trail("blockMeta", { judge: "agent", ok: true, intent: intent ?? null });
				return { intent: intent && INTENTS.has(intent) ? intent : null, gist };
			}
			}
		} catch {
			// fall through to null
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
	});
	const res = r?.result ?? {};
	const ok = typeof res.gist === "string" && !!res.gist.trim();
	trail("blockMeta", { judge: "typellm", ok, intent: typeof res.intent === "string" ? res.intent : null });
	if (!ok) return null;
	return { intent: typeof res.intent === "string" ? res.intent : null, gist: res.gist.trim() };
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
		trail("induceDims", { ok: false });
		return [];
	}
	const dims = v
		.split(",")
		.map((n) => n.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""))
		.filter((n) => n.length >= 3)
		.slice(0, 6);
	trail("induceDims", { ok: dims.length > 0, n: dims.length });
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
	trail("rewriteQuery", { ok });
	return ok ? (v as string).trim() : null;
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
	trail("keyPhrases", { ok });
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
			if (!label || label === "continuation") return null;
			const nc = res?.answers?.need_clarification as { noul?: boolean } | boolean | undefined;
			const need = nc === true || (nc as any)?.noul === true;
			trail("routingIntent", { judge: "jev", intent: label, clarify: need });
			return {
				intent: label,
				searchTerms: "",
				needClarification: need,
				clarifyWhy: "",
			};
		} catch {
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
	if (typeof res.intent !== "string") {
		trail("routingIntent", { judge: "typellm", ok: false });
		return null;
	}
	trail("routingIntent", {
		judge: "typellm",
		intent: res.intent,
		rewrite: typeof res.search_terms === "string" && !!res.search_terms,
		clarify: res.need_clarification === "yes",
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
		trail("contradicts", { judge: "typellm", verdict });
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
			trail("contradicts", { judge: "jev", verdict });
			return verdict;
		} catch {
			return false;
		}
	}
	return false;
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
		if (c === undefined && f === undefined) {
			trail("lifecycleVerdict", { judge: "typellm", ok: false });
			return null;
		}
		const out = { contradicts: c === "yes", triedAndFailed: f === "yes" };
		trail("lifecycleVerdict", { judge: "typellm", ok: true, contradicts: out.contradicts, triedAndFailed: out.triedAndFailed });
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
			if (a1 === undefined && a2 === undefined) return null;
			const out = {
				contradicts: a1 === true || (a1 as any)?.noul === true,
				triedAndFailed: a2 === true || (a2 as any)?.noul === true,
			};
			trail("lifecycleVerdict", { judge: "jev", ...out });
			return out;
		} catch {
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
	if (classifyFn) {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await classifyFn(
					{ seg: seg.slice(0, 2500) },
					Object.fromEntries(dims.map((d) => [d, { type: "noul", instructions: instructions(d) }])),
				);
				const answers = res?.answers ?? {};
				const vals = dims.map((d) => {
					const a = answers[d] as { noul?: boolean } | boolean | undefined;
					if (a === undefined || a === null) return null;
					return typeof a === "boolean" ? a : (a.noul ?? null);
				});
				const m = parseDims(vals, dims.length);
				if (m) {
					dims.forEach((d, i) => m.set(d, vals[i] === true || (vals[i] as any)?.noul === true ? 1 : 0));
					return m;
				}
			} catch {
				// fall through to retry / TypeLLM fallback
			}
		}
	}
	// guarded TypeLLM number fallback (the proven config flip, automatic)
	for (let attempt = 0; attempt < 3; attempt++) {
		const r = await generate(
			seg.slice(0, 2500),
			Object.fromEntries(
				dims.map((d) => [
					d,
					{ type: "number", instructions: `Probability 0.0-1.0 that this conversation segment is about '${d}'. Use the full range; 0.5 means genuinely mixed.` },
				]),
			),
		);
		const res = r?.result ?? {};
		const vals = dims.map((d) => {
			const v = res[d];
			return v === null || v === undefined ? null : Number(v);
		});
		const m = parseDims(vals, dims.length);
		if (m) {
			dims.forEach((d, i) => m.set(d, Number(vals[i])));
			return m;
		}
	}
	return null;
}
