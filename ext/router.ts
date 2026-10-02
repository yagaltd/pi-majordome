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
import { bm25Rank, federatedOrder, cosineVec, shortTag, tokens } from "./core.ts";
import type { RoutingIntent } from "./judges.ts";
import type { Block } from "./store.ts";

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

	const terms = dag.searchTerms || opts.userMessage;
	const cands = timeTravel(opts.blocks, opts.currentSession, opts.currentTurn, opts.currentSessionFile);
	if (!cands.length)
		return { intent: dag.intent, arm: armFor(dag.intent), terms, winner: null, score: 0, ranked: [], nCands: 0, needClarification: dag.needClarification, clarifyWhy: dag.clarifyWhy };

	// federate: per-session top-3 pools, round-robin; scoring per arm on full pool
	const arm = armFor(dag.intent);
	const queryVec = arm === "dims" ? await opts.queryDims(terms) : null;
	const q = opts.tokens(terms);
	const merged = federatedOrder(cands, (blk) => {
		if (arm === "dims" && queryVec && queryVec.size) return cosineVec(queryVec, new Map(Object.entries(blk.dims)));
		return (bm25Rank([blk], q)[0] ?? 0);
	});
	// rank the merged set with the arm's full scoring for a winner score
	const ranked = rankArm(merged.length ? merged : cands, q, queryVec, arm);
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
	};
}

/** Injection entry (the ToC tail line). Short, tail-only, cache-free zone. */
export function judgeLine(why: string): string {
	return `[majordome judge] Your request looks underspecified${why && why !== "ok" ? ` (${why})` : ""}. Ask ONE clarifying question before starting long work.`;
}

export function injectionText(w: Block, terms?: string, resume = false): string {
	const slug = shortTag(w.session);
	const bits = [`[majordome recall · ${slug} turns ${w.firstTurn}–${w.lastTurn}]`];
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
