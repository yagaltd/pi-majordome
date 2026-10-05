/**
 * pi-majordome consolidation (v2.4) — lifecycle maintenance over the blocks
 * we already classified. Memory hygiene, not new intelligence:
 *
 *   block.status = valid (default) | superseded | failed | speculative
 *
 * Pass structure (per run, idempotent — only blocks reading `valid` are
 * (re)assigned):
 *   1. in-block outcome:   attempt + failure vocabulary in the block's own
 *                          hybrid field → `failed`   ("tried X, failed, rolled back")
 *      in-block hedging:   ≥2 distinct hedge tokens → `speculative`
 *                          ("maybe someday / no commitment / down the road")
 *   2. same-topic pairs:   candidate pairs by topic overlap (hybrid jaccard,
 *                          or dims cosine when both blocks carry dims), each
 *                          pair judged — judge seam first (judges.ts
 *                          lifecycleVerdict: TypeLLM → Jev, trail-recorded,
 *                          fail-open), then a lexical fallback verdict
 *                          (reversal vocabulary in the newer + shared rare
 *                          topic terms). `contradicts` → older superseded
 *                          (newer stays valid); tried-and-failed → older
 *                          failed. Never demote without a recorded verdict:
 *                          every assignment lands in trails.jsonl and in
 *                          lifecycle.json (with older/newer links + verdict
 *                          source).
 *
 * No network is REQUIRED: with judges unavailable (no key, no Jev) the lexical
 * verdict carries assignment (bench-verified hermetic). Recency = closedAt,
 * tie-broken by session file name.
 *
 *   runConsolidation()                    — programmatic / sidecar use
 *   runConsolidation({ blocksDir, blocks })— explicit store dir + block set
 * Also invoked at the end of the init backfill path (a plain init consolidates).
 *
 * Persistence: statuses are stamped onto the block records (blocks.jsonl
 * rewritten — the store's one mutating write, same class as forget) AND
 * mirrored to lifecycle.json { statuses, supersessions }.
 */
import { basename } from "node:path";
import { cosineVec, jaccard } from "./core.ts";
import { lifecycleVerdict } from "./judges.ts";
import { trail } from "./trail.ts";
import { loadBlocks, loadLifecycle, rewriteBlocks, saveLifecycle, statusOf, type Block, type BlockStatus, type Supersession } from "./store.ts";

// ── verdict vocabulary (token-exact — tokens() lowercases and strips stopwords,
//    and the hybrid field spans EVERY user turn + tail-3 full turns, so markers
//    anywhere in the block are visible even though `head` is only turn one) ──

const HEDGE_TOKENS = new Set([
	"maybe", "someday", "perhaps", "possibly", "potentially", "explore", "exploring", "explored",
	"consider", "considering", "consideration", "idea", "ideas", "commitment", "plans", "floating", "tentative",
]);
const ATTEMPT_TOKENS = new Set(["try", "tried", "trying", "attempt", "attempted", "attempting"]); // not "attempts" — "3 attempts" is a config, not an attempt record
const OUTCOME_TOKENS = new Set(["failed", "revert", "reverts", "reverted", "reverting", "rolled", "rollback", "broke", "broken", "abandon", "abandoned"]);
const REVERSAL_TOKENS = new Set([
	"switched", "switching", "switch", "replaced", "replaces", "replace", "replacing", "dropped", "drop",
	"retired", "retire", "removed", "remove", "deprecated", "moved", "instead", "obsolete", "abandoned", "abandon",
]);

/** Pair-overlap thresholds: bench-measured separation — same-topic supersession
 * pairs score jaccard ≥ 0.19, unrelated same-project pairs ≤ 0.13. */
const PAIR_JACCARD = 0.15;
const PAIR_DIMS_COSINE = 0.6;

export interface ConsolidationResult {
	scanned: number;
	already: number; // blocks carrying a non-valid status before this run
	assigned: { failed: string[]; speculative: string[]; superseded: string[] };
	supersessions: Supersession[];
	verdictSources: { typellm: number; jev: number; "heuristic-lexical": number };
	changed: number;
}

export function summaryLine(r: ConsolidationResult): string {
	const a = r.assigned;
	const total = a.failed.length + a.speculative.length + a.superseded.length;
	if (!total) return "consolidation: nothing to assign";
	const bits = [
		a.superseded.length ? `${a.superseded.length} superseded` : "",
		a.failed.length ? `${a.failed.length} failed` : "",
		a.speculative.length ? `${a.speculative.length} speculative` : "",
	].filter(Boolean);
	return `consolidation: ${total} block(s) assigned (${bits.join(", ")})`;
}

// ── verdict helpers (exported for selfcheck) ─────────────────────────────────

/** In-block verdict from the block's own hybrid tokens. Null = stays valid. */
export function inBlockVerdict(hybrid: Set<string>): Exclude<BlockStatus, "valid"> | null {
	const hedges = [...hybrid].filter((t) => HEDGE_TOKENS.has(t));
	if (hedges.length >= 2) return "speculative";
	const hasAttempt = [...hybrid].some((t) => ATTEMPT_TOKENS.has(t));
	const hasOutcome = [...hybrid].some((t) => OUTCOME_TOKENS.has(t));
	if (hasAttempt && hasOutcome) return "failed";
	return null;
}

function hasReversal(hybrid: Set<string>): boolean {
	return [...hybrid].some((t) => REVERSAL_TOKENS.has(t));
}

/** Recency key: the session FILE NAME timestamp is primary (pi names sessions
 * <ISO>.jsonl — deterministic, immune to copy/restore mtime reshuffling), then
 * ingest-time closedAt, then the file name. Ascending = older first. */
function recencyKey(b: Block): string {
	const base = basename(b.sessionFile);
	const digits = (s: string) => s.replace(/\D+/g, "");
	const m = base.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
	const fileTs = m ? digits(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`) : "";
	const closedTs = digits(b.closedAt || "");
	return `${(fileTs || closedTs).padEnd(17, "0")}|${closedTs.padEnd(17, "0")}|${base}`;
}

/** Text basis for judge calls: gist + head span the decision statements. */
function judgeText(b: Block): string {
	return [b.gist, b.head].filter(Boolean).join("\n") || b.tokensHybrid.join(" ");
}

// ── the pass ──────────────────────────────────────────────────────────────────

export async function runConsolidation(
	target: string | { blocksDir?: string; blocks?: Block[] } = {},
): Promise<ConsolidationResult> {
	const opts = typeof target === "string" ? { blocksDir: target } : target;
	// blocksDir is honored implicitly: every store helper reads MAJORDOME_DIR /
	// homedir at call time; callers aiming elsewhere set the env (the bench does).
	void opts.blocksDir;
	const blocks = opts.blocks ?? loadBlocks();
	const result: ConsolidationResult = {
		scanned: blocks.length,
		already: 0,
		assigned: { failed: [], speculative: [], superseded: [] },
		supersessions: [],
		verdictSources: { typellm: 0, jev: 0, "heuristic-lexical": 0 },
		changed: 0,
	};
	if (!blocks.length) return result;

	const status = new Map<string, BlockStatus>();
	for (const b of blocks) {
		const s = statusOf(b);
		status.set(b.id, s);
		if (s !== "valid") result.already++;
	}

	// ── pass 1: in-block outcome + hedging (recorded as heuristic verdicts) ──
	for (const b of blocks) {
		if (status.get(b.id) !== "valid") continue;
		const v = inBlockVerdict(new Set(b.tokensHybrid));
		if (!v) continue;
		status.set(b.id, v);
		result.assigned[v].push(b.id);
		result.changed++;
		result.verdictSources["heuristic-lexical"]++;
		trail("consolidate", { block: b.id, status: v, source: "heuristic-lexical", verdict: v === "failed" ? "tried-and-failed" : "hedged-future" });
	}

	// ── pass 2: same-topic supersession pairs over the still-valid blocks ────
	const valid = blocks.filter((b) => status.get(b.id) === "valid").sort((a, b) => recencyKey(a).localeCompare(recencyKey(b)));
	const n = valid.length;
	const df = new Map<string, number>();
	for (const b of valid) for (const t of new Set(b.tokensHybrid)) df.set(t, (df.get(t) ?? 0) + 1);
	const rareCap = Math.max(2, Math.ceil(n * 0.3)); // shared terms must be topic-distinctive, not project boilerplate
	const hybridOf = (b: Block) => new Set(b.tokensHybrid);
	const dimsVec = (b: Block) => (b.dims && Object.keys(b.dims).length ? new Map(Object.entries(b.dims)) : null);

	interface Candidate {
		older: Block;
		newer: Block;
		affinity: number;
		rareShared: string[];
	}
	const candidates: Candidate[] = [];
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			// valid[] is recency-ascending → i is the older side
			const older = valid[i];
			const newer = valid[j];
			if (recencyKey(older) === recencyKey(newer)) continue;
			const a = hybridOf(older);
			const bv = hybridOf(newer);
			let affinity = jaccard(a, bv);
			const da = dimsVec(older);
			const db = dimsVec(newer);
			if (da && db) affinity = Math.max(affinity, cosineVec(da, db));
			// candidate on lexical topic overlap, or on dims cosine when both carry dims
			if (affinity < PAIR_JACCARD && !(da && db && affinity >= PAIR_DIMS_COSINE)) continue;
			const rareShared = [...a].filter((t) => bv.has(t) && (df.get(t) ?? 0) <= rareCap);
			if (!rareShared.length) continue;
			if (!hasReversal(bv) && !(newer.gist ?? "").match(/\b(no longer|instead of|replaced by|supersed\w*)\b/i)) continue;
			candidates.push({ older, newer, affinity, rareShared });
		}
	}
	// strongest evidence first; a newer supersedes at most one older, an older
	// is demoted once — no cascades, deterministic order
	candidates.sort((x, y) => y.affinity - x.affinity || x.older.id.localeCompare(y.older.id) || x.newer.id.localeCompare(y.newer.id));
	const newerUsed = new Set<string>();
	for (const c of candidates) {
		if (newerUsed.has(c.newer.id)) continue;
		if (status.get(c.older.id) !== "valid") continue;
		if (status.get(c.newer.id) !== "valid") continue;

		// judge seam first (TypeLLM → Jev, fail-open null) — lexical fallback
		let verdict = "contradicts";
		let source: Supersession["source"] = "heuristic-lexical";
		let failedToo = false;
		try {
			const jv = await lifecycleVerdict(judgeText(c.older), judgeText(c.newer));
			if (jv) {
				if (!jv.contradicts && !jv.triedAndFailed) {
					trail("consolidate", { pair: [c.older.id, c.newer.id], verdict: "compatible", source: "judge", affinity: Math.round(c.affinity * 100) / 100 });
					continue; // the judge actively cleared this pair — no demotion
				}
				verdict = jv.triedAndFailed ? "tried-and-failed" : "contradicts";
				failedToo = jv.triedAndFailed;
				source = "typellm";
				result.verdictSources.typellm++;
			}
		} catch {
			// judge seam failed open → lexical verdict below
		}
		const newStatus: BlockStatus = failedToo ? "failed" : "superseded";
		status.set(c.older.id, newStatus);
		newerUsed.add(c.newer.id);
		result.assigned[newStatus].push(c.older.id);
		result.changed++;
		const link: Supersession = { older: c.older.id, newer: c.newer.id, verdict, source };
		result.supersessions.push(link);
		trail("consolidate", { pair: [c.older.id, c.newer.id], status: newStatus, verdict, source, affinity: Math.round(c.affinity * 100) / 100, shared: c.rareShared.slice(0, 4) });
	}

	// ── persist: stamp records + sidecar artifact ─────────────────────────────
	if (result.changed || result.supersessions.length) {
		for (const b of blocks) {
			const s = status.get(b.id) ?? "valid";
			if (s !== statusOf(b)) {
				if (s === "valid") delete b.status;
				else b.status = s;
			}
		}
		rewriteBlocks(blocks);
	}
	const prev = loadLifecycle();
	const supersessions = [...prev.supersessions];
	for (const link of result.supersessions) if (!supersessions.some((l) => l.older === link.older && l.newer === link.newer)) supersessions.push(link);
	const statuses: Record<string, BlockStatus> = { ...prev.statuses };
	for (const b of blocks) statuses[b.id] = status.get(b.id) ?? "valid";
	saveLifecycle({ statuses, supersessions });
	return result;
}
