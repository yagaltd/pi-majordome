/**
 * Lifecycle bench (v2.4 bench-before-build) — measure the memory-lifecycle
 * feature BEFORE it exists, so the implementation lands against a fixed bar.
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
 *      filter + federated BM25) with canned intent/dims judges for determinism
 *      — the thing under test is the status filter + consolidation, not the
 *      judge DAG.
 *
 * PRE-REGISTERED BAR (agreed spec, fixed before any implementation exists):
 *   state accuracy            ≥ 90% per class
 *   false demotions           =  0  (valid controls never demoted)
 *   supersession pair recall  ≥ 80%
 *   leak rate                 ≤ 10% (neutral recall never leaks excluded states)
 * Gates apply once consolidation exists; today the bench reports honestly:
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
import { tokens } from "../ext/core.ts";
import { generateLifecycleFixtures, type LifecycleManifest, type LifecycleStatus } from "./gen_lifecycle_fixtures.ts";

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
if (!majordomeDir().startsWith(tmpRoot) || majordomeDir().startsWith(realHome)) {
	console.error(`FATAL: isolated MAJORDOME_DIR escaped the sandbox (${majordomeDir()})`);
	process.exit(2);
}
if (majordomeDir() === join(realHome, ".pi", "majordome")) {
	console.error("FATAL: MAJORDOME_DIR resolves to the real ~/.pi/majordome");
	process.exit(2);
}

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

// ── 1. fixtures ─────────────────────────────────────────────────────────────
console.log(`lifecycle bench (v2.4 bench-before-build) — sandbox ${tmpRoot}`);
const fixturesDir = join(tmpRoot, "fixtures");
const manifest = generateLifecycleFixtures(fixturesDir);
const plantsByRef = new Map(manifest.plants.map((p) => [p.ref, p]));
console.log(`fixtures: ${manifest.sessions.length} sessions, ${manifest.plants.length} planted blocks, ${manifest.supersessionPairs.length} supersession pairs`);

// ── 2. real ingestion over the fixture corpus, isolated HOME + store ────────
mkdirSync(join(tmpHome, ".pi", "agent", "sessions"), { recursive: true });
mkdirSync(mjdDir, { recursive: true });
cpSync(join(fixturesDir, "sessions"), join(tmpHome, ".pi", "agent", "sessions"), { recursive: true });
const initReport = await initRepo({ cwd: join(tmpRoot, "project"), slug: "lcb01", lineage: "all", noDims: true });
console.log(`ingestion: ${initReport}`);
let blocks = loadBlocks();
if (!blocks.length) {
	console.error("FATAL: ingestion produced 0 blocks — bench infrastructure broken");
	process.exit(2);
}
console.log(`store: ${blocks.length} blocks in ${majordomeDir()} (isolated; real store untouched)`);

// ── 3. consolidation, if implemented ────────────────────────────────────────
type ConsolState = { status: "absent" | "present" | "ran" | "ran-with-errors"; file?: string; exportName?: string; detail?: string };
async function detectAndRunConsolidation(): Promise<ConsolState> {
	const repoRoot = join(import.meta.dirname ?? "tools", "..");
	let file: string | null = null;
	const primary = join(repoRoot, "ext", "consolidate.ts");
	if (existsSync(primary)) file = primary;
	else {
		for (const f of readdirSync(join(repoRoot, "ext"))) {
			if (!f.endsWith(".ts")) continue;
			const p = join(repoRoot, "ext", f);
			if (/export\s+(async\s+)?function\s+runConsolidation\b|export\s+const\s+runConsolidation\b/.test(readFileSync(p, "utf8"))) {
				file = p;
				break;
			}
		}
	}
	if (!file) return { status: "absent" };
	try {
		const mod: any = await import(file);
		const fn = mod.runConsolidation ?? mod.consolidate;
		if (typeof fn !== "function") return { status: "present", file: basename(file), detail: "no callable runConsolidation export found" };
		await fn({ blocksDir: majordomeDir(), blocks: loadBlocks() });
		return { status: "ran", file: basename(file), exportName: mod.runConsolidation ? "runConsolidation" : "consolidate" };
	} catch (e) {
		return { status: "ran-with-errors", file: basename(file), detail: String((e as Error)?.message ?? e) };
	}
}
const consolidation = await detectAndRunConsolidation();
blocks = loadBlocks(); // re-read: consolidation may have stamped statuses
const artifacts = readLifecycleArtifacts(majordomeDir());

// ── 4. recall probes through the REAL router (canned judges, deterministic) ─
const routingIntent = async (q: string) => ({ intent: "incident_specific", searchTerms: q, needClarification: false, clarifyWhy: "" });
const queryDims = async (_q: string) => null; // lex arm (BM25) — hermetic
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
	const rankedRefs = (r?.ranked ?? []).map((s) => refOfBlock.get(s.block.id)).filter(Boolean);
	const found = probe.requiredRefs.filter((ref) => rankedRefs.includes(ref));
	if (found.length) failureHit++;
	failureRows.push({ id: probe.id, query: probe.query, requiredRefs: probe.requiredRefs, foundRefs: found });
}
const failureAppearance = failureRows.length ? failureHit / failureRows.length : 0;

// ── 5. grading against the manifest ─────────────────────────────────────────
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
];

// ── report ──────────────────────────────────────────────────────────────────
console.log(`
──────────────── lifecycle bench report ────────────────`);
console.log(`consolidation: ${consolidation.status}${consolidation.file ? ` (${consolidation.file}${consolidation.exportName ? `::${consolidation.exportName}` : ""})` : ""}${consolidation.detail ? ` — ${consolidation.detail}` : ""}`);
console.log(`block states: ${graded.filter((g) => g.actual !== "unassigned").length}/${graded.length} assigned, artifact links: ${artifacts.links.length}`);

if (!implemented) {
	console.log(`
PRE-REGISTERED BAR (applies once consolidation exists):
  state accuracy ≥90% per class · false demotions = 0 · supersession recall ≥80% · leak rate ≤10%
VERDICT: implementation absent — baseline n/a (all gates ungraded)`);
	console.log(`
pre-implementation recall diagnostics (honest record, NOT gates):
  neutral recall leak:   ${neutralLeaks}/${neutralRanked} ranked results leak failed/superseded blocks (${Math.round(leakRate * 100)}%) — expected today: recall has no status filter yet
  failure-intent recall: ${failureHit}/${failureRows.length} queries surface the failed blocks (${Math.round(failureAppearance * 100)}%)`);
} else {
	console.log(`
PRE-REGISTERED BAR → RESULTS`);
	for (const g of gates) console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${g.name.padEnd(36)} ${g.value}`);
	console.log(`
VERDICT: ${gates.every((g) => g.pass) ? "PASS — all pre-registered gates met" : "FAIL — pre-registered gates not met"}`);
}

// per-class detail (compact)
for (const c of classes) {
	const s = stateAccuracy[c];
	console.log(`  class ${c.padEnd(12)} ${s.correct}/${s.total} correct${s.accuracy === null ? "" : ` (${Math.round(s.accuracy * 100)}%)`}`);
}
console.log(`sanity (REAL historical pairs, informational, ungraded):`);
for (const p of manifest.sanity.realPairs) console.log(`  ${p.id}: "${p.olderClaim}" → ${p.olderExpected} | "${p.newerClaim}" → ${p.newerExpected}`);

const summary = {
	date: new Date().toISOString(),
	verdict: implemented ? (gates.every((g) => g.pass) ? "pass" : "fail") : "implementation-absent-baseline-na",
	isolatedDir: majordomeDir(),
	consolidation,
	metrics: { stateAccuracy, falseDemotions, validDemotedAllValidPlants: validDemoted, supersessionPairRecall: pairRecall, pairResults, leakRate, neutralLeaks, neutralRanked, failureAppearance, neutralRows, failureRows, gradedBlocks: graded },
	gates,
};
mkdirSync(join(import.meta.dirname ?? "tools", "..", "bench", "results"), { recursive: true });
const outPath = join(import.meta.dirname ?? "tools", "..", "bench", "results", "lifecyclebench-last.json");
writeFileSync(outPath, JSON.stringify(summary, null, 1) + "\n");
console.log(`results → ${outPath}`);
process.exit(!implemented ? 0 : gates.every((g) => g.pass) ? 0 : 1);
