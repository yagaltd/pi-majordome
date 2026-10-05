/**
 * Lifecycle bench (v2.4 bench-before-build; v2.5 IR + LongMemEval + scale) —
 * measure the memory-lifecycle feature, so the implementation lands against a
 * fixed bar.
 *
 * Pipeline (fully isolated — NEVER touches ~/.pi/majordome):
 *   1. generate lifecycle fixtures into a temp dir (planted ground truth:
 *      4 supersession chains, 3 tried-and-failed, 4 valid controls,
 *      2 speculative — see tools/gen_lifecycle_fixtures.ts)
 *   2. run the repo's REAL init/ingestion over them with HOME + MAJORDOME_DIR
 *      + MAJORDOME_INIT_STATE pointed at a mktemp-style sandbox (init.ts reads
 *      sessions from $HOME/.pi/agent/sessions at import time; store.ts
 *      honors MAJORDOME_DIR at call time; judges fail open without a key, so
 *      the run is hermetic — no network, no real-store writes)
 *   3. run consolidation IF implemented (detect ext/consolidate.ts or a
 *      runConsolidation export; else report `consolidation: absent`)
 *   4. grade against fixtures_manifest.json:
 *        stateAccuracy per class (valid/superseded/failed/speculative)
 *        falseDemotions on valid controls   (must be 0)
 *        supersessionPairRecall             (older superseded + newer valid)
 *        leakRate: neutral recall must NOT surface failed/superseded blocks;
 *                  failure-intent recall MUST surface them
 *      Recall runs through the REAL router (ext/router.ts route(): time-travel
 *      filter + lifecycle scope + federated BM25) with canned intent/dims
 *      judges for determinism — the thing under test is the status filter +
 *      consolidation, not the judge DAG.
 *
 * v2.5 additions (same invocation, same hermetic sandbox):
 *   IR RANKING METRICS — per-probe + aggregate Recall@5, Recall@10, MRR and
 *     nDCG@10 (binary relevance) over every probe that carries expected refs
 *     (neutral expectValidRefs, failure requiredRefs, temporal old refs,
 *     aggregation cross-session refs). Abstention probes carry no expected
 *     refs and are excluded from IR aggregation.
 *   LONGMEMEVAL ABILITY CATEGORIES —
 *     temporal    ("what did we decide before X?") → ≥1 specific OLD
 *                 (superseded) ref in the ranked results; routing via
 *                 TEMPORAL_INTENT_RE includes + prefers superseded, never
 *                 failed (failures stay failure-intent-only)
 *     aggregation (answer spans two valid blocks in DIFFERENT sessions — the
 *                 federated per-session top-3 round-robin is the mechanism)
 *                 → both refs in top-k
 *     abstention  (topics absent from the corpus) → zero hits above the
 *                 score floor. v2.5 recon found NO floor existed: route()
 *                 ranked and crowned winners at score 0. Minimal fix
 *                 implemented in router.ts: results with score ≤ 0 (no
 *                 shared non-stopword token) are not recall hits — reported
 *                 as a spec deviation (small, obviously-correct product fix).
 * v2.6 additions (same invocation, same hermetic sandbox):
 *   @SLUG HARD-SCOPE PROBES + CROSS-SLUG CORPUS — the generator adds a second
 *     project (other-project*, kestrel-dashboard templates: same generic
 *     vocabulary as the main corpus, disjoint specifics) so scoped queries
 *     have topically-similar cross-slug blocks to NOT bleed into. Probes:
 *     (a) @slug-scoped query on a MAIN slug ranks only main-slug blocks;
 *     (b) scoped to other-project ranks only its blocks (case-insensitive
 *     @token covered); (c) an UNscoped query on the other project's topic
 *     must NOT hard-exclude main blocks — no @token, no hard scope, priors
 *     still rank. PRE-REGISTERED GATES: '@slug hard scope: 0 cross-slug
 *     leaks, ≥1 expected ref per scoped probe' and '@slug unscoped: no hard
 *     exclusion without @token (main refs still ranked)'. Slug probes are
 *     graded separately and do NOT enter the v2.5 IR aggregates (those bars
 *     stay apples-to-apples).
 *   SCALE KNOB — tier two regenerates the corpus with 60 deterministic filler
 *     distractor sessions (gen_lifecycle_fixtures --scale 60, plus
 *     other-project filler sessions) and reruns every gate over the larger
 *     corpus, plus scale-specific bars.
 *
 * PRE-REGISTERED BAR (agreed spec, fixed before any implementation exists):
 *   state accuracy            ≥ 90% per class
 *   false demotions           =  0  (valid controls never demoted)
 *   supersession pair recall  ≥ 80%
 *   leak rate                 ≤ 10% (neutral recall never leaks excluded
 *                                  states) — both tiers
 *   IR: Recall@5 ≥ 0.80 · MRR ≥ 0.60 · nDCG@10 ≥ 0.70 (probes with
 *       expected refs) — both tiers
 *   temporal: every temporal probe surfaces ≥1 expected old ref = 100%
 *   aggregation: both refs in top-5 for every aggregation probe = 100%
 *   abstention: 0 false hits (zero-overlap corpus asserted by the generator)
 *   @slug hard scope: 0 cross-slug leaks, ≥1 expected ref per scoped probe —
 *                    both tiers (scoped queries rank ONLY the named slug's
 *                    blocks; lifecycle + intent scopes still apply on top)
 *   @slug unscoped:  no hard exclusion without @token — every unscoped
 *                    other-topic probe still ranks ≥1 expected main ref
 *   scale tier adds: Recall@10 ≥ 0.70 and leak ≤ 10% at scale
 * Gates apply once consolidation exists; otherwise the bench reports honestly:
 *   implementation absent — baseline n/a. The recall leak/failure checks still
 *   run as diagnostics so the pre-implementation leak is on record.
 *
 *   npx tsx tools/lifecyclebench.ts
 *
 * Exit codes: 0 = completed (implementation absent → n/a verdict, or all gates
 * pass); 1 = one or more pre-registered gates failed (only possible once
 * consolidation exists); 2 = isolation/infrastructure failure (bench itself
 * broken — never a verdict about the feature).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { tokens } from "../ext/core.ts";
import { generateLifecycleFixtures, REAL_SANITY_PAIRS, type LifecycleManifest, type LifecycleStatus } from "./gen_lifecycle_fixtures.ts";

const SCALE_SESSIONS = 60; // v2.5 scale tier: filler distractor sessions

const realHome = process.env.HOME ?? homedir();
const tmpRoot = mkdtempSync(join(tmpdir(), "lifecyclebench-"));
const tmpHome = join(tmpRoot, "home");
const mjdDir = join(tmpHome, "majordome");

// ── env isolation BEFORE any ext module import (init.ts reads $HOME at
//    import time; every store/judge path honors the overrides at call time) ──
process.env.HOME = tmpHome;
process.env.MAJORDOME_DIR = mjdDir;
process.env.MAJORDOME_INIT_STATE = join(mjdDir, "init.json");
process.env.MAJORDOME_KEY_FILE = join(tmpRoot, "no-key-on-purpose"); // missing → judges fail open, zero network
process.env.MAJORDOME_TRAIL_FILE = join(mjdDir, "trails.jsonl");
delete process.env.TYPELLM_API_KEY;

const { loadBlocks, majordomeDir } = await import("../ext/store.ts");
const { initRepo } = await import("../ext/init.ts");
const { route } = await import("../ext/router.ts");

// ── hard isolation guard: the bench must never touch the real brain ─────────
function assertIsolated() {
	if (!majordomeDir().startsWith(tmpRoot) || majordomeDir().startsWith(realHome)) {
		console.error(`FATAL: isolated MAJORDOME_DIR escaped the sandbox (${majordomeDir()})`);
		process.exit(2);
	}
	if (majordomeDir() === join(realHome, ".pi", "majordome")) {
		console.error("FATAL: MAJORDOME_DIR resolves to the real ~/.pi/majordome");
		process.exit(2);
	}
}
assertIsolated();

const slugOfSession = (s: string) => s.replace(/^lineage:/, "");

// block id for a plant ref — join manifest ground truth to ingested blocks
function blockForPlant(blocks: Awaited<ReturnType<typeof loadBlocks>>, p: LifecycleManifest["plants"][number]) {
	return blocks.find((b) => slugOfSession(b.session) === p.sessionSlug && b.firstTurn === p.blockFirstTurn) ?? null;
}

/** Best-effort read of lifecycle artifacts the implementation may write into
 * the store dir. Accepted shapes (any of):
 *   <dir>/lifecycle.json | supersessions.json
 *   Record<blockId, status>  |  { statuses: Record<blockId,status>, supersessions: [{older,newer}] }
 *   [{ id, status }]         |  { pairs: [{older,newer}] }
 */
function readLifecycleArtifacts(dir: string): { statuses: Record<string, LifecycleStatus>; links: { older: string; newer: string }[] } {
	const out: { statuses: Record<string, LifecycleStatus>; links: { older: string; newer: string }[] } = { statuses: {}, links: [] };
	const ok = (s: unknown): s is LifecycleStatus => s === "valid" || s === "superseded" || s === "failed" || s === "speculative";
	const absorb = (json: any) => {
		if (!json || typeof json !== "object") return;
		if (Array.isArray(json)) {
			for (const e of json) if (e?.id && ok(e.status)) out.statuses[e.id] = e.status;
			return;
		}
		if (json.statuses && typeof json.statuses === "object") {
			for (const [id, s] of Object.entries(json.statuses)) if (ok(s)) out.statuses[id] = s;
		}
		if (Array.isArray(json.supersessions)) out.links.push(...json.supersessions.filter((l: any) => l?.older && l?.newer));
		if (Array.isArray(json.pairs)) out.links.push(...json.pairs.filter((l: any) => l?.older && l?.newer));
		if (!json.statuses && !json.supersessions && !json.pairs) {
			// bare Record<blockId, status>
			for (const [id, s] of Object.entries(json)) if (ok(s)) out.statuses[id] = s;
		}
	};
	for (const name of ["lifecycle.json", "supersessions.json"]) {
		const f = join(dir, name);
		if (!existsSync(f)) continue;
		try {
			absorb(JSON.parse(readFileSync(f, "utf8")));
		} catch {
			/* corrupt artifact — ignore, statuses may still live on blocks */
		}
	}
	return out;
}

function actualStatus(b: { id: string } & Record<string, unknown>, artifacts: { statuses: Record<string, LifecycleStatus> }): LifecycleStatus | "unassigned" {
	const s = (b as any).status ?? artifacts.statuses[b.id];
	return s ?? "unassigned";
}

// ── IR ranking metrics (v2.5) — binary relevance over graded probe refs ─────
function recallAtK(rankedRefs: string[], expected: string[], k: number): number {
	if (!expected.length) return 0;
	return expected.filter((r) => rankedRefs.slice(0, k).includes(r)).length / expected.length;
}
function reciprocalRank(rankedRefs: string[], expected: string[]): number {
	for (let i = 0; i < rankedRefs.length; i++) if (expected.includes(rankedRefs[i])) return 1 / (i + 1);
	return 0;
}
function ndcgAtK(rankedRefs: string[], expected: string[], k: number): number {
	if (!expected.length) return 0;
	const dcg = rankedRefs.slice(0, k).reduce((s, r, i) => s + (expected.includes(r) ? 1 / Math.log2(i + 2) : 0), 0);
	let idcg = 0;
	for (let i = 0; i < Math.min(expected.length, k); i++) idcg += 1 / Math.log2(i + 2);
	return idcg ? dcg / idcg : 0;
}

// consolidation file detection is per-repo, not per-tier
const repoRoot = join(import.meta.dirname ?? "tools", "..");
async function detectConsolidationFile(): Promise<string | null> {
	const primary = join(repoRoot, "ext", "consolidate.ts");
	if (existsSync(primary)) return primary;
	for (const f of readdirSync(join(repoRoot, "ext"))) {
		if (!f.endsWith(".ts")) continue;
		const p = join(repoRoot, "ext", f);
		if (/export\s+(async\s+)?function\s+runConsolidation\b|export\s+const\s+runConsolidation\b/.test(readFileSync(p, "utf8"))) return p;
	}
	return null;
}
const consolidationFile = await detectConsolidationFile();

const routingIntent = async (q: string) => ({ intent: "incident_specific", searchTerms: q, needClarification: false, clarifyWhy: "" });
const queryDims = async (_q: string) => null; // lex arm (BM25) — hermetic

interface TierResult {
	name: string;
	scale: number;
	blocks: number;
	wallMs: number;
	consolidation: ConsolState;
	graded: { ref: string; expected: LifecycleStatus; actual: LifecycleStatus | "unassigned" | "missing"; control: boolean; blockId: string | null }[];
	stateAccuracy: Record<LifecycleStatus, { correct: number; total: number; accuracy: number | null }>;
	falseDemotions: number;
	validDemoted: number;
	pairResults: { id: string; older: string; newer: string; recalled: boolean; linked: boolean }[];
	pairRecall: number;
	leakRate: number;
	neutralLeaks: number;
	neutralRanked: number;
	neutralRows: any[];
	failureHit: number;
	failureRows: any[];
	failureAppearance: number;
	ir: { probes: number; recall5: number; recall10: number; mrr: number; ndcg10: number; perProbe: { id: string; expected: string[]; ranks: number[]; recall5: number; recall10: number; mrr: number; ndcg10: number }[] };
	temporal: { rows: { id: string; query: string; expectedOldRefs: string[]; found: string[] }[]; passRate: number };
	aggregation: { rows: { id: string; query: string; expectedRefs: string[]; ranks: (number | null)[]; bothInTop5: boolean }[]; passRate: number; maxRankNeeded: number };
	abstention: { rows: { id: string; query: string; hits: number }[]; falseHits: number; floorPresent: boolean };
	slug: {
		rows: { id: string; query: string; scope: string; expectedRefs: string[]; found: string[]; leaks: string[] }[];
		unscopedRows: { id: string; query: string; expectMainRefs: string[]; found: string[] }[];
		leaks: number;
		scopedFound: number;
		scopedTotal: number;
		unscopedFound: number;
		unscopedTotal: number;
	};
	gates: { name: string; value: string; pass: boolean }[];
}
type ConsolState = { status: "absent" | "present" | "ran" | "ran-with-errors"; file?: string; exportName?: string; detail?: string };

async function runTier(tierName: string, scale: number, storeDir: string, initState: string, trailFile: string): Promise<TierResult> {
	const t0 = performance.now();
	// per-tier store isolation (store helpers read these at call time)
	process.env.MAJORDOME_DIR = storeDir;
	process.env.MAJORDOME_INIT_STATE = initState;
	process.env.MAJORDOME_TRAIL_FILE = trailFile;
	assertIsolated();

	console.log(`\n━━━ tier: ${tierName} (scale=${scale}) ━━━`);

	// ── 1. fixtures ───────────────────────────────────────────────────────────
	const fixturesDir = join(tmpRoot, `fixtures-${scale ? "scale" : "small"}`);
	const manifest = generateLifecycleFixtures(fixturesDir, scale);
	console.log(`fixtures: ${manifest.sessions.length} planted sessions + ${manifest.filler.count} filler sessions, ${manifest.plants.length} planted blocks, ${manifest.supersessionPairs.length} supersession pairs`);
	const plantsByRef = new Map(manifest.plants.map((p) => [p.ref, p]));

	// ── 2. real ingestion over the fixture corpus, isolated HOME + store ──────
	const sessionsDir = join(tmpHome, ".pi", "agent", "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	mkdirSync(storeDir, { recursive: true });
	cpSync(join(fixturesDir, "sessions"), sessionsDir, { recursive: true });
	const initReport = await initRepo({ cwd: join(tmpRoot, "project"), slug: "lcb01", lineage: "all", noDims: true });
	console.log(`ingestion: ${initReport}`);
	let blocks = loadBlocks();
	if (!blocks.length) {
		console.error("FATAL: ingestion produced 0 blocks — bench infrastructure broken");
		process.exit(2);
	}
	console.log(`store: ${blocks.length} blocks in ${majordomeDir()} (isolated; real store untouched)`);

	// ── 3. consolidation, if implemented ──────────────────────────────────────
	let consolidation: ConsolState = { status: "absent" };
	if (consolidationFile) {
		try {
			const mod: any = await import(consolidationFile);
			const fn = mod.runConsolidation ?? mod.consolidate;
			if (typeof fn !== "function") consolidation = { status: "present", file: basename(consolidationFile), detail: "no callable runConsolidation export found" };
			else {
				await fn({ blocksDir: majordomeDir(), blocks });
				consolidation = { status: "ran", file: basename(consolidationFile), exportName: mod.runConsolidation ? "runConsolidation" : "consolidate" };
			}
		} catch (e) {
			consolidation = { status: "ran-with-errors", file: basename(consolidationFile), detail: String((e as Error)?.message ?? e) };
		}
	}
	blocks = loadBlocks(); // re-read: consolidation may have stamped statuses
	const artifacts = readLifecycleArtifacts(majordomeDir());

	// ── 4. recall probes through the REAL router (canned judges, deterministic)
	async function recall(query: string) {
		return route({
			userMessage: query,
			blocks,
			currentSession: "__lifecyclebench__",
			currentTurn: 99999,
			routingIntent,
			queryDims,
			tokens,
		});
	}

	const refOfBlock = new Map<string, string>();
	for (const b of blocks) {
		const plant = manifest.plants.find((p) => p.sessionSlug === slugOfSession(b.session) && p.blockFirstTurn === b.firstTurn);
		if (plant) refOfBlock.set(b.id, plant.ref);
	}
	const rankedRefs = (r: Awaited<ReturnType<typeof recall>>) => (r?.ranked ?? []).map((s) => refOfBlock.get(s.block.id)).filter(Boolean) as string[];
	const leakedBy = (r: Awaited<ReturnType<typeof recall>>) =>
		(r?.ranked ?? [])
			.map((s) => ({ ref: refOfBlock.get(s.block.id), expected: plantsByRef.get(refOfBlock.get(s.block.id) ?? "")?.expectedStatus }))
			.filter((x) => x.expected === "failed" || x.expected === "superseded");

	let neutralRanked = 0;
	let neutralLeaks = 0;
	const neutralRows: any[] = [];
	for (const probe of manifest.recallProbes.neutral) {
		const r = await recall(probe.query);
		const leaks = leakedBy(r);
		neutralRanked += r?.ranked.length ?? 0;
		neutralLeaks += leaks.length;
		neutralRows.push({ id: probe.id, query: probe.query, returned: r?.ranked.length ?? 0, leakedRefs: leaks.map((l) => l.ref) });
	}
	const leakRate = neutralRanked ? neutralLeaks / neutralRanked : 0;

	const failureRows: any[] = [];
	let failureHit = 0;
	for (const probe of manifest.recallProbes.failureIntent) {
		const r = await recall(probe.query);
		const found = probe.requiredRefs.filter((ref) => rankedRefs(r).includes(ref));
		if (found.length) failureHit++;
		failureRows.push({ id: probe.id, query: probe.query, requiredRefs: probe.requiredRefs, foundRefs: found });
	}
	const failureAppearance = failureRows.length ? failureHit / failureRows.length : 0;

	// ── 4b. v2.5 LongMemEval categories ───────────────────────────────────────
	const temporalRows: TierResult["temporal"]["rows"] = [];
	for (const probe of manifest.temporalProbes) {
		const refs = rankedRefs(await recall(probe.query));
		temporalRows.push({ id: probe.id, query: probe.query, expectedOldRefs: probe.expectedOldRefs, found: probe.expectedOldRefs.filter((r) => refs.includes(r)) });
	}
	const temporalPassRate = temporalRows.length ? temporalRows.filter((r) => r.found.length >= 1).length / temporalRows.length : 0;

	const aggregationRows: TierResult["aggregation"]["rows"] = [];
	let aggMaxRankNeeded = 0;
	for (const probe of manifest.aggregationProbes) {
		const refs = rankedRefs(await recall(probe.query));
		const ranks = probe.expectedRefs.map((r) => {
			const idx = refs.indexOf(r);
			return idx < 0 ? null : idx + 1;
		});
		const bothInTop5 = ranks.every((r) => r !== null && r <= 5);
		if (bothInTop5) aggMaxRankNeeded = Math.max(aggMaxRankNeeded, ...ranks.filter((r): r is number => r !== null));
		aggregationRows.push({ id: probe.id, query: probe.query, expectedRefs: probe.expectedRefs, ranks, bothInTop5 });
	}
	const aggregationPassRate = aggregationRows.length ? aggregationRows.filter((r) => r.bothInTop5).length / aggregationRows.length : 0;

	const abstentionRows: TierResult["abstention"]["rows"] = [];
	for (const probe of manifest.abstentionProbes) {
		const r = await recall(probe.query);
		abstentionRows.push({ id: probe.id, query: probe.query, hits: r?.ranked.length ?? 0 });
	}
	const abstentionFalseHits = abstentionRows.reduce((s, r) => s + r.hits, 0);

	// ── 4d. v2.6 @slug hard scope ─────────────────────────────────────────────
	// A scoped query must rank ONLY the named slug's blocks: any ranked block
	// from another slug is a cross-slug leak (the other-project corpus is
	// topically similar on purpose — that is the bleed being measured). The
	// unscoped same-topic probe asserts the opposite: without an @token there is
	// no hard scope and main blocks still rank via the normal priors.
	const slugRows: TierResult["slug"]["rows"] = [];
	let slugLeaks = 0;
	let slugScopedFound = 0;
	for (const probe of [...manifest.slugProbes.scopedMain, ...manifest.slugProbes.scopedOther]) {
		const r = await recall(probe.query);
		const refs = rankedRefs(r);
		const found = probe.expectedRefs.filter((ref) => refs.includes(ref));
		const leaks = (r?.ranked ?? [])
			.filter((s) => slugOfSession(s.block.session).toLowerCase() !== probe.scope.toLowerCase())
			.map((s) => slugOfSession(s.block.session));
		slugLeaks += leaks.length;
		if (found.length) slugScopedFound++;
		slugRows.push({ id: probe.id, query: probe.query, scope: probe.scope, expectedRefs: probe.expectedRefs, found, leaks: [...new Set(leaks)] });
	}
	const slugUnscopedRows: TierResult["slug"]["unscopedRows"] = [];
	let slugUnscopedFound = 0;
	for (const probe of manifest.slugProbes.unscopedOtherTopic) {
		const refs = rankedRefs(await recall(probe.query));
		const found = probe.expectMainRefs.filter((ref) => refs.includes(ref));
		if (found.length) slugUnscopedFound++;
		slugUnscopedRows.push({ id: probe.id, query: probe.query, expectMainRefs: probe.expectMainRefs, found });
	}

	// ── 4c. IR ranking metrics over probes WITH expected refs ─────────────────
	const irPerProbe: TierResult["ir"]["perProbe"] = [];
	const irProbe = (id: string, expected: string[], refs: string[]) => {
		if (!expected.length) return;
		irPerProbe.push({ id, expected, ranks: expected.map((r) => { const i = refs.indexOf(r); return i < 0 ? -1 : i + 1; }), recall5: recallAtK(refs, expected, 5), recall10: recallAtK(refs, expected, 10), mrr: reciprocalRank(refs, expected), ndcg10: ndcgAtK(refs, expected, 10) });
	};
	for (const p of manifest.recallProbes.neutral) irProbe(p.id, p.expectValidRefs, rankedRefs(await recall(p.query)));
	for (const p of manifest.recallProbes.failureIntent) irProbe(p.id, p.requiredRefs, rankedRefs(await recall(p.query)));
	for (const p of manifest.temporalProbes) irProbe(p.id, p.expectedOldRefs, rankedRefs(await recall(p.query)));
	for (const p of manifest.aggregationProbes) irProbe(p.id, p.expectedRefs, rankedRefs(await recall(p.query)));
	const ir = {
		probes: irPerProbe.length,
		recall5: irPerProbe.length ? irPerProbe.reduce((s, p) => s + p.recall5, 0) / irPerProbe.length : 0,
		recall10: irPerProbe.length ? irPerProbe.reduce((s, p) => s + p.recall10, 0) / irPerProbe.length : 0,
		mrr: irPerProbe.length ? irPerProbe.reduce((s, p) => s + p.mrr, 0) / irPerProbe.length : 0,
		ndcg10: irPerProbe.length ? irPerProbe.reduce((s, p) => s + p.ndcg10, 0) / irPerProbe.length : 0,
		perProbe: irPerProbe,
	};

	// ── 5. grading against the manifest ───────────────────────────────────────
	const graded = manifest.plants.map((p) => {
		const b = blockForPlant(blocks, p);
		const actual = b ? actualStatus(b, artifacts) : "missing";
		return { ref: p.ref, expected: p.expectedStatus, actual, control: p.expectedStatus === "valid" && p.label.includes("(control)"), blockId: b?.id ?? null };
	});

	const classes: LifecycleStatus[] = ["valid", "superseded", "failed", "speculative"];
	const stateAccuracy = Object.fromEntries(
		classes.map((c) => {
			const rows = graded.filter((g) => g.expected === c);
			const ok = rows.filter((g) => g.actual === g.expected).length;
			return [c, { correct: ok, total: rows.length, accuracy: rows.length ? ok / rows.length : null }];
		}),
	) as Record<LifecycleStatus, { correct: number; total: number; accuracy: number | null }>;

	const validControls = graded.filter((g) => g.control);
	const falseDemotions = validControls.filter((g) => g.actual === "superseded" || g.actual === "failed").length;
	const validDemoted = graded.filter((g) => g.expected === "valid" && (g.actual === "superseded" || g.actual === "failed")).length;
	const pairResults = manifest.supersessionPairs.map((pair) => {
		const older = graded.find((g) => g.ref === pair.older)!;
		const newer = graded.find((g) => g.ref === pair.newer)!;
		const recalled = older.actual === "superseded" && newer.actual === "valid";
		const linked = artifacts.links.some((l) => (l.older === older.blockId && l.newer === newer.blockId) || (l.older === pair.older && l.newer === pair.newer));
		return { id: pair.id, older: pair.older, newer: pair.newer, recalled, linked };
	});
	const pairRecall = pairResults.length ? pairResults.filter((p) => p.recalled).length / pairResults.length : 0;

	const implemented = consolidation.status === "ran" || consolidation.status === "ran-with-errors";
	const gates = [
		{ name: "state accuracy ≥90% per class", value: Object.entries(stateAccuracy).map(([c, s]) => `${c}=${s.accuracy === null ? "n/a" : `${Math.round(s.accuracy * 100)}%`}`).join(" "), pass: implemented && classes.every((c) => (stateAccuracy[c].accuracy ?? 0) >= 0.9) },
		{ name: "false demotions = 0", value: `${falseDemotions} (valid controls)`, pass: implemented && falseDemotions === 0 },
		{ name: "supersession pair recall ≥80%", value: `${Math.round(pairRecall * 100)}% (${pairResults.filter((p) => p.recalled).length}/${pairResults.length})`, pass: implemented && pairRecall >= 0.8 },
		{ name: "leak rate ≤10%", value: `${Math.round(leakRate * 100)}% (${neutralLeaks}/${neutralRanked} ranked results)`, pass: implemented && leakRate <= 0.1 },
		{ name: "IR Recall@5 ≥0.80", value: `${ir.recall5.toFixed(3)} (${ir.probes} probes w/ expected refs)`, pass: implemented && ir.recall5 >= 0.8 },
		{ name: "IR MRR ≥0.60", value: ir.mrr.toFixed(3), pass: implemented && ir.mrr >= 0.6 },
		{ name: "IR nDCG@10 ≥0.70", value: ir.ndcg10.toFixed(3), pass: implemented && ir.ndcg10 >= 0.7 },
		{ name: "temporal: ≥1 old ref surfaced =100%", value: `${Math.round(temporalPassRate * 100)}% (${temporalRows.filter((r) => r.found.length).length}/${temporalRows.length})`, pass: implemented && temporalPassRate === 1 },
		{ name: "aggregation: both refs in top-5 =100%", value: `${Math.round(aggregationPassRate * 100)}% (${aggregationRows.filter((r) => r.bothInTop5).length}/${aggregationRows.length})`, pass: implemented && aggregationPassRate === 1 },
		{ name: "abstention: 0 false hits", value: `${abstentionFalseHits} hits across ${abstentionRows.length} absent-topic probes (score floor: ${consolidationFile ? "present" : "n/a — router ranks score-0 blocks"})`, pass: implemented && abstentionFalseHits === 0 },
		{ name: "@slug hard scope: 0 cross-slug leaks, ≥1 expected ref per scoped probe", value: `${slugLeaks} leaks · ${slugScopedFound}/${slugRows.length} scoped probes with expected ref (${slugRows.filter((r) => r.leaks.length).length} leaking)`, pass: implemented && slugLeaks === 0 && slugScopedFound === slugRows.length },
		{ name: "@slug unscoped: no hard exclusion without @token (main refs still ranked)", value: `${slugUnscopedFound}/${slugUnscopedRows.length} unscoped probes keeping main refs ranked`, pass: implemented && slugUnscopedFound === slugUnscopedRows.length },
	];
	if (scale > 0) {
		gates.push({ name: "scale: IR Recall@10 ≥0.70", value: ir.recall10.toFixed(3), pass: implemented && ir.recall10 >= 0.7 });
	}

	return {
		name: tierName,
		scale,
		blocks: blocks.length,
		wallMs: performance.now() - t0,
		consolidation,
		graded,
		stateAccuracy,
		falseDemotions,
		validDemoted,
		pairResults,
		pairRecall,
		leakRate,
		neutralLeaks,
		neutralRanked,
		neutralRows,
		failureHit,
		failureRows,
		failureAppearance,
		ir,
		temporal: { rows: temporalRows, passRate: temporalPassRate },
		aggregation: { rows: aggregationRows, passRate: aggregationPassRate, maxRankNeeded: aggMaxRankNeeded },
		abstention: { rows: abstentionRows, falseHits: abstentionFalseHits, floorPresent: !!consolidationFile },
		slug: { rows: slugRows, unscopedRows: slugUnscopedRows, leaks: slugLeaks, scopedFound: slugScopedFound, scopedTotal: slugRows.length, unscopedFound: slugUnscopedFound, unscopedTotal: slugUnscopedRows.length },
		gates,
	};
}

// ── run both tiers in one invocation ─────────────────────────────────────────
console.log(`lifecycle bench (v2.6 @slug hard scope + IR + LongMemEval + scale) — sandbox ${tmpRoot}`);

const small = await runTier("small (mechanism corpus, untouched)", 0, mjdDir, join(mjdDir, "init.json"), join(mjdDir, "trails.jsonl"));
const scaleDir = join(tmpRoot, "store-scale");
const scale = await runTier("scale (distractor corpus)", SCALE_SESSIONS, scaleDir, join(scaleDir, "init.json"), join(scaleDir, "trails.jsonl"));
assertIsolated(); // scale env switch must never have escaped the sandbox

// ── report ───────────────────────────────────────────────────────────────────
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
console.log(`
──────────────── lifecycle bench report (v2.6) ────────────────`);
for (const tier of [small, scale]) {
	console.log(`
── tier: ${tier.name} — ${tier.blocks} blocks, runtime ${fmtMs(tier.wallMs)} ──`);
	console.log(`consolidation: ${tier.consolidation.status}${tier.consolidation.file ? ` (${tier.consolidation.file}${tier.consolidation.exportName ? `::${tier.consolidation.exportName}` : ""})` : ""}${tier.consolidation.detail ? ` — ${tier.consolidation.detail}` : ""}`);
	console.log(`block states: ${tier.graded.filter((g) => g.actual !== "unassigned").length}/${tier.graded.length} assigned, artifact links: ${tier.pairResults.filter((p) => p.linked).length}`);
	const implemented = tier.consolidation.status === "ran" || tier.consolidation.status === "ran-with-errors";
	if (!implemented) {
		console.log(`
PRE-REGISTERED BAR (applies once consolidation exists):
  state accuracy ≥90% per class · false demotions = 0 · supersession recall ≥80% · leak ≤10%
  IR: Recall@5 ≥0.80 · MRR ≥0.60 · nDCG@10 ≥0.70 · temporal/aggregation/abstention gates (see header)
VERDICT: implementation absent — baseline n/a (all gates ungraded)`);
		console.log(`
pre-implementation recall diagnostics (honest record, NOT gates):
  neutral recall leak:   ${tier.neutralLeaks}/${tier.neutralRanked} ranked results leak failed/superseded blocks (${Math.round(tier.leakRate * 100)}%)
  failure-intent recall: ${tier.failureHit}/${tier.failureRows.length} queries surface the failed blocks (${Math.round(tier.failureAppearance * 100)}%)`);
	} else {
		console.log(`
PRE-REGISTERED BAR → RESULTS`);
		for (const g of tier.gates) console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${g.name.padEnd(40)} ${g.value}`);
		const verdict = tier.gates.every((g) => g.pass);
		console.log(`VERDICT (${tier.name}): ${verdict ? "PASS — all pre-registered gates met" : "FAIL — pre-registered gates not met"}`);
	}
	// per-class detail (compact)
	for (const c of ["valid", "superseded", "failed", "speculative"] as LifecycleStatus[]) {
		const s = tier.stateAccuracy[c];
		console.log(`  class ${c.padEnd(12)} ${s.correct}/${s.total} correct${s.accuracy === null ? "" : ` (${Math.round(s.accuracy * 100)}%)`}`);
	}
	console.log(`  IR per-probe ranks (1-based, -1 = not in ranked list):`);
	for (const p of tier.ir.perProbe) console.log(`    ${p.id.padEnd(18)} expected=${p.expected.join("+")} ranks=[${p.ranks.join(",")}] R@5=${p.recall5.toFixed(2)} MRR=${p.mrr.toFixed(2)}`);
	console.log(`  LongMemEval categories:`);
	for (const r of tier.temporal.rows) console.log(`    temporal    ${r.id.padEnd(14)} old refs found: ${r.found.length ? r.found.join(",") : "NONE"}`);
	for (const r of tier.aggregation.rows) console.log(`    aggregation ${r.id.padEnd(14)} ref ranks: [${r.ranks.map((x) => x ?? "—").join(",")}] both-in-top-5=${r.bothInTop5}`);
	for (const r of tier.abstention.rows) console.log(`    abstention  ${r.id.padEnd(14)} hits above floor: ${r.hits}`);
	for (const r of tier.slug.rows) console.log(`    slug-scoped ${r.id.padEnd(14)} scope=@${r.scope.padEnd(13)} found: ${r.found.length ? r.found.join(",") : "NONE"} · leaks: ${r.leaks.length ? r.leaks.join(",") : "0"}`);
	for (const r of tier.slug.unscopedRows) console.log(`    slug-unscpd ${r.id.padEnd(14)} main refs found: ${r.found.length ? r.found.join(",") : "NONE"} (must keep main ranked)`);
	if (tier.aggregation.maxRankNeeded) console.log(`  aggregation mechanism (federated per-session top-3 round-robin) comfortably meets k=${Math.max(3, tier.aggregation.maxRankNeeded)} (worst observed ref rank ${tier.aggregation.maxRankNeeded})`);
}

console.log(`
sanity (REAL historical pairs, informational, ungraded):`);
for (const p of REAL_SANITY_PAIRS) console.log(`  ${p.id}: "${p.olderClaim}" → ${p.olderExpected} | "${p.newerClaim}" → ${p.newerExpected}`);

const allGatesPass = [small, scale].every((t) => {
	const implemented = t.consolidation.status === "ran" || t.consolidation.status === "ran-with-errors";
	return !implemented || t.gates.every((g) => g.pass);
});
const anyImplemented = [small, scale].some((t) => t.consolidation.status === "ran" || t.consolidation.status === "ran-with-errors");

const summary = {
	date: new Date().toISOString(),
	version: "v2.6-slug-scope-ir-longmemeval-scale",
	verdict: !anyImplemented ? "implementation-absent-baseline-na" : allGatesPass ? "pass" : "fail",
	isolatedDir: mjdDir,
	tiers: [small, scale].map((t) => ({
		name: t.name, scale: t.scale, blocks: t.blocks, wallMs: Math.round(t.wallMs), consolidation: t.consolidation,
		metrics: {
			stateAccuracy: t.stateAccuracy, falseDemotions: t.falseDemotions, validDemotedAllValidPlants: t.validDemoted,
			supersessionPairRecall: t.pairRecall, pairResults: t.pairResults,
			leakRate: t.leakRate, neutralLeaks: t.neutralLeaks, neutralRanked: t.neutralRanked,
			failureAppearance: t.failureAppearance, neutralRows: t.neutralRows, failureRows: t.failureRows,
			ir: t.ir, temporal: t.temporal, aggregation: t.aggregation, abstention: t.abstention, slug: t.slug, gradedBlocks: t.graded,
		},
		gates: t.gates,
	})),
	gatesAllPass: allGatesPass,
};
mkdirSync(join(repoRoot, "bench", "results"), { recursive: true });
const outPath = join(repoRoot, "bench", "results", "lifecyclebench-last.json");
writeFileSync(outPath, JSON.stringify(summary, null, 1) + "\n");
console.log(`results → ${outPath}`);
process.exit(!anyImplemented ? 0 : allGatesPass ? 0 : 1);
