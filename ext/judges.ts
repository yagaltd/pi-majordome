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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOSTED_URL = "https://api.typellm.ai";
const TIMEOUT_MS = 30_000;

export function defaultKeyFile(): string {
	return join(homedir(), ".config", "pi-majordome", "typellm.key");
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

export interface BlockMeta {
	intent: string | null;
	gist: string | null;
}

/** intent + gist, one batched call. Null on any failure — block indexes
 * without meta and the next reindex can backfill. */
export async function blockMeta(text: string): Promise<BlockMeta | null> {
	const r = await generate(text.slice(0, 6000), {
		intent: {
			type: "string",
			enum: ["implementation", "investigation", "evaluation", "documentation", "discussion"],
			instructions: "Primary intent of this segment.",
		},
		gist: { type: "string", instructions: "One sentence: what was done or decided." },
	});
	const res = r?.result ?? {};
	if (typeof res.gist !== "string" || !res.gist.trim()) return null;
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
	if (typeof v !== "string") return [];
	return v
	.split(",")
	.map((n) => n.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""))
	.filter((n) => n.length >= 3)
	.slice(0, 6);
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
	return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ── routing intent DAG (TypeLLM-only depends_on capability) ─────────────────

export interface RoutingIntent {
	intent: "definition_recall" | "incident_specific" | "continuation";
	searchTerms: string;
}

export async function routingIntent(userMessage: string): Promise<RoutingIntent | null> {
	const r = await generate(userMessage, {
		intent: {
			type: "string",
			enum: ["definition_recall", "incident_specific", "continuation"],
			instructions:
				"Classify this user message in a coding-agent chat: definition_recall = asks what something is / summarize / remind me; incident_specific = refers to a concrete event (a crash, a bug, a specific run); continuation = continues the current topic.",
		},
		search_terms: {
			type: "string",
			depends_on: ["intent"],
			instructions: "5-12 terse content keywords for retrieving the relevant past work. Strip meta framing.",
		},
	});
	const res = r?.result ?? {};
	if (typeof res.intent !== "string") return null;
	return {
		intent: res.intent as RoutingIntent["intent"],
		searchTerms: typeof res.search_terms === "string" ? res.search_terms : "",
	};
}

// ── Jev via pi's classifier registry (wired from index.ts on session_start) ─

export interface ClassifyResult {
	model: string;
	answers: Record<string, unknown>;
}
export type ClassifyFn = (state: Record<string, unknown>, questions: Record<string, unknown>) => Promise<ClassifyResult | null>;

let classifyFn: ClassifyFn | null = null;
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
