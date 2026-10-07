/**
 * docsbench (magic-docs v2, bench-first) — measure the docs-nudge pipeline, so
 * the implementation lands against a fixed bar.
 *
 * Pipeline (fully isolated — NEVER touches ~/.pi/majordome):
 *   1. sandbox: HOME + MAJORDOME_DIR + MAJORDOME_KEY_FILE + MAJORDOME_TRAIL
 *      point at a mktemp-style dir BEFORE any ext import (init.ts reads $HOME
 *      at import time; store/judges honor overrides at call time); no TypeLLM
 *      key → judges fail open → zero network.
 *   2. planted synthetic turns with gold labels (docs-worthy yes/no + kind).
 *   3. gates over the SAME pure helpers index.ts calls at turn_end
 *      (cursorKey/cursorForDoc/cursorForSession/docsNudge/verdictToNudge
 *      plus a store round-trip), so the bench tests the shipped logic, not a
 *      bench-local reimplementation.
 *
 * PRE-REGISTERED GATES (fixed in this header before implementation):
 *  (a) per-slug cursor isolation 100% — repo X's doc touch never moves repo
 *      Y's cursor; legacy plain-key entries migrate leniently to the READING
 *      session's slug; per-slug keys round-trip through the store.
 *  (b) offline fallback fires exactly at the 3-block threshold (2 → no nudge,
 *      3 → nudge) and never on docs-touch turns (cursor advanced at turn
 *      time), never on non-implementation blocks, and is blind to other
 *      repos' cursors entirely.
 *  (c) judge path graded ONLY when a TypeLLM key is available, else
 *      `judge path: n/a (hermetic)`; when graded: ≥80% docsWorthy accuracy
 *      and 100% on the planted obvious cases. The verdict→nudge WIRING is
 *      proven offline regardless (canned Jev judge + pure verdictToNudge):
 *      docsWorthy=false → no nudge despite ≥3 implementation blocks;
 *      docsWorthy=true + stale cursor → nudge naming slug + kind.
 *  (d) brownfield seeding (v2.7) 100% — init over a repo with a fresh-mtime
 *      README.md + old-mtime CHANGELOG.md seeds per-slug cursors matching
 *      the FILES' dates (mtime path in the fixture: no git, no invention);
 *      a second init after re-touching README changes nothing (absent keys
 *      only, idempotent) and omits the adoption line; backfilled work closed
 *      BEFORE the seeded date never nudges.
 *  (e) docs profile resolution + filtered nudges — code manifest → coding
 *      {README, CHANGELOG, STATUS, docs/}, none → generic {docs/}; precedence
 *      override > stored > detected with invalid overrides failing open;
 *      generic-profile repo with coding-shaped impl turns → NO README/
 *      CHANGELOG nudge at threshold, .majordome/docs.json override re-enables
 *      it; built-in regex behavior unchanged for the coding profile.
 *  (f) custom watch names — profile {"watch":["NOTES"]} makes a notes.md
 *      touch advance the NOTES cursor (the exact index.ts wiring),
 *      case-insensitively, without matching lookalikes; verdict kinds still
 *      respect the custom profile (CHANGELOG-kind quiet, docs/ not watched).
 *
 *   npx tsx tools/docsbench.ts
 *
 * Exit codes: 0 = all gates pass (judge path may be n/a hermetically);
 *             1 = one or more pre-registered gates failed.
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const realHome = process.env.HOME ?? homedir();
const tmpRoot = mkdtempSync(join(tmpdir(), "docsbench-"));
const tmpHome = join(tmpRoot, "home");
const mjdDir = join(tmpHome, "majordome");

// ── env isolation BEFORE any ext module import ──────────────────────────────
process.env.HOME = tmpHome;
process.env.MAJORDOME_DIR = mjdDir;
process.env.MAJORDOME_KEY_FILE = join(tmpRoot, "no-key-on-purpose"); // missing → judges fail open
process.env.MAJORDOME_TRAIL_FILE = join(mjdDir, "trails.jsonl");
process.env.MAJORDOME_INIT_STATE = join(mjdDir, "init.json"); // belt & braces: init state lives in the sandbox too
delete process.env.TYPELLM_API_KEY;

const { loadMeta, majordomeDir, saveMeta } = await import("../ext/store.ts");
const { cursorForDoc, cursorForSession, cursorKey, docsNudge, docsVerdictNudge, KIND_DOC, scanDocsTouched, verdictToNudge } = await import("../ext/router.ts");
const { docsVerdict, loadKey, resetClassifyFn, setClassifyFn } = await import("../ext/judges.ts");
const { isSubagentSession } = await import("../ext/core.ts");

// ── hard isolation guard: the bench must never touch the real brain ─────────
if (!majordomeDir().startsWith(tmpRoot) || majordomeDir() === join(realHome, ".pi", "majordome")) {
	console.error(`FATAL: isolated MAJORDOME_DIR escaped the sandbox (${majordomeDir()})`);
	process.exit(2);
}

let failures = 0;
function gate(name: string, pass: boolean, value: string): void {
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${value}`);
	if (!pass) failures++;
}

// ── planted synthetic turns (gold labels for the judge path) ────────────────
const PLANTED: { text: string; gold: { docsWorthy: boolean; kind: "readme" | "changelog" | "adr" | null }; obvious: boolean }[] = [
	{ text: "implemented retry with backoff for the webhook client — ships in the next release", gold: { docsWorthy: true, kind: "changelog" }, obvious: true },
	{ text: "broke the public API of export(): callers must now pass an options object", gold: { docsWorthy: true, kind: "readme" }, obvious: true },
	{ text: "renamed a local variable from tmp to temp inside the parser loop", gold: { docsWorthy: false, kind: null }, obvious: true },
	{ text: "decided the sidecar store uses SQLite over Postgres for single-file deploys; tradeoffs recorded", gold: { docsWorthy: true, kind: "adr" }, obvious: false },
	{ text: "fixed a typo in a code comment", gold: { docsWorthy: false, kind: null }, obvious: true },
	{ text: "added a --jobs CLI flag controlling the parallel worker count", gold: { docsWorthy: true, kind: "changelog" }, obvious: false },
];

const slugY = "--home-u-repoy--";
const SFY = `/h/.pi/agent/sessions/${slugY}/s.jsonl`;
const impl = (gists: string[]) => gists.map((g, i) => ({ sessionFile: SFY, intent: "implementation", gist: g, closedAt: `2026-10-${String(i + 1).padStart(2, "0")}T12:00:00Z` }));

console.log(`docsbench (magic-docs v2) — sandbox ${tmpRoot}`);

// ── gate (a): per-slug cursor isolation ─────────────────────────────────────
console.log("\n── gate (a): per-slug cursor isolation ──");
{
	const slugX = "--home-u-repox--";
	const probes: [string, boolean][] = [];
	// 1. X's touch writes only X's key
	const c1: Record<string, string> = { [cursorKey(slugX, "README")]: "2026-10-02T00:00:00Z" };
	probes.push(["X's touch readable under X", cursorForDoc(c1, slugX, "README") === "2026-10-02T00:00:00Z"]);
	probes.push(["X's touch invisible to Y (no bleed)", cursorForDoc(c1, slugY, "README") === undefined]);
	// 2. legacy plain key migrates leniently to the READING slug
	const c2: Record<string, string> = { README: "2026-10-01T00:00:00Z" };
	probes.push(["legacy plain key reads as the current slug", cursorForDoc(c2, slugX, "README") === "2026-10-01T00:00:00Z"]);
	// 3. X's fresh touch never moves Y's cursor (Y keeps its legacy view)
	const c3: Record<string, string> = { ...c2, [cursorKey(slugX, "README")]: "2026-10-03T00:00:00Z" };
	probes.push(["X's new touch does not move Y's legacy cursor", cursorForDoc(c3, slugY, "README") === "2026-10-01T00:00:00Z" && cursorForDoc(c3, slugX, "README") === "2026-10-03T00:00:00Z"]);
	// 4. session view: own keys stripped, other slugs dropped, legacy kept, per-slug wins
	const view = cursorForSession({ [cursorKey(slugX, "README")]: "t2", [cursorKey(slugY, "README")]: "t9", README: "t1-legacy", [cursorKey(slugX, "docs/")]: "t3" }, slugX);
	probes.push(["session view strips/drops/keeps correctly", view.README === "t2" && view["docs/"] === "t3" && Object.keys(view).length === 2]);
	// 5. per-slug keys round-trip through the real store (sandbox dir)
	saveMeta({ dims: [], docsCursor: c3 });
	probes.push(["store round-trip keeps per-slug keys", JSON.stringify(loadMeta().docsCursor) === JSON.stringify(c3)]);
	// 6. key format + scan-name/verdict-kind mappings
	probes.push(["key format slug:docName", cursorKey("code-parser", "README") === "code-parser:README"]);
	probes.push(["scan names + verdict kinds map to cursor docs", JSON.stringify(scanDocsTouched('"path":"docs/README.md"')) === JSON.stringify(["README", "docs/"]) && KIND_DOC.adr === "docs/" && KIND_DOC.changelog === "CHANGELOG" && KIND_DOC.readme === "README"]);
	const aPass = probes.filter((p) => p[1]).length;
	gate("(a) per-slug cursor isolation = 100%", aPass === probes.length, `${aPass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// ── gate (b): offline fallback threshold ────────────────────────────────────
console.log("\n── gate (b): offline fallback (no judge) ──");
{
	const probes: [string, boolean][] = [];
	const two = impl(["wired the retry cache", "fixed the config loader race"]);
	const three = impl(["wired the retry cache", "fixed the config loader race", "added --jobs flag"]);
	probes.push(["2 impl blocks, no cursor → no nudge", docsNudge(two, SFY, {}) === null]);
	probes.push(["3 impl blocks, no cursor → nudge", (docsNudge(three, SFY, {}) ?? "").includes("3 implementation blocks")]);
	// docs-touch turn: index.ts advances the touched doc's cursor to NOW before
	// deciding → this turn's blocks are older than the cursor → never nudge
	const touched = scanDocsTouched('"path":"CHANGELOG.md"');
	const docsTouchCursor: Record<string, string> = { [cursorKey(slugY, touched[0] ?? "CHANGELOG")]: "2026-10-31T23:59:59Z" };
	probes.push(["docs-touch turn (cursor advanced) → no nudge", docsNudge(three, SFY, docsTouchCursor) === null]);
	probes.push(["other repo's cursor never covers this repo", (docsNudge(three, SFY, { "--home-u-repox--:README": "2026-10-09T00:00:00Z" }) ?? "").includes("3 implementation blocks")]);
	probes.push(["non-implementation blocks → never", docsNudge(impl(["a", "b", "c"]).map((b) => ({ ...b, intent: "discussion" })), SFY, {}) === null]);
	probes.push(["legacy cursor older than the work → nudge at 3", (docsNudge(three, SFY, { README: "2026-09-01T00:00:00Z" }) ?? "").includes("3 implementation blocks")]);
	probes.push(["legacy cursor covering all work → no nudge", docsNudge(three, SFY, { README: "2026-10-31T00:00:00Z" }) === null]);
	probes.push(["subagent scratch path flagged for sweep exclusion", isSubagentSession(`/h/.pi/agent/sessions/--home-u-repo-.git-subagents-run_x-task_1--/s.jsonl`) && !isSubagentSession(SFY)]);
	const bPass = probes.filter((p) => p[1]).length;
	gate("(b) fallback threshold exact (2 no / 3 nudge, never on docs-touch)", bPass === probes.length, `${bPass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// ── gate (c): judge path ────────────────────────────────────────────────────
console.log("\n── gate (c): docsVerdict judge path ──");
{
	if (!loadKey()) {
		// hermetic run: the verdict call must fail OPEN to null (never throw),
		// and the accuracy grade is honestly reported as n/a
		resetClassifyFn();
		let threw = false;
		let verdict: Awaited<ReturnType<typeof docsVerdict>> = { docsWorthy: true, kind: "readme", why: "sentinel" };
		try {
			verdict = await docsVerdict(PLANTED[0].text);
		} catch {
			threw = true;
		}
		gate("(c) offline verdict fails open to null (never throws)", !threw && verdict === null, `verdict=${JSON.stringify(verdict)} threw=${threw}`);
		console.log("  judge path: n/a (hermetic) — accuracy grading requires a TypeLLM key");

		// judge ANSWER parsing through the real docsVerdict code, transport canned
		// (deterministic Jev: docs_worthy noul + kind choice)
		setClassifyFn(async () => ({ model: "canned", answers: { docs_worthy: { noul: true }, kind: { choice: "changelog" } } }));
		const parsed = await docsVerdict("implemented retry with backoff for the webhook client");
		gate("(c) canned Jev yes+changelog parses to a verdict", !!parsed && parsed.docsWorthy === true && parsed.kind === "changelog", `${JSON.stringify(parsed)}`);
		setClassifyFn(async () => ({ model: "canned", answers: { docs_worthy: { noul: false }, kind: { choice: "readme" } } }));
		const parsedNo = await docsVerdict("renamed a local variable inside the parser loop");
		gate("(c) canned Jev no → docsWorthy=false, kind=null", !!parsedNo && parsedNo.docsWorthy === false && parsedNo.kind === null, `${JSON.stringify(parsedNo)}`);
		setClassifyFn(async () => ({ model: "canned", answers: {} }));
		const parsedBad = await docsVerdict("anything at all");
		gate("(c) malformed judge answer → null (fail-open, not false)", parsedBad === null, `${JSON.stringify(parsedBad)}`);
		resetClassifyFn();
	} else {
		let ok = 0;
		let obviousOk = 0;
		let obviousN = 0;
		const rows: string[] = [];
		for (const p of PLANTED) {
			const v = await docsVerdict(p.text);
			const match = !!v && v.docsWorthy === p.gold.docsWorthy && (!p.gold.docsWorthy || v.kind === p.gold.kind);
			if (match) ok++;
			if (p.obvious) {
				obviousN++;
				if (match) obviousOk++;
			}
			rows.push(`          ${match ? "✓" : "✗"} gold=${p.gold.docsWorthy ? p.gold.kind : "no"} got=${v ? (v.docsWorthy ? v.kind ?? "?" : "no") : "null"} — "${p.text.slice(0, 48)}"`);
		}
		const acc = ok / PLANTED.length;
		gate("(c) docsWorthy accuracy ≥80%", acc >= 0.8, `${Math.round(acc * 100)}% (${ok}/${PLANTED.length})`);
		gate("(c) planted obvious cases = 100%", obviousOk === obviousN, `${obviousOk}/${obviousN}`);
		for (const r of rows) console.log(r);
	}

	// verdict→nudge wiring, graded offline with canned verdicts (deterministic):
	// the exact pure rule index.ts applies at turn_end
	const work = [
		{ id: `${slugY}:10`, gist: "wired the retry cache", closedAt: "2026-10-01T12:00:00Z" },
		{ id: `${slugY}:11`, gist: "fixed the config loader race", closedAt: "2026-10-02T12:00:00Z" },
		{ id: `${slugY}:12`, gist: "added --jobs flag", closedAt: "2026-10-03T12:00:00Z" },
	];
	const probes: [string, boolean][] = [];
	probes.push(["docsWorthy=false → no nudge despite 3 impl blocks", verdictToNudge({ docsWorthy: false, kind: null }, {}, slugY, work) === null]);
	const fired = verdictToNudge({ docsWorthy: true, kind: "changelog" }, {}, slugY, work);
	probes.push(["docsWorthy=true + stale cursor → nudge naming slug+kind", !!fired && fired.includes("repoy") && fired.includes("changelog") && fired.includes("--jobs") && fired.includes(`${slugY}:12`)]);
	probes.push(["docs-touch this turn (cursor ≥ work) → quiet", verdictToNudge({ docsWorthy: true, kind: "readme" }, { [cursorKey(slugY, "README")]: "2026-10-03T12:00:00Z" }, slugY, work) === null]);
	probes.push(["other repo's cursor never covers this repo", !!verdictToNudge({ docsWorthy: true, kind: "adr" }, { "--home-u-repox--:docs/": "2026-10-09T00:00:00Z" }, slugY, work)]);
	probes.push(["verdict nudge text is grounded (gists + ids)", (docsVerdictNudge("code-parser", "adr", [{ id: "code-parser:7", gist: "chose sqlite over postgres" }]).includes("code-parser") && docsVerdictNudge("code-parser", "adr", [{ id: "code-parser:7", gist: "chose sqlite over postgres" }]).includes("code-parser:7"))]);
	probes.push(["verdict nudge always names its OWN slug (the routing)", (() => {
		const slugX = "--home-u-repox--";
		const workX = work.map((w, i) => ({ ...w, id: `${slugX}:${10 + i}` }));
		const nx = verdictToNudge({ docsWorthy: true, kind: "changelog" }, {}, slugX, workX);
		return !!nx && nx.includes("repox") && !nx.includes("repoy");
	})()]);
	const cPass = probes.filter((p) => p[1]).length;
	gate("(c) verdict→nudge wiring = 100% (canned, offline)", cPass === probes.length, `${cPass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// ── gate (d): brownfield seeding at init (real file dates, idempotent) ─────
console.log("\n── gate (d): brownfield cursor seeding at init ──");
{
	const { initRepo } = await import("../ext/init.ts");
	const { detectDocsProfile } = await import("../ext/docsprofile.ts");
	const slugX = "--home-u-brownfield--"; // fresh slug: gate (a) already seeded repox's cursors in this sandbox store
	const repoX = join(tmpRoot, "repos", "brownfield"); // basename must appear in the session slug
	mkdirSync(repoX, { recursive: true });
	// a minimal session so slug resolution finds the repo (hermetic: no key →
	// judges fail open; seeding is judge-free and runs regardless)
	const sessDir = join(tmpHome, ".pi", "agent", "sessions", slugX);
	mkdirSync(sessDir, { recursive: true });
	const mkMsg = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
	writeFileSync(join(sessDir, "s.jsonl"), [
		mkMsg("user", "fix the parser crash"), mkMsg("assistant", "patched the parser loop"),
		mkMsg("user", "add regression tests"), mkMsg("assistant", "tests added for the parser"),
	].join("\n"));
	// brownfield docs: README fresh-mtime, CHANGELOG old-mtime, docs/ dir older
	const FRESH = new Date("2026-10-28T09:30:00.000Z");
	const OLD = new Date("2026-09-15T14:00:00.000Z");
	const OLDER = new Date("2026-08-02T08:00:00.000Z");
	writeFileSync(join(repoX, "README.md"), "# brownfield\n");
	writeFileSync(join(repoX, "CHANGELOG.md"), "# changelog\n");
	mkdirSync(join(repoX, "docs"), { recursive: true });
	writeFileSync(join(repoX, "docs", "api.md"), "# api\n");
	utimesSync(join(repoX, "README.md"), FRESH, FRESH);
	utimesSync(join(repoX, "CHANGELOG.md"), OLD, OLD);
	utimesSync(join(repoX, "docs", "api.md"), OLDER, OLDER);
	const expectIso = (d: Date) => d.toISOString(); // mtime path: seeded date IS the file date

	const r1 = await initRepo({ cwd: repoX, noDims: true });
	const cur1 = loadMeta().docsCursor;
	const probes: [string, boolean][] = [
		["init output notes the generic profile (headless, no prompts)", r1.includes("docs profile: generic (no code markers)") && r1.includes('.majordome/docs.json {"watch":[...]}')],
		["README cursor seeded from the fresh file mtime", cur1[cursorKey(slugX, "README")] === expectIso(FRESH)],
		["CHANGELOG cursor seeded from the old file mtime", cur1[cursorKey(slugX, "CHANGELOG")] === expectIso(OLD)],
		["docs/ cursor seeded from newest docs mtime (depth ≤2)", cur1[cursorKey(slugX, "docs/")] === expectIso(OLDER)],
		["init output carries ONE compact adoption line", r1.includes("docs adopted: README ← 2026-10-28, CHANGELOG ← 2026-09-15") && r1.includes("(cursors seeded)")],
	];
	// idempotent: re-touch README forward, re-init — the cursor NEVER moves
	const FRESHER = new Date("2026-10-30T09:30:00.000Z");
	utimesSync(join(repoX, "README.md"), FRESHER, FRESHER);
	const r2 = await initRepo({ cwd: repoX, noDims: true });
	probes.push(["second init changes nothing (absent keys only)", loadMeta().docsCursor[cursorKey(slugX, "README")] === expectIso(FRESH)]);
	probes.push(["second init output omits the adoption line", !r2.includes("docs adopted:")]);
	// backfilled work closed BEFORE the seeded date never nudges (cursor covers it)
	const SFX = `/h/.pi/agent/sessions/${slugX}/w.jsonl`;
	const backfill = ["wired the retry cache", "fixed the config race", "added --jobs flag"].map((g, i) => ({ sessionFile: SFX, intent: "implementation", gist: g, closedAt: `2026-07-0${i + 1}T12:00:00Z` }));
	const lateWork = backfill.map((b, i) => ({ ...b, closedAt: `2026-10-2${i + 8}T12:00:00Z` }));
	probes.push(["work closed before the seeded dates never nudges", docsNudge(backfill, SFX, loadMeta().docsCursor) === null]);
	probes.push(["control: work after the cursor still fires", (docsNudge(lateWork, SFX, loadMeta().docsCursor) ?? "").includes("3 implementation blocks")]);
	const dPass = probes.filter((p) => p[1]).length;
	gate("(d) brownfield seeding = 100% (real dates, idempotent)", dPass === probes.length, `${dPass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// ── gate (e): docs profile resolution precedence + filtered nudges ──────────
console.log("\n── gate (e): docs profile resolution + filtered nudges ──");
{
	const { detectDocsProfile, readDocsOverride, resolveDocsProfile } = await import("../ext/docsprofile.ts");
	const repoCoding = join(tmpRoot, "repos", "coding");
	const repoGeneric = join(tmpRoot, "repos", "generic");
	mkdirSync(join(repoCoding, "src"), { recursive: true });
	writeFileSync(join(repoCoding, "package.json"), "{}\n");
	mkdirSync(join(repoGeneric, "docs"), { recursive: true });
	const probes: [string, boolean][] = [
		["code manifest → coding profile (README+CHANGELOG+status.json+docs/)", JSON.stringify(detectDocsProfile(repoCoding)) === JSON.stringify({ watch: ["README", "CHANGELOG", "status.json", "docs/"], source: "detected-coding" })],
		["no manifest → generic profile (docs/ only)", detectDocsProfile(repoGeneric).source === "detected-generic" && JSON.stringify(detectDocsProfile(repoGeneric).watch) === JSON.stringify(["docs/"])],
		["absent override reads null", readDocsOverride(repoCoding) === null],
		["stored profile wins over detection (no override)", resolveDocsProfile(repoGeneric, { watch: ["NOTES"], source: "detected-generic" }).watch.join(",") === "NOTES"],
	];
	// override re-enables README/CHANGELOG in the generic repo
	mkdirSync(join(repoGeneric, ".majordome"), { recursive: true });
	writeFileSync(join(repoGeneric, ".majordome", "docs.json"), JSON.stringify({ watch: ["README", "CHANGELOG", "docs/"] }));
	const ov = resolveDocsProfile(repoGeneric, { watch: ["NOTES"], source: "detected-generic" });
	probes.push(["override file wins over stored + detected", ov.source === "override" && ov.watch.join(",") === "README,CHANGELOG,docs/"]);
	// invalid override fails open to the detected default (doctor notes it)
	writeFileSync(join(repoGeneric, ".majordome", "docs.json"), "{not json");
	probes.push(["invalid override fails open to detection", resolveDocsProfile(repoGeneric, null).source === "detected-generic" && readDocsOverride(repoGeneric) === "invalid"]);
	// arithmetic fallback is profile-gated: generic repo → no README/CHANGELOG nudge at threshold
	const three = impl(["wired the retry cache", "fixed the config loader race", "added --jobs flag"]);
	probes.push(["generic profile: no README/CHANGELOG nudge at threshold", docsNudge(three, SFY, {}, ["docs/"]) === null]);
	probes.push(["generic profile: CHANGELOG cursor is inert (not watched)", docsNudge(three, SFY, { [cursorKey(slugY, "CHANGELOG")]: "2026-10-31T23:59:59Z" }, ["docs/"]) === null]);
	probes.push(["override re-enables: nudge fires at threshold", (docsNudge(three, SFY, {}, ["README", "CHANGELOG", "docs/"]) ?? "").includes("3 implementation blocks")]);
	probes.push(["override re-enables: CHANGELOG cursor covers again", docsNudge(three, SFY, { [cursorKey(slugY, "CHANGELOG")]: "2026-10-31T23:59:59Z" }, ["README", "CHANGELOG", "docs/"]) === null]);
	// verdict path is profile-gated: changelog verdict in a generic repo stays quiet
	const turnWork = [
		{ id: `${slugY}:10`, gist: "wired the retry cache", closedAt: "2026-10-01T12:00:00Z" },
		{ id: `${slugY}:11`, gist: "fixed the config loader race", closedAt: "2026-10-02T12:00:00Z" },
	];
	probes.push(["changelog verdict in generic repo → quiet", verdictToNudge({ docsWorthy: true, kind: "changelog" }, {}, slugY, turnWork, ["docs/"]) === null]);
	probes.push(["adr verdict in generic repo still fires (docs/ watched)", !!verdictToNudge({ docsWorthy: true, kind: "adr" }, {}, slugY, turnWork, ["docs/"])]);
	probes.push(["built-in regex behavior unchanged (coding profile)", JSON.stringify(scanDocsTouched('"path":"docs/README.md" "path":"CHANGELOG.md" "path":"docs/api.md"', ["README", "CHANGELOG", "docs/"])) === JSON.stringify(["README", "CHANGELOG", "docs/"])]);
	const ePass = probes.filter((p) => p[1]).length;
	gate("(e) docs profile: precedence + filtered nudges = 100%", ePass === probes.length, `${ePass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// ── gate (f): custom watch names ─────────────────────────────────────────────
console.log("\n── gate (f): custom watch name (NOTES) ──");
{
	const probes: [string, boolean][] = [
		["custom name matches its own doc path", scanDocsTouched('"path":"docs/notes.md"', ["NOTES"]).join(",") === "NOTES"],
		["custom name is case-insensitive (path separator required, like the built-ins)", JSON.stringify(scanDocsTouched('"file":"src/Notes.MD"', ["NOTES"])) === JSON.stringify(["NOTES"])],
		["custom name does not match lookalikes", scanDocsTouched('"file":"prompts/notes.txt" "file":"footer-notes.md"', ["NOTES"]).length === 0],
		["NOTES touch advances the NOTES cursor (index.ts wiring)", (() => {
			const cursor: Record<string, string> = {};
			const touched = scanDocsTouched('"path":"docs/notes.md"', ["NOTES"]);
			for (const doc of touched) cursor[cursorKey(slugY, doc)] = "2026-10-30T00:00:00Z"; // the exact turn_end loop
			return touched.length === 1 && cursorForDoc(cursor, slugY, "NOTES") === "2026-10-30T00:00:00Z" && cursorForDoc(cursor, "--home-u-repox--", "NOTES") === undefined;
		})()],
		["AGENTS.md works as a custom watch name", scanDocsTouched('"file":"/repo/AGENTS.md"', ["AGENTS"]).join(",") === "AGENTS"],
		["verdict kinds still respect the custom profile", verdictToNudge({ docsWorthy: true, kind: "changelog" }, {}, slugY, [{ id: `${slugY}:1`, gist: "x", closedAt: "2026-10-01T00:00:00Z" }], ["NOTES"]) === null],
	];
	const fPass = probes.filter((p) => p[1]).length;
	gate("(f) custom watch names = 100%", fPass === probes.length, `${fPass}/${probes.length} probes`);
	for (const [name, ok] of probes) if (!ok) console.log(`          ✗ ${name}`);
}

// report + result artifact (same convention as lifecyclebench, tiny)
const verdict = failures ? "fail" : "pass";
console.log(`\ndocsbench verdict: ${verdict.toUpperCase()}${loadKey() ? "" : " (judge path n/a — hermetic)"}`);
mkdirSync(join(import.meta.dirname ?? "tools", "..", "bench", "results"), { recursive: true });
const outPath = join(import.meta.dirname ?? "tools", "..", "bench", "results", "docsbench-last.txt");
writeFileSync(outPath, `docsbench ${new Date().toISOString()} verdict=${verdict} hermetic=${!loadKey()}\n`);
console.log(`results → ${outPath}`);
process.exit(failures ? 1 : 0);
