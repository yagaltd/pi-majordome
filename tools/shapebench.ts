/**
 * shapebench (outputShape routing, bench-first) — measure the THIRD routing
 * axis before shipping it: intent decides WHAT to recall, dims/BM25 WHERE
 * from, shape HOW to answer.
 *
 * Pipeline (fully isolated — NEVER touches ~/.pi/majordome):
 *   1. sandbox: HOME + MAJORDOME_DIR + MAJORDOME_KEY_FILE + MAJORDOME_TRAIL
 *      + MAJORDOME_USER_FILE point into a mktemp dir BEFORE any ext import
 *      (store/trail/judges honor the overrides at call time). The REAL key
 *      (if any) is captured before sandboxing and, for the live tier only,
 *      copied INTO the sandbox — hermetic tier runs with no key at all.
 *   2. gates over the SAME shipped helpers the extension calls
 *      (shapeVerdict/userPrefLines from judges.ts, shapeHintLine from
 *      router.ts, metrics from ext/metrics.ts) — shipped logic, not a
 *      bench-local reimplementation.
 *
 * PRE-REGISTERED GATES (fixed in this header before implementation):
 *  PRE-REGISTERED POLICY (live judge-graded gates): any gate whose verdict a
 *  live judge produces is graded by a PANEL — the majority of every grader
 *  engine configured at run time (ext/panel.ts: TypeLLM, Jev when wired,
 *  plus a second TypeLLM pass — the transport exposes no seed/sampling knob,
 *  so an independent re-ask). Engines = whatever is configured; a missing
 *  engine is never fabricated. A run where only ONE grader served is marked
 *  VARIANCE-PRONE in output (the single-engine drift mode this replaces once
 *  flipped gate (f) 112%→89%→95% on identical code). Per-gate output prints
 *  which graders served. Fix the GRADER, not the bar.
 *  HERMETIC (must pass with no key, zero network):
 *  (a) fail-open 100% — no key/classifier, malformed judge answer, or judge
 *      transport throw → shapeVerdict null (never throws, never guesses a
 *      shape); null/default verdict → null hint line → ZERO injection.
 *      user.md preference context: lines read with comments/blanks stripped,
 *      MAJORDOME_USER_FILE override honored, missing file → no context,
 *      cached per session until resetUserPrefs().
 *  (b) canned verdict wiring 100% — every ladder shape parses through the
 *      SAME settle path (canned Jev choice): non-default shape → exactly one
 *      `[majordome shape] <shape> — <hint>` line, suggest-only (no tool
 *      orders), 'default' → no line. Trail records shape+why and NEVER the
 *      message text.
 *  (c) METRIC VALIDATION 100% — token estimator (chars/4) with the word-count
 *      cross-check (agree on prose, flag one-giant-token non-prose), Flesch
 *      reading ease, mean sentence length, term-consistency ratio, canned
 *      fact retention — each validated against fixture texts with hand
 *      computed expected values (syllable rule: vowel-group runs, silent-e
 *      dropped except -le, min 1).
 *  (d) NEGATIVE CONTROL 100% — a fixed caveman-style sample (telegraphic
 *      run-on, dropped articles, synonym churn, dropped facts) must score
 *      WORSE than an STE-80% sample on readability (lower Flesch, higher
 *      mean sentence length) AND on the canned fact-retention check — the
 *      metrics must detect damage, not just compute numbers.
 *  LIVE (only when a TypeLLM key is available; else `live: n/a (hermetic)`):
 *  (e) gold shape accuracy ≥80% over 14 planted prompts (judged with the
 *      user.md preference context; null rows count as misses; all-null →
 *      gate honestly marked n/a, never silently passed).
 *  (f) fact retention — for 5 planted prompts (one per non-default shape)
 *      generate a default answer and a shaped answer (the EXACT tail hint
 *      text), grade both with PANEL GRADING (ext/panel.ts): shaped facts ≥
 *      95% of default's facts. Measures fact PRESENCE without softening the
 *      bar — a genuinely absent fact stays absent under majority voting
 *      (even-panel ties resolve presence-ward, documented in panel.ts).
 *      Grader composition prints per gate; single-grader panels are marked
 *      variance-prone. Seam failure → n/a, never a pass.
 *  (g) token report — mean output tokens (chars/4 estimate) shaped vs
 *      default per shape. REPORT ONLY (first measurement, no bar).
 *  (h) readability report — shaped mean sentence length vs default's.
 *      REPORT ONLY (same seam, same caveat as (g)).
 *
 *   npx tsx tools/shapebench.ts
 *
 * Exit codes: 0 = all hard gates pass ((e)/(f) may be n/a hermetically);
 *             1 = one or more hard gates failed.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputShape } from "../ext/judges.ts";
import type { PanelGrade } from "../ext/panel.ts";

// ── capture the REAL key before sandboxing (live tier only) ─────────────────
const realHome = process.env.HOME ?? homedir();
let realKey: string | null = process.env.TYPELLM_API_KEY?.trim() || null;
if (!realKey) {
	try {
		realKey = readFileSync(join(realHome, ".config", "pi-majordome", "typellm.key"), "utf8").trim() || null;
	} catch {
		realKey = null;
	}
}

const tmpRoot = mkdtempSync(join(tmpdir(), "shapebench-"));
const tmpHome = join(tmpRoot, "home");
const mjdDir = join(tmpHome, "majordome");

// ── env isolation BEFORE any ext module import ──────────────────────────────
process.env.HOME = tmpHome;
process.env.MAJORDOME_DIR = mjdDir;
process.env.MAJORDOME_KEY_FILE = join(tmpRoot, "no-key-on-purpose"); // missing → judges fail open
process.env.MAJORDOME_TRAIL_FILE = join(mjdDir, "trails.jsonl");
process.env.MAJORDOME_INIT_STATE = join(mjdDir, "init.json");
process.env.MAJORDOME_USER_FILE = join(tmpRoot, "user-fixture.json");
process.env.MAJORDOME_USER_MD_FILE = join(tmpRoot, "user-fixture.md");
delete process.env.TYPELLM_API_KEY;

// fixture user.md — the user's real standing preference lines (quoted; the
// real file is never touched): STE-80% wording + diagram-first
const PREF_LINES = [
	"- When explaining concepts or trade-offs, write ~80% ASD-STE100: short sentences, one term per concept, imperative voice, no idioms. Keep code identifiers and technical terms as-is. Never drop facts for style.",
	"- Prefer a diagram over prose for architecture and flow questions — mermaid or ascii graph first, brief prose after.",
];
writeFileSync(process.env.MAJORDOME_USER_FILE, JSON.stringify({ updated: "2026-10-07", answer_shape: "auto", preferences: [], query_style: { avg_topics_per_query: 0, samples: 0, imperative_ratio: 0 }, confidence_calibration: [] }) + "\n");
writeFileSync(process.env.MAJORDOME_USER_MD_FILE, "# personal rules (majordome personal tier — injected into every session)\n\n" + PREF_LINES.join("\n") + "\n");

const { OUTPUT_SHAPES, shapeVerdict, userPrefLines, resetUserPrefs, loadKey, setClassifyFn, resetClassifyFn, generate } = await import("../ext/judges.ts");
const { shapeHintLine } = await import("../ext/router.ts");
const metrics = await import("../ext/metrics.ts");
const panel = await import("../ext/panel.ts");
const { majordomeDir } = await import("../ext/store.ts");

// ── hard isolation guard: the bench must never touch the real brain ─────────
if (!majordomeDir().startsWith(tmpRoot) || majordomeDir() === join(realHome, ".pi", "majordome")) {
	console.error(`FATAL: isolated MAJORDOME_DIR escaped the sandbox (${majordomeDir()})`);
	process.exit(2);
}

let failures = 0;
function gate(name: string, pass: boolean, value: string): void {
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${value}`);
	if (!pass) failures++;
}

// ── planted prompt set (gold shapes, live gate e) ───────────────────────────
const PLANTED: { prompt: string; gold: OutputShape }[] = [
	{ prompt: "compare the regex parser and the combinator parser — which one should we keep?", gold: "table" },
	{ prompt: "explain the recall pipeline", gold: "diagram-first" },
	{ prompt: "why did the merge fail?", gold: "walkthrough" },
	{ prompt: "walk me through the whole router design", gold: "artifact" },
	{ prompt: "what does bm25Rank return?", gold: "default" },
	{ prompt: "ok continue", gold: "default" },
	{ prompt: "go ahead", gold: "default" },
	{ prompt: "fix the off-by-one in the cursor loop", gold: "default" },
	{ prompt: "draw the block-close state machine", gold: "diagram-first" },
	{ prompt: "how do I migrate a legacy store to the per-slug cursor format? walk me through it", gold: "walkthrough" },
	{ prompt: "just tell me the score threshold constant, one line", gold: "terse" },
	{ prompt: "give me a tl;dr of the lifecycle design, short", gold: "terse" },
	{ prompt: "give me a table of the failure intents versus the temporal intents", gold: "table" },
	{ prompt: "summarize the consolidation design as a doc I can keep in the repo", gold: "artifact" },
];

// one planted prompt per non-default shape (live gates f/g/h); facts are
// phrased as full statements for the judge grader
const SHAPED: { prompt: string; shape: OutputShape; facts: string[] }[] = [
	{
		prompt: "Compare the regex parser and the combinator parser on speed, memory use, and error messages.",
		shape: "table",
		facts: ["the regex parser", "the combinator parser", "speed", "memory use", "error messages"],
	},
	{
		prompt: "Explain how a commit flows from staging to the index to the object store, including the parent link.",
		shape: "diagram-first",
		facts: ["staging", "the index", "the object store", "the parent link"],
	},
	{
		prompt: "Walk me through recovering a detached HEAD: find the old commit, inspect it, then restore my branch.",
		shape: "walkthrough",
		facts: ["detached head", "find the old commit", "inspect it", "restore the branch"],
	},
	{
		prompt: "Write a short design note for the retry cache covering purpose, backoff policy, and failure modes.",
		shape: "artifact",
		facts: ["purpose", "backoff policy", "failure modes", "the retry cache"],
	},
	{
		prompt: "Just tell me, one line: what does MAJORDOME_OFF do, and where does the index live?",
		shape: "terse",
		facts: ["MAJORDOME_OFF disables majordome", "where the index lives"],
	},
];

resetUserPrefs();
const PREFS = userPrefLines();
const SECRET_MSG = "XSECRET-never-on-the-trail-X";

console.log(`shapebench (outputShape routing) — sandbox ${tmpRoot}`);
console.log(`prefs loaded: ${PREFS.length} line(s) from MAJORDOME_USER_FILE + MAJORDOME_USER_MD_FILE`);

// ── gate (a): fail-open + preference context ────────────────────────────────
console.log("\n── gate (a): fail-open (no key, no classifier) + user.md context ──");
{
	resetClassifyFn();
	const probes: [string, boolean][] = [];
	// no judges at all → null, never a throw, never a guessed shape
	let v: unknown = "sentinel";
	let threw = false;
	try {
		v = await shapeVerdict("explain the recall pipeline", PREFS);
	} catch {
		threw = true;
	}
	probes.push(["no judges → null verdict, never throws", !threw && v === null]);
	probes.push(["null verdict → null line → zero injection", shapeHintLine("default") === null && shapeHintLine("bogus-shape") === null]);
	probes.push(["prefs: fixture lines read, comments/blanks stripped", PREFS.length === 2 && PREFS[0].startsWith("- When explaining")]);
	resetUserPrefs();
	process.env.MAJORDOME_USER_FILE = join(tmpRoot, "definitely-missing-user.json");
	process.env.MAJORDOME_USER_MD_FILE = join(tmpRoot, "definitely-missing-user.md");
	resetUserPrefs();
	const none = userPrefLines();
	probes.push(["prefs: missing file → no context (empty)", none.length === 0]);
	process.env.MAJORDOME_USER_MD_FILE = join(tmpRoot, "user-fixture.md");
	resetUserPrefs();
	probes.push(["prefs: resetUserPrefs() re-reads", userPrefLines().length === 2]);
	const aPass = probes.filter((p) => p[1]).length;
	gate("(a) fail-open + user.md context = 100%", aPass === probes.length, `${aPass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// ── gate (b): canned verdict → injection wiring + trail hygiene ─────────────
console.log("\n── gate (b): canned verdict wiring (same settle path as live) ──");
{
	const probes: [string, boolean][] = [];
	const lines: Record<string, string | null> = {};
	for (const shape of OUTPUT_SHAPES) {
		setClassifyFn(async () => ({ model: "canned", answers: { shape: { choice: shape }, why: { choice: shape === "default" ? "" : `it is a ${shape} ask` } } }));
		const v = await shapeVerdict(SECRET_MSG, PREFS);
		probes.push([`canned ${shape} parses through the settle path`, v?.shape === shape]);
		lines[shape] = v ? shapeHintLine(v.shape, v.why) : null;
	}
	resetClassifyFn();
	for (const shape of OUTPUT_SHAPES) {
		if (shape === "default") probes.push(["default → zero injection (no line)", lines[shape] === null]);
		else {
			const l = lines[shape] ?? "";
			probes.push(
				[
					`${shape} → one [majordome shape] line`,
					l.startsWith(`[majordome shape] ${shape} — `) && (l.match(/\[majordome shape\]/g) ?? []).length === 1,
				],
			);
		}
	}
	probes.push(["hints are suggest-only advice (no tool orders)", !Object.values(lines).some((l) => /\b(run|execute|invoke|call)\b/i.test(l ?? ""))]);
	probes.push(["diagram-first hint leads with a graph", (lines["diagram-first"] ?? "").includes("mermaid")]);
	// trail hygiene: shape+why recorded, message text never
	let trailOk = false;
	try {
		const raw = readFileSync(join(mjdDir, "trails.jsonl"), "utf8");
		const entries = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
		const sv = entries.filter((e) => e.j === "shapeVerdict");
		trailOk =
			sv.length >= OUTPUT_SHAPES.length &&
			sv.every((e) => typeof e.shape === "string" || e.ok === false) &&
			sv.filter((e) => e.ok !== false).every((e) => (OUTPUT_SHAPES as readonly string[]).includes(e.shape)) &&
			!raw.includes(SECRET_MSG);
	} catch {
		trailOk = false;
	}
	probes.push(["trail records shape+why, never message text", trailOk]);
	// malformed answers through the SAME settle path → null (fail-open)
	setClassifyFn(async () => ({ model: "canned", answers: { shape: "pie-chart" } }));
	const badEnum = await shapeVerdict("x", []);
	setClassifyFn(async () => ({ model: "canned", answers: {} }));
	const badEmpty = await shapeVerdict("x", []);
	setClassifyFn(async () => {
		throw new Error("transport down");
	});
	let badThrow: unknown = "sentinel";
	let badThrew = false;
	try {
		badThrow = await shapeVerdict("x", []);
	} catch {
		badThrew = true;
	}
	resetClassifyFn();
	probes.push(["malformed/empty/thrown answers → null (fail-open)", badEnum === null && badEmpty === null && !badThrew && badThrow === null]);
	const bPass = probes.filter((p) => p[1]).length;
	gate("(b) canned verdict wiring + trail hygiene = 100%", bPass === probes.length, `${bPass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// ── gate (c): metric validation (hand-computed fixture values) ──────────────
console.log("\n── gate (c): metric validation against known values ──");
{
	const probes: [string, boolean][] = [];
	const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
	// token estimator: exact chars/4 values + word-count cross-check
	probes.push(["estTokens: exact chars/4 (40 chars → 10)", metrics.estTokens("x".repeat(40)) === 10 && metrics.estTokens("hello world") === 3]);
	probes.push(["estTokensWords: exact 1.3/word (2 words → 3)", metrics.estTokensWords("hello world") === 3]);
	probes.push(["cross-check agrees on prose, flags one-giant-token", metrics.tokenEstimatorsAgree("The cat sat on the mat.") && !metrics.tokenEstimatorsAgree("a".repeat(400))]);
	// Flesch reading ease: syllable rule hand-computed per fixture
	probes.push(["syllables: silent-e and -le rule (one=1 table=2 every=3 the=1)", metrics.syllables("one") === 1 && metrics.syllables("table") === 2 && metrics.syllables("every") === 3 && metrics.syllables("the") === 1]);
	probes.push(["Flesch: 'The cat sat on the mat.' = 116.145", close(metrics.fleschReadingEase("The cat sat on the mat."), 116.145)]);
	probes.push(["Flesch: 'The parser uses one table for every token.' = 50.665", close(metrics.fleschReadingEase("The parser uses one table for every token."), 50.665)]);
	probes.push(["Flesch: polysyllabic fixture = -199.075", close(metrics.fleschReadingEase("Facilitated implementation approximately simplified."), -199.075)]);
	probes.push(["Flesch: ordered simple > mid > complex", metrics.fleschReadingEase("The cat sat on the mat.") > metrics.fleschReadingEase("The parser uses one table for every token.") && metrics.fleschReadingEase("The parser uses one table for every token.") > metrics.fleschReadingEase("Facilitated implementation approximately simplified.")]);
	// sentence length: exact
	probes.push(["avgSentenceLength: 5 words / 2 sentences = 2.5", close(metrics.avgSentenceLength("Run the tests. Then commit."), 2.5)]);
	probes.push(["avgSentenceLength: unpunctuated run-on = word count", close(metrics.avgSentenceLength("parser make table table good parser read config now"), 9)]);
	// term consistency: exact ratios (stable vocabulary vs synonym churn)
	const ste3 = "The parser reads the config. The parser validates the config. The parser emits the table.";
	const churn = "The parser reads the config. The module checks the file. The routine emits the data.";
	probes.push(["termConsistency: stable terms = 5/9", close(metrics.termConsistency(ste3), 5 / 9)]);
	probes.push(["termConsistency: synonym churn = 0", metrics.termConsistency(churn) === 0]);
	// canned fact retention: exact
	const facts = ["parser", "config", "table"];
	probes.push(["factRetention: 2 of 3 present = 2/3", close(metrics.factRetention("the parser reads the config", facts), 2 / 3)]);
	probes.push(["factRetention: empty fact list is vacuously 1", metrics.factRetention("anything", []) === 1]);
	const cPass = probes.filter((p) => p[1]).length;
	gate("(c) metric validation = 100% (fixture values exact)", cPass === probes.length, `${cPass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// ── gate (d): NEGATIVE CONTROL — caveman vs STE-80 (metrics detect damage) ──
console.log("\n── gate (d): negative control (caveman must lose to STE-80) ──");
{
	const STE = `Start the parser. The parser reads one config file. The parser validates every line. The parser emits one table. The table shows every token. Run the parser again after each config change. Check the table before you commit.`;
	const CAVEMAN = `parser do thing thing read file line check emit result thing good result show stuff maybe parser run again thing change stuff update check thing or something before save maybe thing fix later stuff again result maybe good`;
	const FACTS = ["parser", "config", "validate", "table", "token", "commit"];
	const probes: [string, boolean][] = [
		["readability: caveman Flesch < STE-80 Flesch", metrics.fleschReadingEase(CAVEMAN) < metrics.fleschReadingEase(STE)],
		["readability: caveman sentence length > STE-80 (run-on)", metrics.avgSentenceLength(CAVEMAN) > metrics.avgSentenceLength(STE)],
		["fact retention: STE-80 keeps every fact", metrics.factRetention(STE, FACTS) === 1],
		["fact retention: caveman drops most facts (<0.5)", metrics.factRetention(CAVEMAN, FACTS) < 0.5],
		["fact retention: caveman strictly worse than STE-80", metrics.factRetention(CAVEMAN, FACTS) < metrics.factRetention(STE, FACTS)],
	];
	console.log(`          STE-80  : FRE ${metrics.fleschReadingEase(STE).toFixed(1)}  ASL ${metrics.avgSentenceLength(STE).toFixed(1)}  retention ${metrics.factRetention(STE, FACTS).toFixed(2)}`);
	console.log(`          caveman : FRE ${metrics.fleschReadingEase(CAVEMAN).toFixed(1)}  ASL ${metrics.avgSentenceLength(CAVEMAN).toFixed(1)}  retention ${metrics.factRetention(CAVEMAN, FACTS).toFixed(2)}`);
	const dPass = probes.filter((p) => p[1]).length;
	gate("(d) negative control: metrics detect damage = 100%", dPass === probes.length, `${dPass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// ── live tier ────────────────────────────────────────────────────────────────
if (!realKey) {
	console.log("\nlive: n/a (hermetic)");
} else {
	// the key goes into the SANDBOX (never the real store); trail stays sandboxed
	const sandboxKey = join(tmpRoot, "sandbox-key");
	writeFileSync(sandboxKey, realKey + "\n", { mode: 0o600 });
	process.env.MAJORDOME_KEY_FILE = sandboxKey;
	console.log(`\n── live tier (TypeLLM key present, store sandboxed) ──`);

	// (e) gold shape accuracy ≥ 80%
	console.log("\n── gate (e): gold shape accuracy (live judge) ──");
	{
		const rows: { prompt: string; gold: OutputShape; got: OutputShape | null }[] = [];
		const BATCH = 4;
		for (let i = 0; i < PLANTED.length; i += BATCH) {
			const chunk = PLANTED.slice(i, i + BATCH);
			const vs = await Promise.all(chunk.map((p) => shapeVerdict(p.prompt, PREFS).catch(() => null)));
			vs.forEach((v, j) => rows.push({ prompt: chunk[j].prompt, gold: chunk[j].gold, got: v?.shape ?? null }));
		}
		const seamNulls = rows.filter((r) => r.got === null).length;
		if (seamNulls === rows.length) {
			console.log("  gate (e): n/a — judge seam returned null for every prompt (honestly not passed)");
		} else {
			const ok = rows.filter((r) => r.got === r.gold).length;
			for (const r of rows) console.log(`          ${r.got === r.gold ? "✓" : "✗"} gold=${r.gold.padEnd(14)} got=${(r.got ?? "null").padEnd(14)} "${r.prompt.slice(0, 58)}"`);
			gate("(e) gold shape accuracy ≥ 80%", ok / rows.length >= 0.8, `${Math.round((ok / rows.length) * 100)}% (${ok}/${rows.length})${seamNulls ? ` · ${seamNulls} seam nulls counted as misses` : ""}`);
		}
	}

	// (f)/(g)/(h): default vs shaped generation; grading via PANEL (ext/panel.ts,
	// pre-registered policy in this file's header). Same draft seam for both
	// sides; per-fact majority of every configured grader settles the verdict.
	console.log("\n── gates (f)(g)(h): shaped vs default (live generation + panel grading) ──");
	{
		const gen = async (prompt: string, hint: string | null): Promise<string | null> => {
			const ctx = `You are a coding agent answering a user in a terminal session. Keep the answer under 200 words.\n\n[user message]\n${prompt}${hint ? `\n\n${hint}` : ""}`;
			const r = await generate(ctx, {
				answer: { type: "string", instructions: hint ? "Write the answer now. Follow the [majordome shape] instruction if present." : "Write the answer now." },
			});
			const a = (r?.result as any)?.answer;
			return typeof a === "string" && a.trim() ? a.trim() : null;
		};
		const grade = (prompt: string, facts: string[], answer: string) => panel.gradeWithPanel(facts, answer, { prompt, label: "shapebench:f" });
		const rows: { shape: OutputShape; dOut: string | null; sOut: string | null; d: PanelGrade | null; s: PanelGrade | null }[] = [];
		for (const p of SHAPED) {
			const dOut = await gen(p.prompt, null).catch(() => null);
			const hint = shapeHintLine(p.shape, "planted ask");
			const sOut = await gen(p.prompt, hint).catch(() => null);
			const d = dOut ? await grade(p.prompt, p.facts, dOut).catch(() => null) : null;
			const s = sOut ? await grade(p.prompt, p.facts, sOut).catch(() => null) : null;
			rows.push({ shape: p.shape, dOut, sOut, d, s });
			const fmt = (g: PanelGrade | null) =>
				g === null
					? "null (no grade)"
					: g.found === null
						? `null (panel failed: ${g.attempted.join("+") || "none configured"})`
						: `${g.found}/${p.facts.length} (panel: ${g.graders.join("+") || "none served"}${g.varianceProne ? " — VARIANCE-PRONE" : ""})`;
			console.log(`          ${p.shape.padEnd(14)} default facts=${fmt(d)}  shaped facts=${fmt(s)}`);
		}
		const seamBroken = rows.some((r) => r.d === null || r.s === null || r.d.found === null || r.s.found === null);
		if (rows.every((r) => r.d?.found == null || r.s?.found == null)) {
			console.log("  gate (f): n/a — judge seam failed for every comparison (honestly not passed)");
		} else {
			const dTotal = rows.reduce((n, r) => n + (r.d?.found ?? 0), 0);
			const sTotal = rows.reduce((n, r) => n + (r.s?.found ?? 0), 0);
			const ratio = dTotal ? sTotal / dTotal : 0;
			const served = [...new Set(rows.flatMap((r) => [...(r.d?.graders ?? []), ...(r.s?.graders ?? [])]))];
			const single = rows.some((r) => r.d?.varianceProne || r.s?.varianceProne);
			gate(
				"(f) fact retention: shaped ≥ 95% of default's facts",
				ratio >= 0.95,
				`${Math.round(ratio * 100)}% (${sTotal}/${dTotal} facts) · graders: ${served.join("+") || "none"}${single ? " · SINGLE-GRADER — VARIANCE-PRONE" : ""}${seamBroken ? " · some seam nulls counted as 0" : ""}`,
			);
		}
		// (g) token report per shape (REPORT ONLY — first measurement)
		console.log("  token report (chars/4 estimate, mean per prompt):");
		for (const p of SHAPED) {
			const r = rows.find((x) => x.shape === p.shape);
			const dT = r?.dOut ? metrics.estTokens(r.dOut) : null;
			const sT = r?.sOut ? metrics.estTokens(r.sOut) : null;
			console.log(`          ${p.shape.padEnd(14)} default=${dT ?? "—"}  shaped=${sT ?? "—"}  delta=${dT !== null && sT !== null ? (sT - dT >= 0 ? "+" : "") + (sT - dT) : "—"}`);
		}
		const dAll = rows.flatMap((r) => (r.dOut ? [metrics.estTokens(r.dOut)] : []));
		const sAll = rows.flatMap((r) => (r.sOut ? [metrics.estTokens(r.sOut)] : []));
		const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
		console.log(`          ${"OVERALL".padEnd(14)} default=${Math.round(mean(dAll))}  shaped=${Math.round(mean(sAll))}  delta=${Math.round(mean(sAll) - mean(dAll))}`);
		// (h) readability report (REPORT ONLY)
		const dASL = mean(rows.flatMap((r) => (r.dOut ? [metrics.avgSentenceLength(r.dOut)] : [])));
		const sASL = mean(rows.flatMap((r) => (r.sOut ? [metrics.avgSentenceLength(r.sOut)] : [])));
		console.log(`  readability report: mean sentence length default=${dASL.toFixed(1)} words  shaped=${sASL.toFixed(1)} words  ${sASL <= dASL ? "(shaped ≤ default ✓)" : "(shaped > default — reported, no bar)"}`);
	}
}

// report + result artifact (docsbench convention)
const verdict = failures ? "fail" : "pass";
console.log(`\nshapebench verdict: ${verdict.toUpperCase()}${realKey ? " (live tier run)" : " (live: n/a — hermetic)"}`);
mkdirSync(join(import.meta.dirname ?? "tools", "..", "bench", "results"), { recursive: true });
const outPath = join(import.meta.dirname ?? "tools", "..", "bench", "results", "shapebench-last.txt");
writeFileSync(outPath, `shapebench ${new Date().toISOString()} verdict=${verdict} live=${!!realKey}\n`);
console.log(`results → ${outPath}`);
process.exit(failures ? 1 : 0);
