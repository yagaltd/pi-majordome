/**
 * pi-majordome self-check — offline assertion battery (no network), plus an
 * optional --parity mode that recomputes the slice-1 clustering accuracy
 * (EMA 0.903) against the real reference session. Port == bench or it
 * doesn't ship.
 *
 *   npx tsx ext/selfcheck.ts            # assertions
 *   npx tsx ext/selfcheck.ts --parity   # + replay parity vs bench/key.json
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSession, tokens, jaccard, detectBoundaries, blockCores, bm25Rank, federatedOrder, cosineVec } from "./core.ts";
import { parseDims, routingIntent, setClassifyFn, resetClassifyFn } from "./judges.ts";
import { timeTravel, rankArm, route, injectionText, judgeLine, docsNudge, scanDocsTouched, armFor } from "./router.ts";
import { composeKind, digest, filterBlocks } from "./docs.ts";
import type { Block } from "./store.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
	if (!cond) {
		failures++;
		console.error(`FAIL  ${name}`);
	} else {
		console.log(`ok    ${name}`);
	}
}

// ── tokens ──
check("tokens strips stopwords/digits", !tokens("the 42 watcher crates ok").has("the") && !tokens("42 crates").has("42") && tokens("watcher crates").has("watcher"));

// ── parseSession on a fixture ──
const tmp = mkdtempSync(join(tmpdir(), "majordome-selfcheck-"));
const fixture = join(tmp, "s.jsonl");
const mkMsg = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
writeFileSync(
	fixture,
	[
		JSON.stringify({ type: "model", provider: "x" }), // non-message line: skipped
		mkMsg("user", "<system-reminder>nope</system-reminder>"),
		mkMsg("user", "fix the watcher crash"),
		mkMsg("assistant", "the watcher thread panicked on rename events"),
		mkMsg("user", "fix the   watcher crash"), // retried turn: deduped
		mkMsg("assistant", "patched and added a regression test"),
		mkMsg("user", "now design the pricing page"),
		mkMsg("assistant", "three tiers, annual discount"),
	].join("\n"),
);
const turns = parseSession(fixture);
check("parse: wrappers+retries skipped, 2 turns", turns.length === 2);
check("parse: assistant text joined", turns[0].text.includes("panicked") && turns[0].text.includes("regression"));

// ── EMA boundary: disjoint topics must split ──
const drift: any[] = [];
for (let i = 0; i < 6; i++) drift.push({ user: `alpha topic word${i}`, text: `alpha glossary checkpoint${i}`, n: i + 1, utokens: new Set(), tokens: new Set() });
for (let i = 0; i < 6; i++) drift.push({ user: `beta planet orbit${i}`, text: `beta telescope nebula${i}`, n: 7 + i, utokens: new Set(), tokens: new Set() });
for (const t of drift) {
	t.utokens = tokens(t.user);
	t.tokens = tokens(t.text);
}
const bounds = detectBoundaries(drift as any, 0.07, 4);
check("ema splits disjoint topics", bounds.includes(7));

// ── blockCores hybrid field ──
const cores = blockCores(drift as any, [1, 7]);
check("hybrid = user tokens + tail turns", cores[0].tokensHybrid.has("alpha") && cores[0].tokensHybrid.has("checkpoint5"));

// ── bm25 sanity ──
const qb = cores.map((c) => ({ tokensHybrid: c.tokensHybrid }));
const scores = bm25Rank(qb, tokens("planet orbit"));
check("bm25 prefers matching block", scores[1] > scores[0]);

// ── dims guards (the slice-3 flake mode) ──
check("dims: null value rejected", parseDims([0.5, null, 0.2], 3) === null);
check("dims: all-0 degenerate rejected", parseDims([0, 0, 0], 3) === null);
check("dims: all-1 degenerate rejected", parseDims([true, true, true], 3) === null);
check("dims: legit mixed vector kept", parseDims([0.9, 0, 0.5], 3) !== null);
check("dims: length mismatch rejected", parseDims([0.1, 0.2], 3) === null);

// ── arm selection (specialists, not averages) ──
check("arm: definition_recall → dims", armFor("definition_recall") === "dims");
check("arm: incident_specific → lex", armFor("incident_specific") === "lex");

// ── time-travel filter ──
const mkBlock = (session: string, firstTurn: number, lastTurn: number, terms: string[]): Block => ({
	id: `${session}:${firstTurn}`,
	session,
	sessionFile: `/x/${session}/s.jsonl`,
	firstTurn,
	lastTurn,
	gist: `gist ${session} ${firstTurn}`,
	intent: "implementation",
	dims: Object.fromEntries(terms.map((t) => [t, 1])),
	tokensHybrid: terms,
	head: terms.join(" "),
	closedAt: "2026-01-01T00:00:00Z",
});
const indexBlocks = [mkBlock("A", 1, 3, ["watcher"]), mkBlock("A", 4, 9, ["pricing"]), mkBlock("B", 1, 5, ["calendar", "watcher"])];
const cur = timeTravel(indexBlocks, "A", 12, "/x/A/s.jsonl");
check("time-travel: all past + other sessions", cur.length === 3);
const curOpen = timeTravel(indexBlocks, "A", 9, "/x/A/s.jsonl");
check("time-travel: current open block excluded", curOpen.length === 2 && !curOpen.some((b) => b.id === "A:4"));
const otherFile = timeTravel(indexBlocks.map((b) => ({ ...b, lastTurn: 100 })), "A", 9, "/x/A/OTHER.jsonl");
check("time-travel: same slug, different file = always candidate", otherFile.length === 3);

// ── federated pools: both sessions survive a lex-dominant session ──
const A1 = mkBlock("A", 1, 2, ["calendar", "reminders", "events"]);
const A2 = mkBlock("A", 3, 4, ["calendar", "ics", "export"]);
const B1 = mkBlock("B", 1, 2, ["calendar", "timezones"]);
const merged = federatedOrder([A1, A2, B1], (b) => bm25Rank([b], tokens("calendar"))[0]);
check("federate: cross-session merged", new Set(merged.map((b) => b.session)).size === 2);

// ── arms ranking ──
const lexRank = rankArm([A1, B1], tokens("calendar timezones"), null, "lex");
check("lex arm ranks token match first", lexRank[0].block.id === "B:1");
const qv = new Map([["calendar", 1], ["watcher", 1]]);
const dimRank = rankArm([A1, indexBlocks[0], B1], tokens("calendar watcher"), qv, "dims");
check("dims arm cosine prefers vector match", dimRank[0].block.id === "A:1");

// ── injection text ──
const inj = injectionText(mkBlock("--home-aurel-Documents-current-code-parser--", 4, 9, ["x"]));
check("injection: slug + turns + gist", inj.includes("code-parser") && inj.includes("turns 4–9") && inj.startsWith("[majordome recall"));

// ── judge line ──
check("judgeLine soft: why + informed tone", judgeLine("which module?").includes("which module?") && judgeLine("ok").includes("Possible ambiguity") && !judgeLine("ok").includes("Ask ONE"));
check("judgeLine strict: imperative", judgeLine("ok", "strict").includes("Ask ONE"));

// ── docs nudge ──
{
	const mkB = (intent: string, gist: string) => ({ sessionFile: "/x/s.jsonl", intent, gist, closedAt: "2026-10-02T12:00:00Z" });
	const impl = ["a", "b", "c"].map((g) => mkB("implementation", `built ${g}`));
	check("docsNudge: fires at 3 implementation blocks", (docsNudge(impl, "/x/s.jsonl", {}) ?? "").includes("3 implementation blocks"));
	check("docsNudge: quiet under threshold", docsNudge(impl.slice(0, 2), "/x/s.jsonl", {}) === null);
	check("docsNudge: cursor suppresses covered work", docsNudge(impl, "/x/s.jsonl", { README: "2026-10-02T23:59:59Z" }) === null);
	check("docsNudge: ignores non-implementation", docsNudge([mkB("discussion", "chat")].concat(impl.slice(0, 2)), "/x/s.jsonl", {}) === null);
	check("scanDocs: readme+changelog+docs dir", JSON.stringify(scanDocsTouched('"path":"docs/README.md" "path":"CHANGELOG.md" "path":"docs/api.md"')) === JSON.stringify(["README", "CHANGELOG", "docs/"]));
}

// ── docs digest ──
{
	const mk = (session: string, intent: string, gist: string, closedAt: string): any => ({
		id: `${session}:1`, session, sessionFile: `/x/${session}/s.jsonl`, firstTurn: 1, lastTurn: 2,
		gist, intent, dims: {}, tokensHybrid: [], head: `ask ${gist}`, closedAt,
	});
	const bs = [mk("projA", "implementation", "built the thing", "2026-10-01T10:00:00Z"), mk("projB", "discussion", "chatted", "2026-10-01T11:00:00Z"), mk("projB", "documentation", "wrote docs", "2026-10-02T09:00:00Z")];
	check("filter: scope slug keeps own doc-worthy only", filterBlocks(bs, { slug: "projA" }).length === 1 && filterBlocks(bs, { slug: "projB" }).length === 1);
	check("filter: since cursor cuts old blocks", filterBlocks(bs, { all: true, since: "2026-10-01T12:00:00Z" }).length === 1);
	const d = digest(filterBlocks(bs, { slug: "projB" }));
	check("digest: short id + gist + first ask", d.includes("projB:1") && d.includes("wrote docs") && d.includes("first ask"));
	const c = composeKind("changelog", filterBlocks(bs, { slug: "projB" }));
	check("composeKind: builtin fills {{digest}}", !!c && c!.instruction.includes("CHANGELOG.md") && c!.instruction.includes("wrote docs"));
	check("composeKind: unknown kind null", composeKind("nope", bs) === null);
}

// ── cosine ──
check("cosine: identical = 1", Math.abs(cosineVec(new Map([["a", 1]]), new Map([["a", 1]])) - 1) < 1e-9);
check("cosine: disjoint = 0", cosineVec(new Map([["a", 1]]), new Map([["b", 1]])) === 0);

// ── parity: replay the reference session, recompute slice-1 clustering accuracy ──
if (process.argv.includes("--parity")) {
	const { readFileSync } = await import("node:fs");
	const home = process.env.HOME ?? "";
	const sessA = `${home}/.pi/agent/sessions/--home-aurel-Documents-current-code-parser--/2026-09-28T07-30-31-842Z_01a0e6ec-2921-733b-9736-2b6ea32df080.jsonl`;
	const key = JSON.parse(readFileSync(new URL("../bench/key.json", import.meta.url), "utf8"));
	const rt = parseSession(sessA);
	const firsts = detectBoundaries(rt, 0.07, 4);
	const label = (i: number) => key.blocks.find((b: any) => b.first_turn <= i && i <= b.last_turn)?.label ?? "?";
	const labels = Array.from({ length: rt.length }, (_, i) => label(i + 1));
	let correct = 0;
	for (let j = 0; j < firsts.length; j++) {
		const start = firsts[j];
		const end = j + 1 < firsts.length ? firsts[j + 1] - 1 : rt.length;
		const seg = labels.slice(start - 1, end);
		const counts = new Map<string, number>();
		for (const l of seg) counts.set(l, (counts.get(l) ?? 0) + 1);
		const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
		correct += seg.filter((l) => l === majority).length;
	}
	const acc = Math.round((correct / rt.length) * 1000) / 1000;
	console.log(`parity: ${rt.length} turns -> ${firsts.length} blocks, clustering accuracy ${acc} (bench EMA: 0.903)`);
	check("parity within 0.05 of bench 0.903", Math.abs(acc - 0.903) <= 0.05);
}

// ── Jev-only config: intent via classifier choice, no TypeLLM key ──
{
	process.env.MAJORDOME_KEY_FILE = "/tmp/definitely-missing-majordome-key";
	setClassifyFn(async () => ({ model: "fake-jev", answers: { intent: { choice: "definition_recall" } } }));
	const r = await routingIntent("remind me how the watcher works");
	check("jev-only: recall routes via classifier", r?.intent === "definition_recall");
	setClassifyFn(async () => ({ model: "fake-jev", answers: { intent: { choice: "continuation" } } }));
	const r2 = await routingIntent("go");
	check("jev-only: continuation gated", r2 === null);
	resetClassifyFn();
	delete process.env.MAJORDOME_KEY_FILE;
}

// ── v2.4 lifecycle: statuses, recall scope, consolidation verdicts ──
{
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose"); // hermetic: judges fail open, zero network
	const { statusOf, loadBlocks, rewriteBlocks, loadLifecycle, saveLifecycle, effectiveStatus } = await import("./store.ts");
	type Block = import("./store.ts").Block;
	type BlockStatus = import("./store.ts").BlockStatus;
	const { scopeByLifecycle, isFailureIntent } = await import("./router.ts");
	const { inBlockVerdict, runConsolidation } = await import("./consolidate.ts");

	const mk = (id: string, status?: BlockStatus): Block => ({
		id, session: "s", sessionFile: `/tmp/${id}.jsonl`, firstTurn: 1, lastTurn: 2,
		gist: null, intent: null, dims: {}, tokensHybrid: [], head: "", closedAt: "", ...(status ? { status } : {}),
	});
	check("statusOf: absent reads valid (backward compat)", statusOf(mk("a")) === "valid");
	check("statusOf: superseded round-trips", statusOf(mk("a", "superseded")) === "superseded");

	// lenient parse: corrupt status never poisons the store
	process.env.MAJORDOME_DIR = join(tmp, "lifecycle-store");
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "lifecycle-trails.jsonl");
	rewriteBlocks([mk("ok:1", "failed"), mk("bad:1"), { ...mk("junk:1", "valid"), status: "garbage" as unknown as BlockStatus }]);
	const reloaded = loadBlocks();
	check("loadBlocks: statuses persist", reloaded.find((b) => b.id === "ok:1")?.status === "failed");
	check("loadBlocks: corrupt status reads valid (lenient)", reloaded.find((b) => b.id === "junk:1") && statusOf(reloaded.find((b) => b.id === "junk:1")!) === "valid");

	saveLifecycle({ statuses: { "side:1": "superseded" }, supersessions: [{ older: "side:1", newer: "side:2", verdict: "contradicts", source: "heuristic-lexical" }] });
	const art = loadLifecycle();
	check("lifecycle.json round-trips", art.statuses["side:1"] === "superseded" && art.supersessions.length === 1);
	check("effectiveStatus: record wins, sidecar falls back", effectiveStatus({ ...mk("any:1"), status: "failed" }, art) === "failed" && effectiveStatus({ ...mk("side:1") }, art) === "superseded");

	// recall scope: default excludes dead, failure-intent includes
	const valid = mk("v:1", "valid"), dead1 = mk("d:1", "failed"), dead2 = mk("d:2", "superseded"), spec = mk("sp:1", "speculative");
	const cands = [valid, dead1, dead2, spec];
	check("scope: neutral excludes failed+superseded", JSON.stringify(scopeByLifecycle(cands, "which renderer renders previews?").map((b) => b.id)) === JSON.stringify(["v:1", "sp:1"]));
	check("scope: failure-intent includes dead", scopeByLifecycle(cands, "what did we try that failed?").length === 4);
	check("isFailureIntent: spec regex hits", isFailureIntent("which approaches did we revert?") && isFailureIntent("show me the wrong path we took") && isFailureIntent("that didn't work"));
	check("isFailureIntent: neutral queries pass through", !isFailureIntent("how does the webhook retry policy work?") && !isFailureIntent("where does the config file live?"));

	// temporal intent (v2.5 LongMemEval): superseded blocks answer "before" questions
	const { isTemporalIntent } = await import("./router.ts");
	check("isTemporalIntent: spec regex hits", isTemporalIntent("what did we decide before the renderer switch?") && isTemporalIntent("which config did we use previously?") && isTemporalIntent("what renderer did we used to have?") && isTemporalIntent("history of the test harness?"));
	check("isTemporalIntent: neutral/failure queries pass through", !isTemporalIntent("which renderer renders the docs previews?") && !isTemporalIntent("what did we try that failed?"));
	const sup = mk("sup:1", "superseded");
	check("scope: temporal includes superseded, still excludes failed", JSON.stringify(scopeByLifecycle([valid, dead1, dead2, sup, spec], "what did we use before the switch?").map((b) => b.id)) === JSON.stringify(["v:1", "d:2", "sup:1", "sp:1"]));

	// abstention floor (v2.5): zero-evidence queries return no ranked results
	const floorBlocks = [valid, dead1, dead2, sup].map((b, i) => ({ ...b, session: `s${i}`, tokensHybrid: i === 0 ? ["renderer", "previews"] : [`topic${i}`] }));
	const rfloor = await route({
		userMessage: "anything about kubernetes?",
		blocks: floorBlocks,
		currentSession: "__selfcheck__",
		currentTurn: 99999,
		routingIntent: async () => ({ intent: "incident_specific", searchTerms: "anything about kubernetes?", needClarification: false, clarifyWhy: "" }),
		queryDims: async () => null,
		tokens: (s) => tokens(s),
	});
	check("route: abstention — zero-evidence query returns no hits", rfloor !== null && rfloor.ranked.length === 0 && rfloor.winner === null);
	const rhit = await route({
		userMessage: "which renderer renders previews?",
		blocks: floorBlocks,
		currentSession: "__selfcheck__",
		currentTurn: 99999,
		routingIntent: async () => ({ intent: "incident_specific", searchTerms: "which renderer renders previews?", needClarification: false, clarifyWhy: "" }),
		queryDims: async () => null,
		tokens: (s) => tokens(s),
	});
	check("route: floor keeps genuine hits ranked", rhit !== null && rhit.ranked.length > 0 && rhit.ranked[0].score > 0);
	// intent-targeted class bypass: failure-intent queries keep zero-evidence
	// failed blocks ranked (the intent IS the retrieval evidence for the class)
	const byBypass = [
		{ ...valid, id: "fv:1", session: "fv", tokensHybrid: ["renderer"] },
		{ ...dead1, id: "fd:1", session: "fd", tokensHybrid: ["redis"] },
	]
	const rbypass = await route({
		userMessage: "what did we try that failed?",
		blocks: byBypass,
		currentSession: "__selfcheck__",
		currentTurn: 99999,
		routingIntent: async () => ({ intent: "incident_specific", searchTerms: "what did we try that failed?", needClarification: false, clarifyWhy: "" }),
		queryDims: async () => null,
		tokens: (s) => tokens(s),
	});
	check("route: failure-intent keeps zero-evidence failed blocks ranked", rbypass !== null && rbypass.ranked.length === 1 && rbypass.ranked[0].block.id === "fd:1");

	// in-block verdicts (token-exact, hybrid-field based)
	const tok = (s: string) => tokens(s);
	check("inBlockVerdict: tried+failed+reverted → failed", inBlockVerdict(tok("tried the redis cache layer it failed under load and we reverted to lru")) === "failed");
	check("inBlockVerdict: retry-config NOUN attempts never failed", inBlockVerdict(tok("let's retry failed posts 5 times with a fixed 2s delay, 3 attempts")) === null);
	check("inBlockVerdict: hedged future → speculative", inBlockVerdict(tok("maybe someday we could add a plugin system, no commitment, just ideas floating")) === "speculative");
	check("inBlockVerdict: plain decision stays valid", inBlockVerdict(tok("confirmed the webview panel is the docs preview renderer")) === null);

	// consolidation end-to-end in the sandbox store: supersession pair assigned
	const older: Block = {
		id: "pair:1", session: "pair", sessionFile: "/tmp/a.jsonl", firstTurn: 1, lastTurn: 4,
		gist: null, intent: null, dims: {},
		tokensHybrid: [...tok("webview panel is the docs preview renderer for larkspur exporter wiring it into the preview pipeline confirmed embeds gated behind the docs flag ship the webview previews release")].sort(),
		head: "confirmed: the webview panel is the docs preview renderer, wiring it into the preview pipeline", closedAt: "2026-01-01T09:00:00.000Z",
	};
	const newer: Block = {
		id: "pair:2", session: "pair", sessionFile: "/tmp/b.jsonl", firstTurn: 1, lastTurn: 4,
		gist: null, intent: null, dims: {},
		tokensHybrid: [...tok("update docs previews webview panel broke sandboxing switched code previews static html renderer confirmed preview path webview out preview pipeline emits static html only ship static html previews release")].sort(),
		head: "update on the docs previews: the webview panel broke sandboxing, switched to the static-html renderer", closedAt: "2026-01-02T09:00:00.000Z",
	};
	rewriteBlocks([older, newer, valid]);
	const cr = await runConsolidation();
	const after = loadBlocks();
	check("consolidation: older superseded, newer stays valid", statusOf(after.find((b) => b.id === "pair:1")!) === "superseded" && statusOf(after.find((b) => b.id === "pair:2")!) === "valid");
	check("consolidation: idempotent re-run", (await runConsolidation()).changed === 0);
	check("consolidation: verdict trail recorded", loadLifecycle().supersessions.some((l) => l.older === "pair:1" && l.newer === "pair:2" && l.source === "heuristic-lexical"));
}

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall checks passed");
