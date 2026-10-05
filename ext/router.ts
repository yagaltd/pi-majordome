/**
 * pi-majordome router — the measured pipeline (router spec v4 / slice-five):
 *
 *   user query → TypeLLM DAG {intent, search_terms} →
 *     continuation            → no retrieval (most turns; zero cost)
 *     otherwise               → time-travel filter (only fully-formed past
 *                               blocks; never the in-context current block)
 *                               → federated per-session top-3 pools
 *                               → specialist arm: definition_recall → dims
 *                                 cosine, incident_specific → hybrid BM25
 *                               → winner block
 *
 * Pure decision logic here; judges injected so tests run offline.
 */
import { bm25Rank, federatedOrder, cosineVec, sessionSlug, shortTag, tokens } from "./core.ts";
import type { RoutingIntent, DocsKind } from "./judges.ts";
import { statusOf, type Block } from "./store.ts";
import { BUILTIN_DOC_WATCH, watchRegexFor } from "./docsprofile.ts";

export type Arm = "dims" | "lex";

/** Arm selection by intent class — specialists, not averages (slice-5: 3/7
 * vs 2/7 for any single arm or naive fusion). */
export function armFor(intent: string): Arm {
	return intent === "definition_recall" ? "dims" : "lex";
}

/** Time-travel: candidates are fully-formed past blocks. Blocks from OTHER
 * sessions are always past; the current session contributes only closed
 * blocks (the open tail / current block is already in context). */
export function timeTravel(blocks: Block[], currentSession: string, currentTurn: number, currentSessionFile?: string): Block[] {
	return blocks.filter((b) => b.sessionFile !== currentSessionFile || b.lastTurn < currentTurn);
}

// ── lifecycle recall scope (v2.4) ─────────────────────────────────────────────

/** Failure-intent queries ask about dead approaches — the failed/superseded
 * blocks are exactly what the user wants surfaced (spec regex, plus went/go
 * wrong so "did the iframe attempt go wrong?" counts too). */
export const FAILURE_INTENT_RE = /what did we (try|attempt)|\bfailed\b|\brevert\w*\b|\babandon\w*\b|wrong path|didn'?t work|went wrong|go(es)? wrong|dead end|dead-end|proved brittle|flopped|not survive/i;

export function isFailureIntent(query: string): boolean {
	return FAILURE_INTENT_RE.test(query);
}

/** Temporal queries (LongMemEval ability) ask what held BEFORE the current
 * decision — the superseded blocks are the answer, not noise. Failures stay
 * failure-intent-only: "used to" never resurrects tried-and-failed work. */
export const TEMPORAL_INTENT_RE = /\b(?:before|prior to|previously|used to|history of)\b/i;

export function isTemporalIntent(query: string): boolean {
	return TEMPORAL_INTENT_RE.test(query);
}

/** Default recall scope excludes dead blocks (failed + superseded —
 * consolidation already picked the living successor); failure-intent queries
 * include them all; temporal queries include the superseded generation (the
 * "what did we do before" answer) but still exclude failed. Speculative stays
 * in every scope (hedged ≠ dead). */
export function scopeByLifecycle(cands: Block[], query: string): Block[] {
	if (isFailureIntent(query)) return cands;
	if (isTemporalIntent(query)) {
		return cands.filter((b) => statusOf(b) !== "failed");
	}
	return cands.filter((b) => {
		const s = statusOf(b);
		return s === "valid" || s === "speculative";
	});
}

// ── @slug hard scope (v2.6) ───────────────────────────────────────────────────

/** @slug token scan (spec regex) — sigil + slug chars, case-insensitive. */
export const SLUG_TOKEN_RE = /@([a-z0-9][a-z0-9-]*)/gi;

/** Session slug of a block: pi's cwd slug, lineage ingest prefix stripped. */
export function slugOfBlock(b: { session: string }): string {
	return b.session.replace(/^lineage:/, "");
}

/** Known-slug @tokens in the query, derived from the candidate pool itself
 * (no registry): a token hits when it equals a block's session slug or its
 * human shortTag, case-insensitively. Unknown @tokens (mentions, emails) are
 * left alone as plain text. Null = no known slug → no hard scope, behavior
 * exactly as before. */
export function slugScopeFrom(query: string, cands: { session: string }[]): string[] | null {
	const known = new Set<string>();
	for (const b of cands) {
		const s = slugOfBlock(b);
		known.add(s.toLowerCase());
		known.add(shortTag(s).toLowerCase());
	}
	const hits = new Set<string>();
	for (const m of query.matchAll(SLUG_TOKEN_RE)) {
		const t = m[1].toLowerCase();
		if (known.has(t)) hits.add(t);
	}
	return hits.size ? [...hits].sort() : null;
}

function inSlugScope(b: { session: string }, scope: string[]): boolean {
	const s = slugOfBlock(b);
	return scope.includes(s.toLowerCase()) || scope.includes(shortTag(s).toLowerCase());
}

export interface Scored {
	block: Block;
	score: number;
}

/** Rank candidates with the chosen arm. dims vectors come from the judge
 * layer (query vector precomputed); lex is pure BM25 over tokensHybrid. */
export function rankArm(
	cands: Block[],
	queryTerms: Set<string>,
	queryVec: Map<string, number> | null,
	arm: Arm,
): Scored[] {
	if (arm === "lex" || !queryVec || queryVec.size === 0) {
		const scores = bm25Rank(cands, queryTerms);
		return cands
			.map((block, i) => ({ block, score: scores[i] ?? 0 }))
			.sort((a, b) => b.score - a.score);
	}
	// REJECTED experiment (2026-10-03): lexical floor max(cos, 0.5·bm25norm) in
	// this arm scored 1/6 → 1/6 on resumebench — same-topic corpora collide on
	// terms like "map" (idf can't discriminate within one project). The fix is
	// scope priors + one-pager scoping + dims quality, not lexical rescue.
	const scored = cands.map((block) => ({
		block,
		score: cosineVec(queryVec, new Map(Object.entries(block.dims))),
	}));
	return scored.sort((a, b) => b.score - a.score);
}

export interface RouteResult {
	intent: string;
	arm: Arm;
	terms: string;
	winner: Block | null;
	score: number;
	ranked: Scored[];
	nCands: number;
	needClarification: boolean;
	clarifyWhy: string;
	slugScope: string[] | null; // known @slugs matched by the query (null = none)
}

/** Full route. judges injected: dag intent + query dims. Null dag or
 * continuation → no retrieval. Empty candidates → no retrieval. */
export async function route(opts: {
	userMessage: string;
	blocks: Block[];
	currentSession: string;
	currentTurn: number;
	currentSessionFile?: string;
	routingIntent: (m: string) => Promise<Pick<RoutingIntent, "intent" | "searchTerms" | "needClarification" | "clarifyWhy"> | null>;
	queryDims: (q: string) => Promise<Map<string, number> | null>;
	tokens: (s: string) => Set<string>;
}): Promise<RouteResult | null> {
	const dag = await opts.routingIntent(opts.userMessage);
	if (!dag || dag.intent === "continuation") return null;

	let terms = dag.searchTerms || opts.userMessage;
	const failureIntent = isFailureIntent(opts.userMessage);
	const temporalIntent = isTemporalIntent(opts.userMessage);
	const past = timeTravel(opts.blocks, opts.currentSession, opts.currentTurn, opts.currentSessionFile);
	// @slug hard scope (v2.6): known @slugs override the scope priors — the
	// candidate pool narrows to exactly those slugs' blocks (union for multiple;
	// no cross-repo bleed). Lifecycle filtering and intent scopes still apply on
	// top of the hard scope. The @ sigil is stripped from the retrieval terms
	// (dims/BM25 judge the bare word, not "@office-parser"); the userMessage
	// itself stays untouched for intent parsing.
	const slugScope = slugScopeFrom(opts.userMessage, past);
	const cands = scopeByLifecycle(slugScope ? past.filter((b) => inSlugScope(b, slugScope)) : past, opts.userMessage);
	if (slugScope) terms = terms.replace(/@([a-z0-9][a-z0-9-]*)/gi, "$1");
	if (!cands.length)
		return { intent: dag.intent, arm: armFor(dag.intent), terms, winner: null, score: 0, ranked: [], nCands: 0, needClarification: dag.needClarification, clarifyWhy: dag.clarifyWhy, slugScope };

	// federate: per-session top-3 pools, round-robin; scoring per arm on full pool
	const arm = armFor(dag.intent);
	const queryVec = arm === "dims" ? await opts.queryDims(terms) : null;
	const q = opts.tokens(terms);
	const merged = federatedOrder(cands, (blk) => {
		if (arm === "dims" && queryVec && queryVec.size) return cosineVec(queryVec, new Map(Object.entries(blk.dims)));
		return (bm25Rank([blk], q)[0] ?? 0);
	});
	// rank the merged set with the arm's full scoring for a winner score
	let ranked = rankArm(merged.length ? merged : cands, q, queryVec, arm);
	// evidence floor (v2.5, found by the lifecyclebench abstention probes):
	// BM25/cosine score > 0 ⇔ the block shares ≥1 non-stopword query token.
	// Zero-evidence blocks are not recall hits — without this floor every
	// off-topic query still returned a full ranked list (and a winner).
	// Exception: members of the intent-targeted class (failure-intent → failed,
	// temporal → superseded). The parsed intent is itself retrieval evidence for
	// the class it asks about ("what did we try that failed?" shares no tokens
	// with the failure records by design), so those blocks stay ranked even at
	// score 0 — exactly how they ranked before the floor existed.
	ranked = ranked.filter((s) => {
		if (s.score > 0) return true;
		const st = statusOf(s.block);
		return (failureIntent && st === "failed") || (temporalIntent && st === "superseded");
	});
	if (failureIntent || temporalIntent) {
		// intent priors lift only blocks with lexical evidence (floor first):
		// failure-intent prefers the dead approaches themselves, temporal
		// prefers the superseded generation the query is asking about
		ranked = ranked
			.map((s) => ({
				block: s.block,
				score:
					s.score +
					(failureIntent && statusOf(s.block) === "failed" ? 0.25 : 0) +
					(temporalIntent && statusOf(s.block) === "superseded" ? 0.25 : 0),
			}))
			.sort((a, b) => b.score - a.score);
	}
	return {
		intent: dag.intent,
		arm,
		terms,
		winner: ranked[0]?.block ?? null,
		score: ranked[0]?.score ?? 0,
		ranked,
		nCands: cands.length,
		needClarification: dag.needClarification,
		clarifyWhy: dag.clarifyWhy,
		slugScope,
	};
}

/** Injection entry (the ToC tail line). Short, tail-only, cache-free zone. */
/** mode soft (default): inform the agent, it decides — it has context and
 * tools the judge lacks. mode strict: imperative clarify-first. */
export function judgeLine(why: string, mode: "soft" | "strict" = "soft"): string {
	const whyTxt = why && why !== "ok" ? ` (${why})` : "";
	if (mode === "strict") return `[majordome judge] Your request looks underspecified${whyTxt}. Ask ONE clarifying question before starting long work.`;
	return `[majordome judge] Possible ambiguity${whyTxt}. If your tools or the conversation don't resolve it, ask one clarifying question before long work.`;
}

export function injectionText(w: Block, terms?: string, resume = false): string {
	const slug = shortTag(w.session);
	// validity date on every recall line — staleness must be visible to the reader
	const when = w.closedAt ? w.closedAt.slice(0, 10) : "";
	const bits = [`[majordome recall · ${slug} turns ${w.firstTurn}–${w.lastTurn}${when ? " · " + when : ""}]`];
	if (w.gist) bits.push(w.gist);
	if (w.intent) bits.push(`(intent: ${w.intent})`);
	if (terms && terms.trim()) bits.push(`Read your request as: ${terms.trim().slice(0, 80)}.`);
	if (resume) bits.push("This looks like work already done — resume it rather than redoing it.");
	bits.push("If relevant, continue that thread; otherwise ignore.");
	return bits.join(" ");
}

/** Judge-line gate: ambiguity verdict, debounced — skip when the agent's last
 * message already ends with a question (the user is likely answering it),
 * otherwise a brief answer re-triggers and clarification ping-pongs. */
export function shouldJudgeLine(r: RouteResult | null, recentAssistant?: string): boolean {
	if (!r || r.intent === "continuation" || !r.needClarification) return false;
	return !(recentAssistant ?? "").trimEnd().endsWith("?");
}

/** Docs cursor: which docs (per the repo's watch profile) were touched in the
 * session file? Built-ins keep their exact regexes; a custom watch name N
 * matches N.md at a path boundary, case-insensitively (watchRegexFor).
 * Pure — wired by index.ts at turn_end with the resolved profile's watch. */
export function scanDocsTouched(raw: string, watch: readonly string[] = BUILTIN_DOC_WATCH): string[] {
	const out: string[] = [];
	for (const name of watch) {
		if (out.includes(name)) continue;
		if (watchRegexFor(name).test(raw)) out.push(name);
	}
	return out;
}

// ── docs cursors (magic-docs v2): per-slug keys, lenient legacy migration ──

/** Cursor key for a doc touch: `slug:docName` (e.g. code-parser:README) — a
 * doc touch in repo X never advances repo Y's cursor. */
export function cursorKey(slug: string, doc: string): string {
	return `${slug}:${doc}`;
}

/** Read a doc cursor with legacy migration: pre-v2 stores keyed plain doc
 * names; those entries are treated as belonging to the CURRENT session's slug
 * (lenient, like Block.status parsing — never a store rewrite). */
export function cursorForDoc(cursor: Record<string, string>, slug: string, doc: string): string | undefined {
	return cursor[cursorKey(slug, doc)] ?? cursor[doc];
}

/** Per-doc cursor view for one session's slug: own `slug:doc` entries with
 * the slug stripped, other slugs' entries dropped, legacy plain entries kept
 * (they belong to the reading slug) but never shadowing a per-slug value.
 * Feeds the arithmetic nudge rule. */
export function cursorForSession(cursor: Record<string, string>, slug: string): Record<string, string> {
	const out: Record<string, string> = {};
	const own = `${slug}:`;
	for (const [k, v] of Object.entries(cursor)) if (k.startsWith(own)) out[k.slice(own.length)] = v;
	for (const [k, v] of Object.entries(cursor)) if (!k.includes(":") && out[k] === undefined) out[k] = v;
	return out;
}

/** Verdict kind → docs-cursor doc name (ADRs conventionally land in docs/). */
export const KIND_DOC: Record<DocsKind, string> = { readme: "README", changelog: "CHANGELOG", adr: "docs/" };

export function docsNudge(
	blocks: { sessionFile: string; intent: string | null; gist: string | null; closedAt: string }[],
	sessionFile: string,
	cursor: Record<string, string>,
	watch: readonly string[] = BUILTIN_DOC_WATCH,
): string | null {
	// profile-driven (v2.7): the arithmetic fallback speaks only for the docs
	// it names — a repo whose profile watches neither README nor CHANGELOG
	// (e.g. generic docs-only) never gets this nudge
	if (!watch.includes("README") && !watch.includes("CHANGELOG")) return null;
	const scoped = blocks.filter((b) => b.sessionFile === sessionFile && b.intent === "implementation" && b.gist);
	// v2: per-slug cursor view — other repos' doc touches never cover this session's work
	// v2.7: only watched docs count as covering touches (unwatched cursors are inert)
	const own = Object.fromEntries(Object.entries(cursorForSession(cursor, sessionSlug(sessionFile))).filter(([k]) => watch.includes(k)));
	const oldestTouch = Object.values(own).sort()[0];
	const since = oldestTouch ? scoped.filter((b) => b.closedAt > oldestTouch) : scoped;
	if (since.length < 3) return null;
	const list = since.slice(-3).map((b) => b.gist!.slice(0, 60)).join("; ");
	return `[majordome docs] ${since.length} implementation blocks since ${Object.keys(own).join("/") || "any docs touch"} — recent: ${list}. Consider a README/CHANGELOG pass before wrapping up.`;
}

/** Verdict-driven nudge text (magic-docs v2): always names its slug — that IS
 * the routing (the session that did the work lives in that repo) — plus the
 * kind, grounded with gists and block ids like the arithmetic nudge. */
export function docsVerdictNudge(
	slugTag: string,
	kind: DocsKind,
	items: { id: string; gist: string }[],
): string {
	const list = items.slice(-3).map((b) => `${b.gist.slice(0, 60)} (${b.id})`).join("; ");
	const doc = kind === "readme" ? "README" : kind === "changelog" ? "CHANGELOG" : "docs/ ADR";
	return `[majordome docs · ${slugTag}] judge verdict: ${kind}-worthy work this turn — ${list}. Consider a ${doc} pass before wrapping up.`;
}

/** Verdict → nudge decision (the exact rule index.ts applies at turn_end,
 * pure so the bench can gate it): docsWorthy=false → no nudge regardless of
 * count; a docs touch at/after this turn's work covers it; otherwise compose
 * the nudge naming slug + kind. Null = stay quiet. */
export function verdictToNudge(
	verdict: { docsWorthy: boolean; kind: DocsKind | null },
	cursor: Record<string, string>,
	slug: string,
	turnWork: { id: string; gist: string; closedAt: string }[],
	watch: readonly string[] = BUILTIN_DOC_WATCH,
): string | null {
	if (!verdict.docsWorthy || !verdict.kind || !turnWork.length) return null;
	// profile-driven (v2.7): a changelog-worthy verdict in a generic-profile
	// repo (CHANGELOG not watched) stays quiet — only watched docs nudge
	if (!watch.includes(KIND_DOC[verdict.kind])) return null;
	const cur = cursorForDoc(cursor, slug, KIND_DOC[verdict.kind]);
	const newestWork = turnWork.map((b) => b.closedAt).sort().at(-1) ?? "";
	if (cur && cur >= newestWork) return null; // the kind's cursor already covers this work
	return docsVerdictNudge(shortTag(slug), verdict.kind, turnWork);
}
