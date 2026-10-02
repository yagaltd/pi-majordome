/**
 * pi-majordome core — direct port of bench/eval.py + bench/cross_eval.py
 * (the measured algorithms; params frozen at the values the slices used:
 * EMA tau=0.07 min_size=4 decay=0.85 keep=0.3, hybrid = user tokens + tail-3,
 * binary-tf BM25, federated per-session top-3 round-robin).
 *
 * Source of truth is the pi session JSONL (never rewritten). This module only
 * produces pure structures; the side-car index lives in ext/store helpers.
 */
import { readFileSync } from "node:fs";

// ── tokenization (verbatim port) ────────────────────────────────────────────

const STOP = new Set(
	`the a an and or of to in on for with is are was were be been being i you he she it we they
this that these those do does did done can could will would should shall may might must have has had
my your our their its his her as at by from if then than so not no nor but about into over under
again further more most some any each few other such only own same too very s t just don now
what which who whom how why when where ok yes yeah okay go continue wait also`.split(/\s+/).filter(Boolean),
);

const TOK = /[a-z0-9_]{2,}/g;

export function textof(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
		.filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && (b as any).type === "text")
		.map((b) => b.text ?? "")
		.join(" ");
	}
	return "";
}

export function tokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.toLowerCase().matchAll(TOK)) {
		const t = m[0];
		if (!STOP.has(t) && !/^\d+$/.test(t)) out.add(t);
	}
	return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

// ── session parsing (verbatim port of parse_session) ───────────────────────

export interface Turn {
	user: string;
	text: string;
	n: number;
	utokens: Set<string>;
	tokens: Set<string>;
}

/** Walk the JSONL; a turn = user message + assistant text until next user.
 * Skips wrappers (`<...>`), system-reminders, retried turns (identical user text). */
export function parseSession(path: string): Turn[] {
	const turns: Turn[] = [];
	let cur: { user: string; norm: string; text: string } | null = null;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return turns;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e?.type !== "message") continue;
		const m = e.message ?? {};
		const role = m.role;
		const txt = textof(m.content).trim();
		if (role === "user") {
			if (!txt || txt.startsWith("<") || txt.slice(0, 30).includes("system-reminder")) continue;
			const norm = txt.toLowerCase().replace(/\s+/g, " ");
			if (cur && cur.norm === norm) continue; // retried turn
			cur = { user: txt, norm, text: txt };
			turns.push({ user: txt, text: txt, n: turns.length + 1, utokens: tokens(txt), tokens: tokens(txt) });
		} else if (role === "assistant" && cur) {
			cur.text += "\n" + txt;
			const t = turns[turns.length - 1];
			t.text = cur.text;
			t.tokens = tokens(cur.text);
		}
	}
	return turns;
}

/** cwd-slug session identity, e.g. `--home-aurel-Documents-current-code-parser--`. */
export function sessionSlug(sessionFile: string): string {
	const m = sessionFile.match(/sessions\/([^/]+)\//);
	return m ? m[1] : sessionFile;
}

// ── EMA boundary detection (verbatim port; deployment params) ──────────────

/** First-turn indices of each block (always includes 1). decay/keep per eval.py. */
export function detectBoundaries(
	turns: Turn[],
	tau = 0.07,
	minSize = 4,
	decay = 0.85,
	keep = 0.3,
): number[] {
	const bounds = [1];
	const ema = new Map<string, number>();
	for (let i = 0; i < turns.length; i++) {
		for (const k of [...ema.keys()]) {
			const v = ema.get(k)! * decay;
			if (v < keep) ema.delete(k);
			else ema.set(k, v);
		}
		const nw = turns[i].tokens;
		if (i > 0 && turns.length - bounds[bounds.length - 1] >= minSize) {
			if (jaccard(new Set(ema.keys()), nw) < tau) bounds.push(i + 1);
		}
		for (const k of nw) ema.set(k, (ema.get(k) ?? 0) + 1);
	}
	return bounds;
}

export interface BlockCore {
	firstTurn: number;
	lastTurn: number;
	text: string;
	tokensHybrid: Set<string>;
}

/** Hybrid field = user-turn tokens (dense intent statements) + tail-3 full turns. */
export function blockCores(turns: Turn[], firsts: number[], tailK = 3): BlockCore[] {
	const out: BlockCore[] = [];
	for (let j = 0; j < firsts.length; j++) {
		const start = firsts[j];
		const end = j + 1 < firsts.length ? firsts[j + 1] - 1 : turns.length;
		const seg = turns.slice(start - 1, end);
		const hyb = new Set<string>();
		for (const t of seg) for (const k of t.utokens) hyb.add(k);
		for (const t of seg.slice(-tailK)) for (const k of t.tokens) hyb.add(k);
		out.push({
			firstTurn: start,
			lastTurn: end,
			text: seg.map((t) => t.text).join("\n"),
			tokensHybrid: hyb,
		});
	}
	return out;
}

// ── BM25, binary tf (verbatim port) ─────────────────────────────────────────

export function bm25Rank(blocks: { tokensHybrid: Set<string> | string[] }[], query: Set<string>,
                          k1 = 1.5, b = 0.75): number[] {
	const n = blocks.length;
	if (!n) return [];
	const fields = blocks.map((x) => (x.tokensHybrid instanceof Set ? x.tokensHybrid : new Set(x.tokensHybrid)));
	const avgdl = fields.reduce((s, f) => s + f.size, 0) / n;
	const df = new Map<string, number>();
	for (const f of fields) for (const t of f) df.set(t, (df.get(t) ?? 0) + 1);
	return fields.map((field) => {
		let s = 0;
		const dl = field.size;
		for (const term of query) {
			if (!field.has(term)) continue;
			const d = df.get(term) ?? 0;
			const idf = Math.log((n - d + 0.5) / (d + 0.5) + 1);
			s += idf * 1 * (k1 + 1) / (1 + k1 * (1 - b + (b * dl) / avgdl));
		}
		return s;
	});
}

/** Federated per-session top-3 pools, round-robin merge (cross_eval/slice5). */
export function federatedOrder<T extends { session: string }>(
	cands: T[],
	score: (item: T) => number,
	topK = 3,
): T[] {
	const pools = new Map<string, T[]>();
	for (const c of cands) {
		const p = pools.get(c.session) ?? [];
		p.push(c);
		pools.set(c.session, p);
	}
	const orders = [...pools.values()].map((pool) =>
		[...pool].sort((a, b2) => score(b2) - score(a)).slice(0, topK),
	);
	const merged: T[] = [];
	const seen = new Set<T>();
	for (let r = 0; r < topK; r++) {
		for (const o of orders) {
			if (r < o.length && !seen.has(o[r])) {
				seen.add(o[r]);
				merged.push(o[r]);
			}
		}
	}
	return merged;
}

export function cosineVec(a: Map<string, number>, b: Map<string, number>): number {
	let num = 0;
	let da = 0;
	let db = 0;
	for (const [k, v] of a) {
		da += v * v;
		const w = b.get(k);
		if (w !== undefined) num += v * w;
	}
	for (const v of b.values()) db += v * v;
	return da && db ? num / (Math.sqrt(da) * Math.sqrt(db)) : 0;
}

/** Human-readable session tag: pi slugs dash-join the cwd, so strip the
 * personal prefix and known path roots: --home-USER-Documents-current-X-- → X. */
export function shortTag(slug: string): string {
	const t = slug.replace(/^-+|-+$/g, "")
		.replace(/^home-[^-]+-/, "")
		.replace(/^(Documents-)?(current-|vibe-|github-)/, "");
	return t || slug;
}
