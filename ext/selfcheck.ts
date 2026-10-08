/**
 * pi-majordome self-check — offline assertion battery (no network), plus an
 * optional --parity mode that recomputes the slice-1 clustering accuracy
 * (EMA 0.903) against the real reference session. Port == bench or it
 * doesn't ship.
 *
 *   npx tsx ext/selfcheck.ts            # assertions
 *   npx tsx ext/selfcheck.ts --parity   # + replay parity vs bench/key.json
 */
import { writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSession, tokens, jaccard, detectBoundaries, blockCores, bm25Rank, federatedOrder, cosineVec } from "./core.ts";
import { parseDims, routingIntent, setClassifyFn, resetClassifyFn } from "./judges.ts";
import { timeTravel, rankArm, route, injectionText, judgeLine, docsNudge, scanDocsTouched, armFor, slugScopeFrom, slugOfBlock } from "./router.ts";
import { resolveWorkerRef } from "./orch.ts";
import { ingestDocs } from "./ingest_docs.ts";
import { composeKind, digest, filterBlocks } from "./docs.ts";
import type { BlockStatus, Block } from "./store.ts";
import type { PanelGrader } from "./panel.ts";

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
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "jev-only-trails.jsonl"); // hermetic: intent trails land here, never the real store
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

// ── v2.6 @slug hard scope + orch slug aliases ──
{
	const mk = (session: string, terms: string[], status?: BlockStatus): Block => ({
		id: `${session}:1`, session, sessionFile: `/x/${session}/s.jsonl`, firstTurn: 1, lastTurn: 2,
		gist: null, intent: null, dims: {}, tokensHybrid: terms, head: terms.join(" "), closedAt: "2026-01-01T00:00:00Z", ...(status ? { status } : {}),
	});
	const main = mk("lcb02", ["renderer", "previews", "docs"]);
	const mainDead = { ...mk("lcb02", ["webview", "renderer"]), id: "lcb02:9", firstTurn: 9, status: "failed" as const };
	const other = mk("lineage:other-project", ["renderer", "widgets", "pipeline"]);
	const routeOpts = (userMessage: string) => ({
		userMessage,
		blocks: [main, mainDead, other],
		currentSession: "__selfcheck__",
		currentTurn: 99999,
		routingIntent: async () => ({ intent: "incident_specific", searchTerms: userMessage, needClarification: false, clarifyWhy: "" }),
		queryDims: async () => null,
		tokens: (s: string) => tokens(s),
	});

	const r1 = await route(routeOpts("@lcb02 which renderer renders the docs previews?"));
	check("slug scope: hard-scopes ranked results to the named slug", r1 !== null && r1.slugScope?.[0] === "lcb02" && r1.ranked.length === 1 && r1.ranked[0].block.id === "lcb02:1");
	check("slug scope: @ sigil stripped from retrieval terms", r1 !== null && !r1.terms.includes("@") && r1.terms.includes("lcb02"));
	const r2 = await route(routeOpts("@Other-Project how does the widget renderer pipeline work?"));
	check("slug scope: case-insensitive, lineage: prefix handled, other slug scoped", r2 !== null && r2.slugScope?.[0] === "other-project" && r2.ranked.length >= 1 && r2.ranked.every((s) => slugOfBlock(s.block) === "other-project"));
	const r3 = await route(routeOpts("@nobody which renderer renders previews?"));
	check("slug scope: unknown @token stays plain text (no scope, priors rank all)", r3 !== null && r3.slugScope === null && r3.ranked.length === 2); // failed mainDead still lifecycle-excluded
	const piSlugBlock = mk("--home-aurel-Documents-current-code-parser--", ["renderer"]);
	const r4 = await route({ ...routeOpts("@code-parser which renderer renders previews?"), blocks: [piSlugBlock, main, other] });
	check("slug scope: matches shortTag of pi cwd slugs", r4 !== null && r4.slugScope?.[0] === "code-parser" && r4.ranked.length === 1 && r4.ranked[0].block.session === "--home-aurel-Documents-current-code-parser--");
	const r5 = await route(routeOpts("@lcb02 which renderer renders the docs previews?"));
	check("slug scope: lifecycle filter still applies on top (failed excluded)", r5 !== null && !r5.ranked.some((s) => s.block.id === "lcb02:9"));
	const r6 = await route(routeOpts("@lcb02 what did we try that failed?"));
	check("slug scope: failure-intent still applies inside the scope", r6 !== null && r6.ranked.length >= 1 && r6.ranked.some((s) => s.block.id === "lcb02:9"));
	check("slugScopeFrom: no @tokens → null (behavior unchanged)", slugScopeFrom("plain query about renderers", [main, other]) === null);

	const workers = [
		{ name: "office-parser", cwd: "/home/a/Code/office-parser" },
		{ name: "termaid", cwd: "/home/a/Code/termaid" },
		{ name: "side-quest", cwd: "/home/a/vibe/renamed-dir" },
	];
	check("orch ref: numeric addressing", resolveWorkerRef("2", workers)?.name === "termaid");
	check("orch ref: bare slug = worker name, case-insensitive", resolveWorkerRef("Termaid", workers)?.name === "termaid");
	check("orch ref: @slug form resolves the same worker", resolveWorkerRef("@termaid", workers)?.name === "termaid");
	check("orch ref: slug falls back to cwd basename", resolveWorkerRef("office-parser", workers)?.name === "office-parser" && resolveWorkerRef("renamed-dir", workers)?.name === "side-quest");
	check("orch ref: unknown slug → null (caller lists known slugs)", resolveWorkerRef("@ghost", workers) === null && resolveWorkerRef("99", workers) === null);
}

// ── magic-docs v2: per-slug cursors, legacy migration, verdict nudge, subagent exclusion ──
{
	const savedApiKey = process.env.TYPELLM_API_KEY; // hermetic: pin the offline config
	delete process.env.TYPELLM_API_KEY;
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose"); // judges fail open
	const { resetClassifyFn } = await import("./judges.ts");
	resetClassifyFn();
	const { cursorKey, cursorForDoc, cursorForSession, docsVerdictNudge, verdictToNudge } = await import("./router.ts");
	const { isSubagentSession } = await import("./core.ts");
	const { docsVerdict } = await import("./judges.ts");

	// legacy cursor migration: plain doc keys read as the CURRENT session's slug
	const legacy = { README: "2026-10-01T00:00:00Z" };
	check("cursor: legacy plain key migrates leniently to the reading slug", cursorForDoc(legacy, "code-parser", "README") === "2026-10-01T00:00:00Z");
	check("cursor: per-slug key format is slug:docName", cursorKey("code-parser", "README") === "code-parser:README");
	// per-slug isolation: repo X's touch never moves repo Y's cursor
	const cur = { "code-parser:README": "2026-10-03T00:00:00Z" };
	check("cursor: per-slug key reads back for its own slug", cursorForDoc(cur, "code-parser", "README") === "2026-10-03T00:00:00Z");
	check("cursor: repo X's touch invisible to repo Y", cursorForDoc(cur, "termaid", "README") === undefined);
	check("cursor: per-slug key wins over legacy for its own slug", cursorForDoc({ ...legacy, ...cur }, "code-parser", "README") === "2026-10-03T00:00:00Z");
	const view = cursorForSession({ "code-parser:README": "t1", "termaid:README": "t3", "code-parser:docs/": "t4", README: "t5-legacy" }, "code-parser");
	check("cursor: session view — own stripped, other slugs dropped, legacy kept, per-slug wins", JSON.stringify(view) === JSON.stringify({ README: "t1", "docs/": "t4" }));

	// fallback threshold on per-slug cursors (the arithmetic rule stays exact)
	const SFY = "/h/.pi/agent/sessions/--home-u-repoy--/s.jsonl";
	const implY = ["a", "b", "c"].map((g, i) => ({ sessionFile: SFY, intent: "implementation", gist: `built ${g}`, closedAt: `2026-10-0${i + 1}T12:00:00Z` }));
	check("docsNudge v2: other repo's cursor never covers this repo's work", (docsNudge(implY as any, SFY, { "--home-u-repox--:README": "2026-10-05T00:00:00Z" }) ?? "").includes("3 implementation blocks"));
	check("docsNudge v2: own repo legacy cursor still suppresses covered work", docsNudge(implY as any, SFY, { README: "2026-10-05T00:00:00Z" }) === null);
	check("docsNudge v2: own per-slug cursor suppresses", docsNudge(implY as any, SFY, { "--home-u-repoy--:README": "2026-10-05T00:00:00Z" }) === null);

	// verdict-driven nudge: names slug + kind, grounded; quiet on false/fresh-cursor
	const work = [{ id: "code-parser:12", gist: "added --jobs flag for parallel workers", closedAt: "2026-10-04T12:00:00Z" }];
	const vn = verdictToNudge({ docsWorthy: true, kind: "changelog" }, {}, "--home-u-code-parser--", work);
	check("verdict nudge: names slug + kind + gist + id", !!vn && vn!.includes("code-parser") && vn!.includes("changelog") && vn!.includes("--jobs") && vn!.includes("code-parser:12"));
	check("verdict nudge: docsWorthy=false → no nudge regardless of count", verdictToNudge({ docsWorthy: false, kind: null }, {}, "s", work) === null);
	check("verdict nudge: fresh cursor (docs touched this turn) → quiet", verdictToNudge({ docsWorthy: true, kind: "readme" }, { "--home-u-code-parser--:README": "2026-10-04T13:00:00Z" }, "--home-u-code-parser--", work) === null);
	check("verdict nudge: other repo's cursor never covers this repo", !!verdictToNudge({ docsWorthy: true, kind: "adr" }, { "--home-u-repox--:docs/": "2026-10-09T00:00:00Z" }, "--home-u-code-parser--", work));
	const vnText = docsVerdictNudge("code-parser", "adr", [{ id: "code-parser:12", gist: "chose sqlite over postgres" }]);
	check("verdict nudge text: grounded like the arithmetic nudge", vnText.includes("code-parser") && vnText.includes("adr") && vnText.includes("sqlite"));

	// subagent exclusion filter (the one filter all sweepers share)
	check("subagent exclusion: scratch session paths filtered", isSubagentSession("/h/.pi/agent/sessions/--home-u-repo-.git-subagents-run_x-task_1--/2026-01-01T00-00-00-000Z_a.jsonl") && isSubagentSession("--home-u-repo-.git-subagents-run_x-task_1--"));
	check("subagent exclusion: normal sessions pass", !isSubagentSession("/h/.pi/agent/sessions/--home-u-repo--/s.jsonl") && !isSubagentSession("--home-u-repo--"));

	// offline fail-open: no key + no classifier → null (caller keeps arithmetic rule)
	check("docsVerdict: offline fail-open null", (await docsVerdict("implemented retry with backoff")) === null);
	if (savedApiKey !== undefined) process.env.TYPELLM_API_KEY = savedApiKey;
}

// ── magic-docs v2.7: docs profiles + brownfield seeding (TASK D) ──
{
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose"); // hermetic
	delete process.env.TYPELLM_API_KEY;
	const { watchRegexFor, detectDocsProfile, readDocsOverride, resolveDocsProfile, seedDocsCursor, brownfieldDocDates, adoptionLine, profileNoteLine, BUILTIN_DOC_WATCH, isValidDocsProfile } = await import("./docsprofile.ts");
	const { mkdirSync: mkd, writeFileSync, utimesSync } = await import("node:fs");

	// 1. generalized touch matcher: built-ins byte-identical, custom names bounded
	check("watch: built-in matcher unchanged by profiles", JSON.stringify(scanDocsTouched('"path":"docs/README.md" "path":"CHANGELOG.md" "path":"docs/x.md"')) === JSON.stringify(["README", "CHANGELOG", "docs/"]));
	check("watch: custom name N → /N\\.md at a path boundary, case-insensitive", scanDocsTouched("edited src/Notes.MD today", ["NOTES"]).join(",") === "NOTES" && scanDocsTouched("see vendor/notes.md", ["NOTES"]).length === 1 && scanDocsTouched("footer-notes.md and prompts/notes.txt untouched", ["NOTES"]).length === 0);
	check("watch: regex metachars in custom names are escaped", scanDocsTouched("a/docs/b(c).md edited", ["b(c)"]).length === 1);
	check("watch: built-in regex behavior preserved verbatim", (() => {
		const wr = watchRegexFor("README");
		return wr.test('"path":"docs/README.md"') && wr.test('"repo\\\\README.md"') && !wr.test("plain README.md prose") && !wr.test('"x/footer-readme.md"') && watchRegexFor("docs/").test('"path":"docs/api"') && !watchRegexFor("docs/").test('"path":"docsx/api"');
	})());

	// 1b. status.json built-in (the deliverable ledger): touch regex mirrors
	// CHANGELOG's, coding default grows to README+CHANGELOG+status.json+docs/,
	// generic stays docs/ only, custom overrides still win
	check("watch: built-ins are README+CHANGELOG+STATUS+docs/", JSON.stringify(BUILTIN_DOC_WATCH) === JSON.stringify(["README", "CHANGELOG", "STATUS", "docs/"]));
	check("watch: STATUS touch regex mirrors CHANGELOG (path boundary, case-insensitive; export md + status.json)", (() => {
		const wr = watchRegexFor("STATUS");
		return wr.test('"path":"docs/STATUS.md"') && wr.test('"repo\\\\STATUS.md"') && wr.test('"x/status.md"') && wr.test('"x/status.json"') && !wr.test("plain STATUS.md prose") && !wr.test('"x/footer-status.md"') && !wr.test('"x/footer-status.json"') && !watchRegexFor("CHANGELOG").test('"path":"STATUS.md"');
	})());
	check("profile: custom override still wins over the detected coding default", (() => {
		const repoO = join(tmp, "prof-override-coding");
		mkd(join(repoO, ".majordome"), { recursive: true });
		writeFileSync(join(repoO, "package.json"), "{}");
		writeFileSync(join(repoO, ".majordome", "docs.json"), '{"watch":["NOTES"]}');
		const r = resolveDocsProfile(repoO, null);
		return r.source === "override" && r.watch.join(",") === "NOTES";
	})());
	// a STATUS touch (the generated export md, or any status.json shape of the
	// same rows) satisfies the docs nudge like README/CHANGELOG: the cursor
	// advances (the exact index.ts turn_end wiring) and covers the work
	const { cursorKey } = await import("./router.ts");
	const SFS = "/h/.pi/agent/sessions/--home-u-repos--/s.jsonl";
	const implS = ["a", "b", "c"].map((g, i) => ({ sessionFile: SFS, intent: "implementation", gist: `built ${g}`, closedAt: `2026-10-0${i + 1}T12:00:00Z` }));
	const stCur: Record<string, string> = {};
	for (const doc of scanDocsTouched('"file":"/repo/STATUS.md"')) stCur[cursorKey("--home-u-repos--", doc)] = "2026-10-02T00:00:00Z";
	check("nudge: STATUS.md touch scans as a built-in and satisfies the nudge (cursor covers)", scanDocsTouched('"file":"/repo/STATUS.md"').join(",") === "STATUS" && stCur["--home-u-repos--:STATUS"] === "2026-10-02T00:00:00Z" && docsNudge(implS as any, SFS, stCur) === null);
	check("nudge: without the STATUS touch the nudge still fires at 3", (docsNudge(implS as any, SFS, {}) ?? "").includes("3 implementation blocks"));

	// 2. profile resolution precedence: override > stored > detected
	const repoC = join(tmp, "prof-coding");
	const repoG = join(tmp, "prof-generic");
	mkd(join(repoC, "lib"), { recursive: true });
	writeFileSync(join(repoC, "Cargo.toml"), "[package]\n");
	mkd(join(repoG, "docs"), { recursive: true });
	check("profile: code manifest → coding (README+CHANGELOG+STATUS+docs/)", JSON.stringify(detectDocsProfile(repoC)) === JSON.stringify({ watch: [...BUILTIN_DOC_WATCH], source: "detected-coding" }));
	// legacy stored profiles canonicalize at resolve time — a pre-rename
	// "STATUS" entry keeps watching the ledger under the canonical name
	check("profile: stored legacy STATUS watch canonicalizes to STATUS", resolveDocsProfile(repoC, { watch: ["README", "STATUS", "NOTES"], source: "detected-coding" }).watch.join(",") === "README,STATUS,NOTES");
	const repoCabal = join(tmp, "prof-cabal");
	mkd(repoCabal, { recursive: true });
	writeFileSync(join(repoCabal, "majordome.cabal"), "cabal-version: 3.0\n");
	check("profile: glob manifests (*.cabal, *.csproj) count as code markers", detectDocsProfile(repoCabal).source === "detected-coding");
	check("profile: no manifest → generic (docs/)", detectDocsProfile(repoG).source === "detected-generic" && detectDocsProfile(repoG).watch.join(",") === "docs/");
	mkd(join(repoG, ".majordome"), { recursive: true });
	writeFileSync(join(repoG, ".majordome", "docs.json"), '{"watch":["README","CHANGELOG","docs/"]}');
	check("profile: override > stored > detected", resolveDocsProfile(repoG, { watch: ["NOTES"], source: "stored" }).source === "override" && resolveDocsProfile(repoG, null).watch.join(",") === "README,CHANGELOG,docs/" && resolveDocsProfile(repoC, null).source === "detected-coding");
	writeFileSync(join(repoG, ".majordome", "docs.json"), "not json at all");
	check("profile: invalid override fails open to stored/detected", resolveDocsProfile(repoG, { watch: ["NOTES"], source: "stored" }).watch.join(",") === "NOTES" && resolveDocsProfile(repoG, null).source === "detected-generic" && readDocsOverride(repoG) === "invalid");
	check("profile: watch shape validation rejects junk", !isValidDocsProfile({ watch: [] }) && !isValidDocsProfile({ watch: [42] }) && !isValidDocsProfile("watch") && isValidDocsProfile({ watch: ["README"], source: "x" }));
	check("profile: init note lines format headless-safe", profileNoteLine({ watch: ["docs/"], source: "detected-generic" }, false).includes('docs profile: generic (no code markers) — override: .majordome/docs.json {"watch":[...]}') && profileNoteLine({ watch: ["NOTES"], source: "override" }, false).includes("override .majordome/docs.json"));

	// 3. brownfield seeding: absent keys only → idempotent
	const seedCur = { "code-parser:README": "2026-10-20T00:00:00Z" };
	const findings = [{ doc: "README", date: "2026-10-01T00:00:00Z" }, { doc: "CHANGELOG", date: "2026-09-01T00:00:00Z" }];
	const s1 = seedDocsCursor(seedCur, "code-parser", findings);
	check("seed: absent keys seeded with the real dates", s1.seeded.length === 1 && s1.next["code-parser:README"] === "2026-10-20T00:00:00Z" && s1.next["code-parser:CHANGELOG"] === "2026-09-01T00:00:00Z");
	const s2 = seedDocsCursor(s1.next, "code-parser", findings);
	check("seed: idempotent — second run changes nothing", s2.seeded.length === 0 && JSON.stringify(s2.next) === JSON.stringify(s1.next));
	check("seed: per-slug isolation (other slugs untouched)", !("termaid:CHANGELOG" in s1.next));

	// 4. real file dates (mtime path — fixture has no .git) + docs/ dir newest
	const bfRepo = join(tmp, "brownfield");
	mkd(join(bfRepo, "docs", "deep"), { recursive: true });
	writeFileSync(join(bfRepo, "README.md"), "# x");
	writeFileSync(join(bfRepo, "docs", "a.md"), "a");
	writeFileSync(join(bfRepo, "docs", "deep", "b.md"), "b");
	const old = new Date("2026-05-05T05:05:05.000Z");
	const fresh = new Date("2026-10-01T00:00:00.000Z");
	utimesSync(join(bfRepo, "README.md"), old, old);
	utimesSync(join(bfRepo, "docs", "a.md"), old, old);
	utimesSync(join(bfRepo, "docs", "deep", "b.md"), fresh, fresh);
	const found = brownfieldDocDates(bfRepo);
	check("seed: file mtime used verbatim (git-free fixture invents nothing)", found.find((f) => f.doc === "README")?.date === old.toISOString());
	check("seed: docs/ dir takes the NEWEST *.md within depth ≤2", found.find((f) => f.doc === "docs/")?.date === fresh.toISOString());
	check("seed: adoption line format", adoptionLine(found.slice(0, 1)).startsWith("docs adopted: README ← 2026-05-05") && adoptionLine(found.slice(0, 1)).endsWith("(cursors seeded)"));

	// 5. profile-filtered nudges (both paths) — generic repos stay quiet
	const SFZ = "/h/.pi/agent/sessions/--home-u-repoz--/s.jsonl";
	const implZ = ["a", "b", "c"].map((g, i) => ({ sessionFile: SFZ, intent: "implementation", gist: `built ${g}`, closedAt: `2026-10-0${i + 1}T12:00:00Z` }));
	check("nudge: generic profile → no README/CHANGELOG arithmetic nudge", docsNudge(implZ as any, SFZ, {}, ["docs/"]) === null);
	check("nudge: coding profile → fires at 3 (default byte-identical)", (docsNudge(implZ as any, SFZ, {}) ?? "").startsWith("[majordome docs] 3 implementation blocks"));
	check("nudge: unwatched cursor entries never suppress", docsNudge(implZ as any, SFZ, { "--home-u-repoz--:CHANGELOG": "2026-10-31T00:00:00Z" }, ["docs/"]) === null);
	const { verdictToNudge } = await import("./router.ts");
	const zw = [{ id: "z:1", gist: "shipped the exporter", closedAt: "2026-10-03T00:00:00Z" }];
	check("nudge: changelog verdict quiet in generic repo, adr still fires", verdictToNudge({ docsWorthy: true, kind: "changelog" }, {}, "z", zw, ["docs/"]) === null && !!verdictToNudge({ docsWorthy: true, kind: "adr" }, {}, "z", zw, ["docs/"]));

	// 6. meta round-trip: docsProfile persists and survives dims/cursor-only saves
	process.env.MAJORDOME_DIR = join(tmp, "profile-store");
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "profile-trails.jsonl");
	const st2 = await import("./store.ts");
	st2.saveMeta({ dims: ["a"], docsCursor: {}, docsProfile: { watch: ["NOTES"], source: "detected-generic" } });
	check("meta: docsProfile round-trips through the store", st2.loadMeta().docsProfile?.watch.join(",") === "NOTES");
	st2.saveMeta({ dims: ["b"], docsCursor: { "z:README": "t" } }); // dims/cursor callers must not clobber
	const kept = st2.loadMeta();
	check("meta: dims/cursor saves preserve docsProfile", kept.docsProfile?.watch.join(",") === "NOTES" && kept.docsCursor["z:README"] === "t" && kept.dims.join(",") === "b");
	delete process.env.MAJORDOME_DIR;
}

// ── outputShape routing (third axis) ──
{
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose"); // hermetic
	delete process.env.TYPELLM_API_KEY;
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "shape-trails.jsonl");
	const { shapeVerdict, userPrefLines, resetUserPrefs, OUTPUT_SHAPES } = await import("./judges.ts");
	const { shapeHintLine } = await import("./router.ts");
	resetClassifyFn();

	check("shape: enum has the six ladder values", JSON.stringify(OUTPUT_SHAPES) === JSON.stringify(["default", "terse", "diagram-first", "table", "walkthrough", "artifact"]));
	check("shape: hint line only for non-default shapes", shapeHintLine("default") === null && shapeHintLine("bogus") === null && (shapeHintLine("diagram-first") ?? "").startsWith("[majordome shape] diagram-first — "));
	check("shape: hint is suggest-only advice, never a tool order", ![shapeHintLine("artifact"), shapeHintLine("walkthrough"), shapeHintLine("table")].some((l) => /\b(run|execute|invoke|call)\b/i.test(l ?? "")));

	// fail-open: no key + no classifier → null (never throws, never guesses)
	let shapeThrew = false;
	let shapeOffline: unknown = "sentinel";
	try {
		shapeOffline = await shapeVerdict("explain the recall pipeline", []);
	} catch {
		shapeThrew = true;
	}
	check("shape: offline fail-open null (never throws)", !shapeThrew && shapeOffline === null);

	// canned Jev verdicts parse through the same settle path; malformed → null
	setClassifyFn(async () => ({ model: "canned", answers: { shape: { choice: "table" } } }));
	const vTab = await shapeVerdict("compare the regex parser and the combinator parser");
	check("shape: canned Jev choice parses to a verdict", vTab?.shape === "table");
	check("shape: default verdict → zero injection (null line)", shapeHintLine("default", "ok") === null && shapeHintLine("table", "comparing parsers") !== null);

	// preference fixtures must exist BEFORE the preference-context judge below:
	// userPrefLines() reads MAJORDOME_USER_FILE (user.json) + MAJORDOME_USER_MD_FILE
	// (user.md prose) at judge time (cached per session), so env has to be in
	// place first. user.json lines come FIRST (answer_shape + preference pairs),
	// prose fills after — the merge the shape judge sees.
	const userJsonFile = join(tmp, "user-fixture.json");
	writeFileSync(userJsonFile, JSON.stringify({ updated: "2026-10-07", answer_shape: "diagram-first", preferences: [{ key: "naming", value: "our app's name, never the origin tool's", added: "2026-10-07", source: "captain" }], query_style: { avg_topics_per_query: 0, samples: 0, imperative_ratio: 0 }, confidence_calibration: [] }));
	const userFile = join(tmp, "user-fixture.md");
	writeFileSync(userFile, "# personal rules (comment line)\n\n- Prefer a diagram over prose for flow questions.\n- Keep answers STE-80 short.\n");
	process.env.MAJORDOME_USER_FILE = userJsonFile;
	process.env.MAJORDOME_USER_MD_FILE = userFile;
	resetUserPrefs();

	let seenState: any = null;
	setClassifyFn(async (state) => {
		seenState = state;
		return { model: "canned", answers: { shape: { choice: "diagram-first" } } };
	});
	const vDia = await shapeVerdict("explain the recall pipeline");
	resetClassifyFn();
	check("shape: preference context reaches the judge state", vDia?.shape === "diagram-first" && String(seenState?.prefs ?? "").includes("diagram"));
	setClassifyFn(async () => ({ model: "canned", answers: { shape: "diagram" } })); // not in enum
	const vBad = await shapeVerdict("anything");
	setClassifyFn(async () => ({ model: "canned", answers: {} }));
	const vEmpty = await shapeVerdict("anything");
	setClassifyFn(async () => {
		throw new Error("transport down");
	});
	let vThrow: unknown = "sentinel";
	let throwThrew = false;
	try {
		vThrow = await shapeVerdict("anything");
	} catch {
		throwThrew = true;
	}
	resetClassifyFn();
	check("shape: malformed/empty/thrown judge answers → null (fail-open)", vBad === null && vEmpty === null && !throwThrew && vThrow === null);

	// user.md preference context: lines read, comments/blanks stripped, cache
	// per session until resetUserPrefs() (fixture + env set up above)
	const lines1 = userPrefLines();
	writeFileSync(userFile, "- rewritten on disk after the cache\n");
	const lines2 = userPrefLines(); // same process → cached
	resetUserPrefs();
	const lines3 = userPrefLines(); // re-read
	process.env.MAJORDOME_USER_MD_FILE = join(tmp, "definitely-missing-user.md");
	resetUserPrefs();
	const lines4 = userPrefLines(); // json still read, prose missing → json only
	resetUserPrefs();
	delete process.env.MAJORDOME_USER_FILE;
	delete process.env.MAJORDOME_USER_MD_FILE;
	delete process.env.MAJORDOME_TRAIL_FILE;
	check("shape: user.json lines first (answer_shape + prefs), user.md prose after, comments/blanks stripped", lines1.length === 4 && lines1[0] === "user's standing output preference: answer_shape=diagram-first" && lines1[1] === "naming=our app's name, never the origin tool's" && (lines1[2] ?? "").includes("diagram") && !lines1.join("|").includes("personal rules"));
	check("shape: prefs cached per session until reset", lines2.length === 4 && lines3.length === 3 && lines4.length === 2);
	check("shape: user.json absent → defaults (auto shape, no lines)", (() => {
		process.env.MAJORDOME_USER_FILE = join(tmp, "definitely-missing-user.json");
		process.env.MAJORDOME_USER_MD_FILE = join(tmp, "definitely-missing-user.md");
		resetUserPrefs();
		const none = userPrefLines();
		delete process.env.MAJORDOME_USER_FILE;
		delete process.env.MAJORDOME_USER_MD_FILE;
		resetUserPrefs();
		return none.length === 0;
	})());
}

// ── panel grading (majority-of-available-engines, ext/panel.ts) ──
{
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose"); // hermetic
	delete process.env.TYPELLM_API_KEY;
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "panel-trails.jsonl");
	const { readFileSync: rfsP } = await import("node:fs");
	const { gradeWithPanel, majorityFacts, panelGraders } = await import("./panel.ts");
	const { setClassifyFn, resetClassifyFn } = await import("./judges.ts");
	resetClassifyFn();

	// the pure majority rule (per fact: present iff 2·yes ≥ graders served)
	check("panel: majority 2v1 picks the two", JSON.stringify(majorityFacts([[true, false], [true, false], [false, true]], 2)) === JSON.stringify([true, false]));
	check("panel: 3-0 unanimous", JSON.stringify(majorityFacts([[true, true], [true, true], [true, true]], 2)) === JSON.stringify([true, true]));
	check("panel: single grader — its verdict stands", JSON.stringify(majorityFacts([[true, false]], 2)) === JSON.stringify([true, false]));
	check("panel: even-panel tie resolves presence-ward", JSON.stringify(majorityFacts([[true, false], [false, true]], 2)) === JSON.stringify([true, true]));
	check("panel: 1v2 on three graders → absent; 2v1 → present", majorityFacts([[true], [false], [false]], 1)[0] === false && majorityFacts([[true], [true], [false]], 1)[0] === true);

	// canned grader outputs through the real seam (injection = bench-only option)
	let calls = 0;
	const grader = (engine: string, votes: boolean[] | null | Error): PanelGrader => ({
		engine,
		run: async () => {
			calls++;
			if (votes instanceof Error) throw votes;
			return votes ? { votes } : null;
		},
	});

	// 2v1 split across three graders → majority settles it
	calls = 0;
	const r21 = await gradeWithPanel(["fact one", "fact two"], "OUT-SECRET-β", { prompt: "PROMPT-SECRET-α", label: "selfcheck:panel", graders: [grader("a", [true, false]), grader("b", [true, true]), grader("c", [false, false])] });
	check("panel: 2v1 split settles on the two (1 of 2 facts)", r21.found === 1 && r21.total === 2);
	check("panel: 2v1 — all three graders served, not variance-prone", r21.graders.length === 3 && r21.varianceProne === false && calls === 3);
	check("panel: per-grader verdicts recorded (1,2,0)", JSON.stringify(r21.perGrader.map((g) => g.found)) === JSON.stringify([1, 2, 0]));

	// 3-0 unanimity
	const r30 = await gradeWithPanel(["x"], "y", { prompt: "p", graders: [grader("a", [true]), grader("b", [true]), grader("c", [true])] });
	check("panel: 3-0 unanimous 1/1", r30.found === 1 && r30.varianceProne === false);

	// single-grader run: verdict stands, variance-marked
	const r1 = await gradeWithPanel(["x", "z"], "y", { prompt: "p", graders: [grader("solo", [true, false])] });
	check("panel: single grader — its verdict stands and is variance-marked", r1.found === 1 && r1.varianceProne === true && JSON.stringify(r1.graders) === JSON.stringify(["solo"]));

	// a failed grader is excluded, never a no-vote; remaining two settle (tie → presence-ward)
	const rFail = await gradeWithPanel(["x"], "y", { prompt: "p", graders: [grader("dead", new Error("transport down")), grader("a", [true]), grader("b", [false])] });
	check("panel: failed grader excluded (recorded found:null) — remaining two settle presence-ward", rFail.found === 1 && rFail.graders.join("+") === "a+b" && rFail.perGrader.find((g) => g.engine === "dead")?.found === null);

	// every grader fails → fail-open null, never a pass
	const rAll = await gradeWithPanel(["x"], "y", { prompt: "p", graders: [grader("dead", new Error("down")), grader("mute", null)] });
	check("panel: every grader fails → found null (fail-open)", rAll.found === null && rAll.graders.length === 0);

	// a wrong-length vote vector is not a verdict
	const rLen = await gradeWithPanel(["x", "y2"], "z", { prompt: "p", graders: [grader("short", [true])] });
	check("panel: wrong-length vote vector excluded", rLen.found === null && rLen.perGrader[0]?.found === null);

	// empty panel
	const rNone = await gradeWithPanel(["x"], "y", { prompt: "p", graders: [] });
	check("panel: no graders configured → null, no call", rNone.found === null && rNone.attempted.length === 0);

	// the REAL composition seam: jev wired + no key → exactly one grader (never fabricated)
	setClassifyFn(async () => ({ model: "canned", answers: { fact_1: { noul: true }, fact_2: { noul: false } } }));
	const gJev = panelGraders();
	const rJev = await gradeWithPanel(["fact one", "fact two"], "answer text", { prompt: "p", label: "selfcheck:panel-jev" });
	resetClassifyFn();
	check("panel: configured engines only — jev wired, no key → single grader, variance-prone", gJev.length === 1 && gJev[0].engine === "jev" && rJev.found === 1 && rJev.varianceProne === true && rJev.graders.join("+") === "jev");
	check("panel: nothing configured → panelGraders() empty (no fabricated grader)", panelGraders().length === 0);

	// trail hygiene: per-grader lines (judge 'panel:<engine>'), composition on
	// the panelVerdict record, message text never
	const trailRaw = rfsP(join(tmp, "panel-trails.jsonl"), "utf8");
	const trailLines = trailRaw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	check("panel: trail — per-grader judge tags 'panel:<engine>', failures ok:false", trailLines.some((e: any) => e.j === "panelGrade" && e.judge === "panel:a" && e.ok === true) && trailLines.some((e: any) => e.j === "panelGrade" && e.judge === "panel:dead" && e.ok === false) && trailLines.some((e: any) => e.j === "panelGrade" && e.judge === "panel:jev" && e.ok === true));
	check("panel: trail — panelVerdict records carry composition + variance flag", trailLines.some((e: any) => e.j === "panelVerdict" && JSON.stringify(e.graders) === JSON.stringify(["a", "b", "c"]) && e.varianceProne === false) && trailLines.some((e: any) => e.j === "panelVerdict" && e.varianceProne === true));
	check("panel: trail — verdict metadata only, never message text", !trailRaw.includes("PROMPT-SECRET") && !trailRaw.includes("OUT-SECRET"));
	delete process.env.MAJORDOME_TRAIL_FILE;
}

// ── v2.8 judge-cost telemetry: trail aggregation + gap-rule coverage ──
{
	process.env.MAJORDOME_DIR = join(tmp, "telemetry-store");
	const trailPath = join(tmp, "telemetry-trails.jsonl");
	process.env.MAJORDOME_TRAIL_FILE = trailPath;
	const { readFileSync: rfs } = await import("node:fs");
	const { aggregate, judgeStatsLines, JUDGE_LINES, trail, setTrailTurn } = await import("./trail.ts");
	const st3 = await import("./store.ts");
	st3.saveMeta({ dims: [], docsCursor: {}, turns: 150 });
	setTrailTurn(150);
	// fixture: intent ×3 (one fail-open), shape + docs ok (estTokens reported),
	// decision records (consolidate/docsNudge) that must NOT count as calls,
	// one corrupt line the scan must skip
	writeFileSync(
		trailPath,
		[
			JSON.stringify({ t: "2026-01-01T00:00:00Z", j: "routingIntent", v: 1, judge: "typellm", intent: "definition_recall" }), // old schema: no turn
			JSON.stringify({ t: "2026-01-01T00:01:00Z", j: "routingIntent", v: 1, judge: "typellm", ok: false, turn: 149 }),
			JSON.stringify({ t: "2026-01-01T00:02:00Z", j: "routingIntent", v: 1, judge: "jev", ok: true, intent: "continuation", turn: 150 }),
			JSON.stringify({ t: "2026-01-01T00:03:00Z", j: "shapeVerdict", v: 1, judge: "jev", ok: true, shape: "table", turn: 150, estTokens: 120 }),
			JSON.stringify({ t: "2026-01-01T00:04:00Z", j: "docsVerdict", v: 1, judge: "typellm", ok: true, docsWorthy: true, kind: "readme", turn: 150, estTokens: 80.4 }),
			JSON.stringify({ t: "2026-01-01T00:05:00Z", j: "consolidate", v: 1, pair: ["a:1", "a:2"], verdict: "contradicts", source: "heuristic-lexical", turn: 150 }),
			JSON.stringify({ t: "2026-01-01T00:06:00Z", j: "docsNudge", v: 1, source: "verdict", fired: true, turn: 150 }),
			"not json at all",
		].join("\n") + "\n",
	);
	const ag = aggregate();
	check("telemetry: judge lines counted exactly", ag.byJudge.routingIntent?.calls === 3 && ag.byJudge.shapeVerdict?.calls === 1 && ag.byJudge.docsVerdict?.calls === 1 && ag.total === 5);
	check("telemetry: ok/fail-open split (ok !== false reads ok)", ag.byJudge.routingIntent?.ok === 2 && ag.byJudge.routingIntent?.failOpen === 1 && ag.byJudge.shapeVerdict?.failOpen === 0);
	check("telemetry: decision records never counted as judge calls", ag.byJudge.consolidate === undefined && ag.byJudge.docsNudge === undefined);
	check("telemetry: corrupt line skipped, lines scanned counted", ag.lines === 7);
	check("telemetry: today counts only today's UTC lines", ag.today === 0); // fixture dated 2026-01-01
	check("telemetry: estTokens summed where reported", ag.estTokens === 200 && ag.byJudge.shapeVerdict?.estTokens === 120 && ag.byJudge.docsVerdict?.estTokens === 80);
	check("telemetry: turns from meta", ag.turns === 150 && ag.tagged === 4); // judge lines with a turn cursor (decision records excluded)
	check("telemetry: last-100-turn window (turn > turns-100)", ag.callsLast100 === 4 && ag.avgPerTurn === 0.04); // 4 calls / min(100,150)
	// new-line turn cursor + sinceTurn windowing
	setTrailTurn(151);
	trail("routingIntent", { judge: "typellm", ok: true });
	const ag2 = aggregate();
	check("telemetry: turn cursor stamped onto new lines", ag2.tagged === 5 && ag2.callsLast100 === 5 && ag2.total === 6);
	check("telemetry: sinceTurn cursor windows the scan", aggregate(151).total === 1 && aggregate(151).byJudge.routingIntent?.calls === 1);
	// stats formatting smoke (the /majordome judge-cost section)
	const statsLines = judgeStatsLines(ag2);
	check("telemetry: stats line shape", statsLines.length === 2 && statsLines[0].startsWith("judge calls: 6 total · 1 today · avg 0.05/turn (last 100 turns)") && statsLines[1].startsWith("by judge: intent 4"));
	check("telemetry: stats tags + ok/fail-open percentages", statsLines[1].includes("shape 1") && statsLines[1].includes("docs 1") && statsLines[1].endsWith("(ok 83% · fail-open 17%)"));
	check("telemetry: estTokens surfaced in stats", statsLines[0].includes("~200 tok"));
	check("telemetry: stats section empty on an empty trail", judgeStatsLines({ ...ag2, total: 0 }).length === 0);

	// gap-rule (static): every judge entry point must trail-record inside its
	// own function body — a judge call site without a trail line fails here
	const src = rfs(new URL("./judges.ts", import.meta.url), "utf8");
	const panelSrc = rfs(new URL("./panel.ts", import.meta.url), "utf8"); // panelGrade lines live in ext/panel.ts
	const fnSrc = (name: string): string => (name === "gradeWithPanel" ? panelSrc : src).match(new RegExp(`export (async )?function ${name}\\b[\\s\\S]*?\\n}`))?.[0] ?? "";
	const trailHome: Record<string, string[]> = { shapeVerdict: ["shapeVerdict", "settleShape"], panelGrade: ["gradeWithPanel"] }; // judge → fns that may trail for it
	const missing = JUDGE_LINES.filter((j) => !(trailHome[j] ?? [j]).some((fn) => fnSrc(fn).includes(`trail("${j}"`)));
	check("telemetry: gap-rule — every judge line name is trailed in its function", missing.length === 0 && fnSrc("dimVector").includes('trail("dimVector"'));

	// gap-rule (runtime): judges that reach the transport with no key fail open
	// AND trail-record ok:false — zero network (generate exits before fetch)
	delete process.env.TYPELLM_API_KEY;
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose");
	resetClassifyFn();
	writeFileSync(trailPath, "");
	const jm = await import("./judges.ts");
	await jm.blockMeta("segment text about the watcher");
	await jm.routingIntent("remind me how the watcher works");
	await jm.dimVector("segment text", ["alpha_beta", "gamma_delta"], "segment");
	await jm.induceDims("segment text");
	await jm.rewriteQuery("remind me about the watcher");
	await jm.keyPhrases("segment text", "watcher query");
	const openLines = rfs(trailPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	for (const j of ["blockMeta", "routingIntent", "dimVector", "induceDims", "rewriteQuery", "keyPhrases"]) {
		check(`telemetry: ${j} trails its fail-open call (ok:false)`, openLines.some((l: any) => l.j === j && l.ok === false));
	}
	check("telemetry: dimVector records attempts, one line per invocation", openLines.filter((l: any) => l.j === "dimVector").length === 1 && openLines.find((l: any) => l.j === "dimVector")?.attempts === 3);
	// judges with no transport configured make NO call — correctly no trail line
	writeFileSync(trailPath, "");
	check("telemetry: contradicts/docsVerdict/shapeVerdict/lifecycleVerdict make no call when unconfigured", (await jm.contradicts("q", "g")) === false && (await jm.docsVerdict("work")) === null && (await jm.shapeVerdict("msg", [])) === null && (await jm.lifecycleVerdict("a", "b")) === null && rfs(trailPath, "utf8").trim() === "");
	delete process.env.MAJORDOME_DIR;
}

// ── v2.9 slice 1: fromUntrusted provenance (ingest/shared channels) ──
{
	process.env.MAJORDOME_DIR = join(tmp, "provenance-store");
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "provenance-trails.jsonl");
	const store1 = await import("./store.ts");
	const { isSharedSourcePath, listSharedSources, SHARED_SOURCES_DIR } = await import("./docsprofile.ts");
	const { mkdirSync: mkd } = await import("node:fs");

	// fixture: one configured docs source + one shared drop-dir file, different repos
	const repoD = join(tmp, "prov-docs");
	const repoS = join(tmp, "prov-shared");
	mkd(repoD, { recursive: true });
	mkd(join(repoS, SHARED_SOURCES_DIR), { recursive: true });
	writeFileSync(join(repoD, "adr-notes.md"), "# ADR notes\n\n## Renderer decision\n\nWe confirmed the webview panel is the docs preview renderer for all exports.\n");
	writeFileSync(join(repoS, SHARED_SOURCES_DIR, "shared-api.md"), "# Shared API\n\n## Auth contract\n\nThe service token rotates every twelve hours; cache it with the refresh jitter noted here.\n");
	process.env.MAJORDOME_DOCS_SOURCES = join(tmp, "docs-sources.json");
	writeFileSync(process.env.MAJORDOME_DOCS_SOURCES, JSON.stringify({ paths: [repoD] }));

	check("shared sources: drop-dir listed, sorted, md-only", JSON.stringify(listSharedSources(repoS)) === JSON.stringify([join(repoS, SHARED_SOURCES_DIR, "shared-api.md")]) && listSharedSources(repoD).length === 0 && listSharedSources(join(tmp, "missing-dir")).length === 0);
	check("shared sources: boundary predicate", isSharedSourcePath(join(repoS, SHARED_SOURCES_DIR, "shared-api.md")) && !isSharedSourcePath("/x/majordome-shared/y.md") && !isSharedSourcePath("/x/docs/api.md"));

	const ing = ingestDocs(repoS);
	check("ingest: configured + shared files stored", ing.files === 2 && ing.blocks === 2);
	const stored = store1.loadBlocks();
	check("ingest: doc-source blocks carry fromUntrusted", stored.filter((b) => b.session === "doc:adr-notes").every((b) => b.fromUntrusted === true));
	check("ingest: .majordome-shared blocks carry fromUntrusted", stored.filter((b) => b.session === "doc:shared-api").every((b) => b.fromUntrusted === true));
	// lenient parse: non-boolean fromUntrusted junk reads absent (same class as status)
	appendFileSync(join(process.env.MAJORDOME_DIR!, "blocks.jsonl"), JSON.stringify({ id: "junk:1", session: "junk", sessionFile: "/x/j.jsonl", firstTurn: 1, lastTurn: 2, gist: null, intent: null, dims: {}, tokensHybrid: [], head: "", closedAt: "", fromUntrusted: "yes", status: "garbage" }) + "\n");
	const junk = store1.loadBlocks().find((x) => x.id === "junk:1");
	check("lenient parse: non-boolean fromUntrusted junk reads absent", !!junk && junk.fromUntrusted === undefined && junk!.status === undefined);

	// recall marker: flagged blocks marked, session blocks unaffected
	const flagged = { ...mkBlock("docX", 1, 2, ["watcher"]), fromUntrusted: true };
	check("recall marker: unverified source appended for flagged blocks", injectionText(flagged).includes("· unverified source"));
	check("recall marker: session blocks stay trusted-class (no marker)", !injectionText(mkBlock("docX", 1, 2, ["watcher"])).includes("unverified source"));

	delete process.env.MAJORDOME_DOCS_SOURCES;
	delete process.env.MAJORDOME_DIR;
	delete process.env.MAJORDOME_TRAIL_FILE;
}

// ── v2.9 slice 2: lessons as an index class (judged at block close) ──
{
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose");
	delete process.env.TYPELLM_API_KEY;
	resetClassifyFn();
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "lesson-trails.jsonl");
	const jm2 = await import("./judges.ts");
	const store2 = await import("./store.ts");
	const { isLessonIntent, LESSON_INTENT_RE } = await import("./router.ts");
	const { blockDims, rewriteBlocks: rwBlocks } = store2;
	const { readFileSync: rfs2 } = await import("node:fs");

	// dims: judged vector preserved, lesson adds the `lessons` topic dim
	const vec2 = new Map([["renderer", 1], ["previews", 0.5]]);
	check("blockDims: judged dims preserved verbatim", JSON.stringify(blockDims(vec2, false)) === JSON.stringify({ renderer: 1, previews: 0.5 }));
	check("blockDims: lesson adds the lessons topic dim", blockDims(vec2, true).lessons === 1 && blockDims(vec2, true).renderer === 1);
	check("blockDims: null vec + lesson = lessons only", JSON.stringify(blockDims(null, true)) === JSON.stringify({ lessons: 1 }));

	// intent regex: hits + neutral misses
	check("lesson intent: spec regex hits", LESSON_INTENT_RE.test("any lessons about the watcher?") && LESSON_INTENT_RE.test("the mistake we made with retries") && LESSON_INTENT_RE.test("how do we avoid the flake?") && LESSON_INTENT_RE.test("don't repeat the same mistake"));
	check("lesson intent: learned-from + gotcha hit, neutrals miss", isLessonIntent("anything learned from the migration?") && isLessonIntent("gotchas with the office parser?") && !isLessonIntent("how does the webhook retry policy work?") && !isLessonIntent("which renderer renders the previews?"));

	// block-close classification: canned agent-model transport parses lesson
	process.env.MAJORDOME_DIR = join(tmp, "lesson-store");
	writeFileSync(process.env.MAJORDOME_TRAIL_FILE, "");
	jm2.setStreamFn(async () => "intent: implementation\ngist: queued the watcher renames to stop the iframe crash\nlesson: yes");
	const metaYes = await jm2.blockMeta("segment text");
	jm2.setStreamFn(async () => "intent: implementation\ngist: shipped the pricing tiers\nlesson: no");
	const metaNo = await jm2.blockMeta("segment text");
	jm2.setStreamFn(async () => "intent: implementation\ngist: two-line legacy answer has no lesson line");
	const metaMissing = await jm2.blockMeta("segment text");
	jm2.setStreamFn(null as any);
	const lessonLines = rfs2(process.env.MAJORDOME_TRAIL_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	check("blockMeta: lesson: yes classifies", metaYes?.lesson === true && metaYes?.gist.includes("watcher"));
	check("blockMeta: lesson: no + missing line fail open false", metaNo?.lesson === false && metaMissing?.lesson === false);
	check("blockMeta: lesson rides the trail (no new judge call)", lessonLines.filter((l: any) => l.j === "blockMeta").length === 3 && lessonLines.filter((l: any) => l.j === "blockMeta" && l.lesson === true).length === 1);

	// recall: boost on lesson-intent AND failure-intent, never exclusion
	const lessonB = { ...mkBlock("LS", 1, 4, ["renderer", "previews", "debounce", "iframe"]), id: "LS:1", gist: "lesson: queue the watcher renames — direct renames crash the iframe preview" } as Block;
	(lessonB as any).lesson = true;
	const plainB = { ...mkBlock("LS", 5, 9, ["renderer", "previews"]), id: "LS:5", gist: "shipped the renderer previews pipeline" };
	(plainB as any).lesson = false;
	const routeOpts2 = (userMessage: string) => ({
		userMessage,
		blocks: [lessonB, plainB],
		currentSession: "__selfcheck__",
		currentTurn: 99999,
		routingIntent: async () => ({ intent: "incident_specific", searchTerms: userMessage, needClarification: false, clarifyWhy: "" }),
		queryDims: async () => null,
		tokens: (s: string) => tokens(s),
	});
	const rNeutral = await route(routeOpts2("renderer previews"));
	const rLesson = await route(routeOpts2("any lessons about the renderer previews?"));
	const rFail = await route(routeOpts2("what did we try that failed with the renderer?"));
	check("lesson boost: neutral query keeps plain-first (no boost without intent)", rNeutral !== null && rNeutral.ranked[0].block.id === "LS:5" && rNeutral.ranked.length === 2);
	check("lesson boost: lesson-intent flips lesson first, other still ranked", rLesson !== null && rLesson.ranked[0].block.id === "LS:1" && rLesson.ranked.some((s) => s.block.id === "LS:5"));
	check("lesson boost: failure-intent boosts lesson blocks too", rFail !== null && rFail.ranked[0].block.id === "LS:1");
	// zero-evidence lesson block still reachable on lesson queries (intent is
	// the retrieval evidence), zero-evidence non-lesson blocks stay excluded
	const offB = { ...lessonB, tokensHybrid: ["iframe", "debounce", "renames"], id: "LS:off", head: "off-topic lesson" };
	const offPlain = { ...plainB, tokensHybrid: ["kubernetes", "helmcharts"], id: "LS:kp" };
	const rOff = await route({ ...routeOpts2("what lessons did we record?"), blocks: [offB, offPlain] });
	check("lesson boost: zero-evidence lesson reachable on lesson query, non-lesson still floored", rOff !== null && rOff.ranked.some((s) => s.block.id === "LS:off") && !rOff.ranked.some((s) => s.block.id === "LS:kp"));

	// one-pager: derived Lessons section (recency first), stats count
	const { composeOnePager } = await import("./onepager.ts");
	const l1 = { ...mkBlock("LS", 1, 2, ["a"]), id: "LS:1", gist: "lesson: debounce the queue", closedAt: "2026-01-01T00:00:00Z" };
	(l1 as any).lesson = true;
	const l2 = { ...mkBlock("LS", 3, 4, ["b"]), id: "LS:3", gist: "lesson: never ship the flag on Friday", closedAt: "2026-02-01T00:00:00Z" };
	(l2 as any).lesson = true;
	const op = composeOnePager([l2, l1, plainB]);
	const opNone = composeOnePager([plainB]);
	check("one-pager: Lessons section derived from the class, recency first", op.md.includes("## Lessons") && op.md.indexOf("Friday") < op.md.indexOf("debounce") && op.md.includes("[LS:3") && op.md.includes("[LS:1"));
	check("one-pager: lessons counted in stats, empty scope says none recorded", op.stats.lessons === 2 && opNone.md.includes("(none recorded") && opNone.stats.lessons === 0);

	// consolidation: duplicate lessons supersede (same-mistake-twice), while a
	// same-topic non-lesson pair WITHOUT reversal vocabulary stays untouched
	process.env.MAJORDOME_DIR = join(tmp, "lesson-consolidation");
	writeFileSync(process.env.MAJORDOME_TRAIL_FILE, "");
	const tok2 = (s: string) => [...tokens(s)].sort();
	const lessonOlder: Block = {
		id: "dup:1", session: "dup", sessionFile: "/tmp/la.jsonl", firstTurn: 1, lastTurn: 4,
		gist: "the iframe preview panel crashes when the watcher queue renames", intent: "implementation", dims: {},
		tokensHybrid: tok2("iframe preview panel crash watcher queue rename debounce"),
		head: "", closedAt: "2026-01-01T09:00:00.000Z", lesson: true,
	};
	const lessonNewer: Block = {
		id: "dup:2", session: "dup", sessionFile: "/tmp/lb.jsonl", firstTurn: 1, lastTurn: 4,
		gist: "same iframe preview crash resurfaced — the debounce queue rename fix is the guidance now", intent: "implementation", dims: {},
		tokensHybrid: tok2("iframe preview crash rename debounce redo handoff"),
		head: "", closedAt: "2026-01-02T09:00:00.000Z", lesson: true,
	};
	const ctrlOlder: Block = {
		id: "ctl:1", session: "ctl", sessionFile: "/tmp/ca.jsonl", firstTurn: 1, lastTurn: 4,
		gist: "toolbar ribbon layout spacing grid chosen", intent: "implementation", dims: {},
		tokensHybrid: tok2("toolbar ribbon layout spacing grid"),
		head: "", closedAt: "2026-01-03T09:00:00.000Z",
	};
	const ctrlNewer: Block = {
		id: "ctl:2", session: "ctl", sessionFile: "/tmp/cb.jsonl", firstTurn: 1, lastTurn: 4,
		gist: "toolbar ribbon layout spacing alignment polished", intent: "implementation", dims: {},
		tokensHybrid: tok2("toolbar ribbon layout spacing alignment"),
		head: "", closedAt: "2026-01-04T09:00:00.000Z",
	};
	rwBlocks([lessonOlder, lessonNewer, ctrlOlder, ctrlNewer]);
	const { runConsolidation } = await import("./consolidate.ts");
	const { statusOf: stOf, loadLifecycle: llc } = await import("./store.ts");
	const cr2 = await runConsolidation();
	const after2 = store2.loadBlocks();
	check("consolidation: duplicate lesson supersedes (same-mistake-twice)", stOf(after2.find((b) => b.id === "dup:1")!) === "superseded" && stOf(after2.find((b) => b.id === "dup:2")!) === "valid");
	check("consolidation: non-lesson same-topic pair without reversal stays valid", stOf(after2.find((b) => b.id === "ctl:1")!) === "valid" && stOf(after2.find((b) => b.id === "ctl:2")!) === "valid");
	check("consolidation: duplicate-lesson verdict recorded + trail rule", llc().supersessions.some((l) => l.older === "dup:1" && l.newer === "dup:2" && l.verdict === "duplicate-lesson") && rfs2(process.env.MAJORDOME_TRAIL_FILE, "utf8").includes("same-mistake-twice"));
	check("consolidation: lesson pairing idempotent re-run", (await runConsolidation()).changed === 0);
	void cr2;

	delete process.env.MAJORDOME_DIR;
	delete process.env.MAJORDOME_TRAIL_FILE;
}

// ── v2.9 slice 3: simplifyVerdict worker completion gate ──
{
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose");
	delete process.env.TYPELLM_API_KEY;
	resetClassifyFn();
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "simplify-trails.jsonl");
	writeFileSync(process.env.MAJORDOME_TRAIL_FILE, "");
	const jm3 = await import("./judges.ts");
	const { simplifyHintText, shouldAskSimplify, pushInbox: pushLine, drainNotices: drainLines } = await import("./inbox.ts");
	const { readFileSync: rfs3 } = await import("node:fs");

	// fail-open: unconfigured → null, no call, trail untouched
	check("simplify: unconfigured fail-open null, no judge call", (await jm3.simplifyVerdict("gists of the run")) === null && rfs3(process.env.MAJORDOME_TRAIL_FILE, "utf8").trim() === "");

	// canned Jev verdicts parse through the SAME settle path; estTokens reported
	setClassifyFn(async () => ({ model: "canned", answers: { simpler: { noul: true }, kind: { choice: "delete" }, hints: "drop the legacy flag path — one flag already covers it" }, usage: { total_tokens: 321 } }));
	const vOk = await jm3.simplifyVerdict("gist one\ngist two");
	setClassifyFn(async () => ({ model: "canned", answers: { simpler: { noul: false }, kind: { choice: "merge" }, hints: "nothing to simplify" } }));
	const vNo = await jm3.simplifyVerdict("gists");
	setClassifyFn(async () => ({ model: "canned", answers: { simpler: "maybe", kind: "delete", hints: "x" } }));
	const vBad = await jm3.simplifyVerdict("gists");
	setClassifyFn(async () => ({ model: "canned", answers: { simpler: { noul: true }, kind: { choice: "refactor" }, hints: "shrink it" } }));
	const vKind = await jm3.simplifyVerdict("gists");
	setClassifyFn(async () => ({ model: "canned", answers: { simpler: { noul: true }, kind: "inline", hints: "w ".repeat(150) } }));
	const vLong = await jm3.simplifyVerdict("gists");
	resetClassifyFn();
	const lines3 = rfs3(process.env.MAJORDOME_TRAIL_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	check("simplify: canned verdict parses (simpler, kind, hints)", vOk?.simpler === true && vOk?.kind === "delete" && vOk?.hints.includes("legacy flag"));
	check("simplify: simpler=false → kind nulled, still a verdict", vNo?.simpler === false && vNo?.kind === null);
	check("simplify: malformed simpler → null (fail-open, not false)", vBad === null);
	check("simplify: kind outside enum → null kind, verdict kept", vKind?.simpler === true && vKind?.kind === null);
	check("simplify: hints capped at 200 chars", (vLong?.hints.length ?? 0) <= 200);
	check("simplify: trail records verdicts incl. estTokens", lines3.some((l: any) => l.j === "simplifyVerdict" && l.ok === true && l.simpler === true && l.kind === "delete" && l.estTokens === 321) && lines3.filter((l: any) => l.j === "simplifyVerdict").length === 5);

	// transport throw → ok:false trail + null (never throws into the worker)
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "simplify-trails2.jsonl");
	writeFileSync(process.env.MAJORDOME_TRAIL_FILE, "");
	setClassifyFn(async () => {
		throw new Error("transport down");
	});
	let threw3 = false;
	let vThrow3: unknown = "sentinel";
	try {
		vThrow3 = await jm3.simplifyVerdict("gists");
	} catch {
		threw3 = true;
	}
	resetClassifyFn();
	const throwLine3 = JSON.parse(rfs3(process.env.MAJORDOME_TRAIL_FILE, "utf8").trim());
	check("simplify: transport throw → null, fail-open call trailed", !threw3 && vThrow3 === null && throwLine3.j === "simplifyVerdict" && throwLine3.ok === false);

	// routing: suggest-only hint text + once-per-run guard
	check("simplify hint: suggest-only text only when simpler + hints", simplifyHintText(vOk)?.startsWith("simplify hint: delete — ") === true && simplifyHintText(vNo) === null && simplifyHintText(null) === null && simplifyHintText({ simpler: true, kind: "inline", hints: "  " }) === null);
	check("simplify guard: once per run, skipped with no impl blocks", shouldAskSimplify(false, []) === false && shouldAskSimplify(true, ["g"]) === false && shouldAskSimplify(false, ["g1", "g2"]) === true);

	// inbox: hint rides the completion line at drain time, drain clears
	process.env.MAJORDOME_INBOX = join(tmp, "simplify-inbox.jsonl");
	pushLine({ worker: "w1", note: "shipped the office parser flags", simplifyHint: "simplify hint: delete — drop the legacy flag path" });
	pushLine({ worker: "w2", note: "session ended" });
	const notice1 = drainLines();
	const notice2 = drainLines();
	check("simplify inbox: hint rides the worker line (suggest-only)", notice1.includes("worker w1") && notice1.includes("shipped the office parser flags") && notice1.includes("· simplify hint: delete — drop the legacy flag path"));
	check("simplify inbox: hintless workers render unchanged; drain clears", notice1.includes("worker w2: session ended") && !notice1.split("worker w2")[1].includes("simplify hint") && notice2 === "");
	delete process.env.MAJORDOME_INBOX;
	delete process.env.MAJORDOME_TRAIL_FILE;
}

// ── AGENTS.md adoption (init/doctor advisory + scaffold/augment offers) ──
{
	const { agentsReport, agentsGaps, greenfieldRepo, agentsOffer, AGENTS_TEMPLATE } = await import("./agentsmd.ts");
	const { mkdirSync: mkd, readFileSync: rfsAg, existsSync: exAg, writeFileSync: wfAg } = await import("node:fs");

	// fixture repos: greenfield (no .git, no manifests) vs brownfield (package.json)
	const gf = join(tmp, "agents-greenfield");
	const bf = join(tmp, "agents-brownfield");
	mkd(gf, { recursive: true });
	mkd(bf, { recursive: true });
	writeFileSync(join(bf, "package.json"), "{}");
	check("agents: greenfield = no .git AND no code manifests", greenfieldRepo(gf) === true && greenfieldRepo(bf) === false);
	mkd(join(gf, ".git"), { recursive: true });
	check("agents: .git presence (dir or worktree file) → brownfield", greenfieldRepo(gf) === false);

	// present + all conventions (greenfield, incl. no-compat + parked-deps) → ok
	const full = join(tmp, "agents-full");
	mkd(full, { recursive: true });
	writeFileSync(join(full, "AGENTS.md"), "# AGENTS.md\n\n## Lessons\n- record mistakes as guidance\n\n## Testing\n- npx tsx ext/selfcheck.ts must stay green\n\n## Compatibility\n- no compat shims — we ship greenfield\n\n## How to Work\n- **Parked dependencies invalidate dependents** — parks re-decide their documented dependents.\n");
	const repFull = agentsReport(full);
	check("agents: present · ok when every convention is there", repFull.present && repFull.ok && repFull.line === "AGENTS.md: present · ok");
	check("agents: zero gaps → null offer (nothing to propose)", agentsOffer(full) === null);

	// missing sections → gap list; brownfield never flagged for no-compat
	writeFileSync(join(bf, "AGENTS.md"), "# AGENTS.md\n\nsome notes, no sections\n");
	const repBf = agentsReport(bf);
	check("agents: brownfield gaps = lessons + testing + parked-deps (no no-compat flag)", JSON.stringify(repBf.gaps) === JSON.stringify(["no Lessons section", "no testing rules", "no parked-dependencies rule"]) && repBf.line === "AGENTS.md: present · no Lessons section · no testing rules · no parked-dependencies rule" && !repBf.ok);

	// greenfield without a no-compat rule → third gap
	const part = join(tmp, "agents-part");
	mkd(part, { recursive: true });
	writeFileSync(join(part, "AGENTS.md"), "# AGENTS.md\n\n## Lessons\nx\n\n## Testing rules\ny\n");
	const repGf = agentsReport(part);
	check("agents: greenfield without no-compat rule → gaps name it (+ parked-deps)", JSON.stringify(repGf.gaps) === JSON.stringify(["no-compat rule missing (greenfield)", "no parked-dependencies rule"]));
	check("agents: gap predicates — lessons heading, testing heading or bullet, no-compat + parked phrasings", agentsGaps("## Lessons\n## Testing\nno-compat shims\n- parked dependencies invalidate dependents", true).length === 0 && agentsGaps("- test all the things", false).length === 2 && !agentsGaps("no backward compat", true).includes("no-compat rule missing (greenfield)"));

	// absent → recommend line (init now offers the scaffold); doctor/init share it
	const repAbsent = agentsReport(join(tmp, "agents-nowhere"));
	check("agents: absent → recommend one (init proposes a scaffold)", !repAbsent.present && repAbsent.line === "AGENTS.md: absent — recommend one (init proposes a scaffold)");
	// advisory only: the module must not carry a write path (static gap-rule —
	// AGENTS.md is written only on an explicit user yes, at the UI/CLI boundary;
	// this module composes offers, it can never touch the disk)
	const agSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("./agentsmd.ts", import.meta.url), "utf8"));
	check("agents: advisory only — no write path in the module", !/writeFileSync|appendFileSync|rmSync/.test(agSrc));

	// scaffold proposal on a greenfield fixture: template composes, nothing writes
	const gfScaffold = join(tmp, "agents-scaffold");
	mkd(gfScaffold, { recursive: true });
	const offScaffold = agentsOffer(gfScaffold);
	check("agents: scaffold offer on greenfield — kind + target (the proposal path is proposals.ts's fact, not this module's)", !!offScaffold && offScaffold.kind === "scaffold" && offScaffold.target === join(gfScaffold, "AGENTS.md") && !("path" in offScaffold));
	check("agents: scaffold template carries the house sections (principles · invariants · structure · how-to-work incl. parked-deps · gates)", !!offScaffold && ["## Design Principles", "## Hard Invariants", "## Structure & Placement", "## How to Work", "Parked dependencies invalidate dependents", "Gates, not promises", "## Testing", "## Lessons"].every((s) => offScaffold!.doc.includes(s)));
	check("agents: scaffold template passes the gap report clean (greenfield)", agentsGaps(AGENTS_TEMPLATE, true).length === 0);
	check("agents: scaffold proposal writes nothing on its own", !exAg(join(gfScaffold, "AGENTS.md")) && !exAg(join(gfScaffold, ".majordome", "proposals")));

	// augment proposal on a brownfield fixture: additions for exactly the gaps,
	// ask-first (composing the offer must not touch the file)
	const bfBefore = rfsAg(join(bf, "AGENTS.md"), "utf8");
	const offAugment = agentsOffer(bf);
	check("agents: augment offer on gapped brownfield — kind + gaps named in the ask", !!offAugment && offAugment.kind === "augment" && offAugment.target === join(bf, "AGENTS.md") && offAugment.message.includes("no Lessons section") && offAugment.message.includes("no testing rules") && offAugment.message.includes("no parked-dependencies rule"));
	check("agents: augment doc proposes an addition per gap (incl. the parked-dependencies bullet)", !!offAugment && ["## Lessons", "## Testing", "Parked dependencies invalidate dependents"].every((s) => offAugment!.doc.includes(s)) && offAugment!.doc.includes("<!-- pi-majordome init"));
	check("agents: ask-first — composing the augment offer leaves AGENTS.md byte-identical", rfsAg(join(bf, "AGENTS.md"), "utf8") === bfBefore);

	// ── proposals lifecycle (.majordome/proposals/ — OKF metadata state) ──
	const pr = await import("./proposals.ts");
	const pRepo = join(tmp, "props-repo");
	mkd(join(pRepo, ".majordome"), { recursive: true });

	// write + parse roundtrip: the metadata header, title and body survive —
	// the format spec lives in ext/proposals.ts's header; this pins it
	const p1 = pr.writeProposal({ kind: "agents-scaffold", title: "Scaffold AGENTS.md from the bundled template", body: "principles · invariants · gates", source: "init", added: "2025-01-01" }, pRepo);
	const raw1 = rfsAg(p1, "utf8");
	const rt = pr.parseProposalText(raw1);
	check("proposals: header parse roundtrip — kind/status/added/source + title + body", rt.meta.kind === "agents-scaffold" && rt.meta.status === "pending" && rt.meta.added === "2025-01-01" && rt.meta.source === "init" && rt.title === "Scaffold AGENTS.md from the bundled template" && rt.body.includes("principles · invariants · gates"));
	check("proposals: flat folder, state is metadata — .majordome/proposals/YYYY-MM-DD-<kind>.md, no status subfolders", p1 === join(pRepo, ".majordome", "proposals", "2025-01-01-agents-scaffold.md"));

	// same-day same-kind collision → -2 suffix (filename never changes after)
	const p2 = pr.writeProposal({ kind: "agents-scaffold", title: "second", body: "again", added: "2025-01-01" }, pRepo);
	check("proposals: same-day same-kind collision → -2 suffix", p2.endsWith(join("2025-01-01-agents-scaffold-2.md")) && exAg(p2));

	// stampDecision: ONLY metadata keys move — the body is byte-identical
	pr.stampDecision(p1, { status: "approved", by: "butler", reason: "captain said yes" });
	const after = rfsAg(p1, "utf8");
	check("proposals: stampDecision updates keys only — body byte-identical", after.slice(after.indexOf("\n\n")) === raw1.slice(raw1.indexOf("\n\n")));
	const st = pr.parseProposalText(after).meta;
	check("proposals: stamp writes decided/by/reason, keeps added + pending others untouched", st.status === "approved" && st.decided === pr.todayISO() && st.by === "butler" && st.reason === "captain said yes" && st.added === "2025-01-01");

	// status values constrained: a non-decision stamp throws; a bogus-status
	// file is not a proposal (excluded from the listing)
	let noDecision = false;
	try { pr.stampDecision(p2, { status: "pending" as "approved", by: "x" }); } catch { noDecision = true; }
	wfAg(join(pRepo, ".majordome", "proposals", "2025-01-01-bogus.md"), "kind: x\nstatus: maybe\nadded: 2025-01-01\nsource: init\n\n# t\n\nb\n");
	check("proposals: status values constrained — stamp rejects non-decisions, parse rejects bogus status", noDecision && pr.listProposals(pRepo).length === 2 && !pr.listProposals(pRepo).some((e) => e.file.includes("bogus")));

	// listProposals: flat chronological listing with a status filter
	check("proposals: listProposals filters by status (1 pending, 1 approved, bogus excluded)", pr.listProposals(pRepo, { status: "pending" }).length === 1 && pr.listProposals(pRepo, { status: "approved" }).length === 1);

	// staleness: strictly > days — exactly 7d is not stale, 8d is; decided
	// proposals never count
	const pOld = pr.writeProposal({ kind: "docs-gap", title: "old", body: "b", added: "2025-01-01" }, pRepo);
	check("proposals: stalePending is strictly >7d (7d boundary quiet, 8d flagged, approved never stale)", pr.stalePending(7, { cwd: pRepo, now: "2025-01-08" }).length === 0 && pr.stalePending(7, { cwd: pRepo, now: "2025-01-09" }).map((e) => e.path).sort().join("|") === [p2, pOld].sort().join("|"));

	// housekeeping consumes the scan as an advisory needs-your-yes finding —
	// counts pending + stale, notes the legacy file, never stamps a decision
	const hk = await import("./housekeep.ts");
	const scan = pr.scanProposals(pRepo, { now: "2025-01-09" });
	wfAg(join(pRepo, ".majordome", "AGENTS.proposal.md"), "# legacy review copy\n");
	const legacyScan = pr.scanProposals(pRepo, { now: "2025-01-09" });
	const hkRes = hk.collectHousekeep({ cwd: pRepo, decisions: [], readmeText: "", changelogText: "", extraDocs: [], proposals: legacyScan });
	check("proposals: scanProposals — flat-dir counts (3 parsed · 2 pending · 2 stale) + legacy flag", scan.entries.length === 3 && scan.pending === 2 && scan.stale === 2 && scan.legacy === false && legacyScan.legacy === true);
	check("housekeep: pending proposals listed as needs-your-yes, never decided (file stays pending)", hkRes.needsYes.some((l) => l.includes("[proposals] 2 pending proposal(s)") && l.includes("2 stale >7d") && l.includes("deciding is the captain's") && l.includes("never auto-decides")) && hkRes.needsYes.some((l) => l.includes("legacy proposal file") && l.includes("re-run init to regenerate under proposals/ or move manually")) && rfsAg(p2, "utf8").includes("status: pending"));
	check("housekeep: safe class unchanged — proposal paths stay outside the README/docs allowlist (the ledger export is decision-owned)", !hk.isSafeDocPath(".majordome/proposals/2025-01-01-agents-scaffold.md") && hk.isSafeDocPath("docs/x.md") && hk.isSafeDocPath("README.md") && !hk.isSafeDocPath("STATUS.md"));

	// agentsmd stays provably write-free: no write call AND no proposals import
	// that would smuggle a write path in transitively
	const agSrc2 = await import("node:fs").then((fs) => fs.readFileSync(new URL("./agentsmd.ts", import.meta.url), "utf8"));
	check("agents: still advisory — no write path, no proposals import in agentsmd.ts", !/writeFileSync|appendFileSync|rmSync|from "\.\/proposals\.ts"/.test(agSrc2));

	// boundary wiring: index.ts + init-cli.ts record offers via
	// writeOfferProposal — the AGENTS.proposal.md write is gone; applying to
	// AGENTS.md still sits behind the explicit ui.confirm yes
	const idxSrc2 = await import("node:fs").then((fs) => fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8"));
	const initBlock2 = idxSrc2.slice(idxSrc2.indexOf("cmd === \"init\""), idxSrc2.indexOf("cmd === \"help\""));
	const cliSrc2 = await import("node:fs").then((fs) => fs.readFileSync(new URL("../tools/init-cli.ts", import.meta.url), "utf8"));
	check("wiring: init boundary records offers via writeOfferProposal — no AGENTS.proposal.md write left, confirm gate intact", initBlock2.includes("writeOfferProposal") && initBlock2.includes("ui.confirm") && !initBlock2.includes("AGENTS.proposal.md") && cliSrc2.includes("writeOfferProposal") && !cliSrc2.includes("AGENTS.proposal.md"));
	check("wiring: declined-with-UI stamps rejected — a no is a decision, not a pending proposal", idxSrc2.includes('stampDecision(p, { status: "rejected", by: "captain"') && idxSrc2.includes("declined — recorded rejected"));
	check("wiring: init ordering — initRepo runs before the AGENTS offer (apply implies state)", idxSrc2.indexOf("initRepo") > -1 && idxSrc2.indexOf("initRepo") < idxSrc2.indexOf("agentsOffer"));
	check("wiring: /majordome status command registered + render imported", idxSrc2.includes('cmd === "status"') && idxSrc2.includes("formatStatus"));
	{
		const { formatStatus } = await import("./status.ts");
		const rows: { item: string; status: string; evidence: string; substrate: string }[] = [
			{ item: "a", status: "pending", evidence: "x", substrate: "s" },
			{ item: "b", status: "parked", evidence: "x", substrate: "s" },
			{ item: "c", status: "built", evidence: "abc1234", substrate: "s" },
			{ item: "d", status: "dropped", evidence: "x", substrate: "s" },
		];
		const t = formatStatus(rows);
		check("status render: pending bullets, parked inline, counts, box", t.includes("pending (1)") && t.includes("\u00b7 a") && t.includes("parked (1): b") && t.includes("built 1 \u00b7 dropped 1") && t.startsWith("\u256d\u2500 /majordome status"));
	{
		const { formatHouseStatus } = await import("./status.ts");
		const mk = (item: string, status: string) => ({ item, status, evidence: "x", substrate: "s" });
		const t = formatHouseStatus([mk("p1", "pending"), mk("b1", "built")], [
			{ name: "code-parser", cwd: "/x/code-parser", rows: [mk("a", "pending"), mk("b", "parked")] },
			{ name: "cold-repo", cwd: "/x/cold-repo", rows: [] },
		]);
		check("status house render: local summary + worker lines + honest no-ledger + hint", t.includes("this repo: 2 rows") && t.includes("@code-parser \u2014 2 rows: pending 1") && t.includes("@cold-repo \u2014 no ledger (not init\u0027d)") && t.includes("status <@slug>"));
	}
	{
		const { shortTag } = await import("./core.ts");
		let ok = true;
		try { ok = shortTag(undefined as never) === "(no session)"; } catch { ok = false; }
		check("core: shortTag tolerates missing session (no .replace crash \u2014 the /majordome list bug)", ok);
	}
	{
		const storeSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("./store.ts", import.meta.url), "utf8"));
		check("store: appendBlock stamps session default at the write seam", storeSrc.includes('"(direct)"'));
	{
		const jsrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("./judges.ts", import.meta.url), "utf8"));
		check("shape: diagram-first reserved for structural content (Karpathy rung ladder, prose = rung 1)", jsrc.includes("RESERVED for genuinely structural content") && jsrc.includes("rung 1"));
	}
	{
		const idx = await import("node:fs").then((fs) => fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8"));
		check("compaction hook: compaction_end → indexSession refresh + housekeeping REPORT-ONLY (apply:false — fixes still need your yes)", idx.includes('pi.on("compaction_end"') && idx.includes('housekeeping(process.cwd(), { apply: false })') && idx.includes("compaction absorbed"));
		const ssrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("./status.ts", import.meta.url), "utf8"));
		check("ledger table: formatLedgerTable renders the boxed fold; @slug + house views wired (loadHouseRows unfiltered fold)", ssrc.includes("export function formatLedgerTable") && ssrc.includes("export function loadHouseRows") && idx.includes('a === "house"') && idx.includes("formatLedgerTable(loadStatusRows(w.cwd))"));
		{
			const { formatLedgerTable } = await import("./status.ts");
			const rows = [{ item: "x".repeat(200), status: "pending", evidence: "", substrate: "" }];
			const w60 = formatLedgerTable(rows, 60);
			const auto = formatLedgerTable(rows);
			check("ledger table: full-width sizing — override respected, non-TTY fallback borders intact (NaN-proof OR-chain)", Math.max(...w60.split("\n").map((l) => l.length)) <= 60 && Math.max(...auto.split("\n").map((l) => l.length)) === 113 && auto.includes("┌"));
		{
			const multi = formatLedgerTable([
				{ item: "alpha", status: "pending", evidence: "", substrate: "" },
				{ item: "beta", status: "pending", evidence: "", substrate: "" },
				{ item: "parked-thing", status: "parked", evidence: "", substrate: "" },
			]);
			const bl = multi.split("\n");
			check("ledger table: pending renders one bullet per item (one line per row); other statuses stay packed", bl.filter((l) => l.includes("│· ")).length === 2 && bl.some((l) => l.includes("· alpha")) && bl.some((l) => l.includes("· beta")) && !bl.some((l) => l.includes("alpha · beta")));
		}
		{
			const idx2 = await import("node:fs").then((fs) => fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8"));
			check("docs naming: gen/pull verbs wired under docs, legacy aliases intact (ROLES charter \u00a7gaps #4)", idx2.includes('a?.startsWith("gen ")') && idx2.includes('a === "pull"') && idx2.includes('if (cmd === "ingest-docs")') && !idx2.includes("docs <kind> [tag|all]"));
			const orchSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("./orch.ts", import.meta.url), "utf8"));
			check("orch add: eager init at link time — cold repos initRepo() on add, safety net stays at start", orchSrc.includes("cold \u2192 initialized now") && orchSrc.includes("await initRepo({ cwd })") && orchSrc.split("await initRepo").length >= 2);
			const { repoOf, inferRepo, sweepRepoStamps } = await import("./status.ts");
			const top = repoOf(new URL("..", import.meta.url).pathname);
			const sub = repoOf(new URL("../ext", import.meta.url).pathname);
			check("cross-repo: repoOf canonicalizes subdirectories to the git toplevel", top.startsWith("/") && sub === top);
			check("cross-repo: inferRepo \u2014 evidence naming exactly one other repo wins, else cwd", inferRepo("see /home/x/other/repo notes here", top).attributed === "evidence-path" && inferRepo("plain evidence", top).attributed === "cwd");
			const mk = (dec: boolean, repo?: string) => ({ id: "t", session: "s", sessionFile: "/nonexistent/a/b", firstTurn: 1, lastTurn: 2, gist: null, intent: null, dims: {}, tokensHybrid: [], head: "", closedAt: "x", repo, kind: dec ? "decision" : undefined, ...(dec ? { decision: { item: "i", status: "built", evidence: "", substrate: "" } } : {}) }) as any;
			const sw = sweepRepoStamps([mk(true), mk(false, "junk"), mk(false)]);
			check("cross-repo: sweep stamps decisions, strips non-decision stamps, passes clean non-decisions (idempotent)", sw.stamped === 1 && sw.stripped === 1 && sw.blocks[0].repo === "/nonexistent/a/b" && sw.blocks[1].repo === undefined && sw.blocks[2].repo === undefined);
			const { grillOptionsLine } = await import("./router.ts");
			const line = grillOptionsLine([{ q: "pricing question" }, { q: "design question" }], 0.5);
			const rolesTxt = await import("node:fs").then((fs) => fs.readFileSync(new URL("../docs/ROLES.md", import.meta.url), "utf8"));
			check("grill discipline: ask names its silence-default; charter carries the router rule", line.includes("default = 1: pricing question") && rolesTxt.includes("## Router rule (grill discipline)") && rolesTxt.includes("Never ask what's readable"));
		}
		}
	}
	{
		const { decomposedInjection } = await import("./router.ts");
		const mk = (id: string, g: string) => ({ id, gist: g, head: g, session: "s", firstTurn: 1, lastTurn: 2, closedAt: "2026-10-07T00:00:00Z" });
		const subs = [
			{ tag: "alpha", result: { ranked: [{ block: mk("b1", "ga"), score: 2 }] } },
			{ tag: "beta", result: { ranked: [{ block: mk("b1", "ga"), score: 1.5 }, { block: mk("b2", "gb"), score: 1 }] } },
		] as never;
		const t = decomposedInjection(subs);
		check("recall merge: block hit by two labels printed ONCE, extra label appended", t.includes("alpha: ga") && t.includes("+ beta") && (t.match(/alpha: ga/g) ?? []).length === 1 && t.includes("beta: gb") && !t.includes("beta: ga"));
	}	}
	check("wiring: status @slug \u2014 resolveWorkerRef + roster fallback + house default", idxSrc2.includes("resolveWorkerRef(slug, workers)") && idxSrc2.includes("unknown worker") && idxSrc2.includes("formatHouseStatus"));
	}
	{
		// lessons gap suppressed where the index already keeps lessons (captain decision 2026-10-05)
		const { agentsGaps } = await import("./agentsmd.ts");
		const body = "# X\n\nno lessons here";
		const without = agentsGaps(body, false, false);
		const withMjd = agentsGaps(body, false, true);
		check("agents: lessons gap fires without .majordome, suppressed with it (lessons live in the index)", without.includes("no Lessons section") && !withMjd.includes("no Lessons section"));
	}

	// the repo's OWN AGENTS.md passes the doctor's new check cleanly (it carries
	// the parked-dependencies bullet — no parked-dependencies gap here)
	const own = rfsAg(new URL("../AGENTS.md", import.meta.url), "utf8");
	check("agents: this repo's own AGENTS.md passes the parked-dependencies check", !agentsGaps(own, false).includes("no parked-dependencies rule"));

	// wiring: index.ts applies ONLY behind an explicit ui.confirm yes; init-cli
	// (headless) writes the review copy and prints its path — never auto-apply
	const idxSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8"));
	const initBlock = idxSrc.slice(idxSrc.indexOf('cmd === "init"'));
	check("agents: init wiring — offer + explicit confirm gate before any apply", initBlock.includes("agentsOffer") && initBlock.includes("ui.confirm") && initBlock.indexOf("ui.confirm") < initBlock.indexOf("appendFileSync"));
	const cliSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("../tools/init-cli.ts", import.meta.url), "utf8"));
	check("agents: headless CLI records a proposal, never auto-applies", cliSrc.includes("agentsOffer") && cliSrc.includes("writeOfferProposal") && cliSrc.includes("proposal") && !/appendFileSync|AGENTS\.proposal/.test(cliSrc));
}

// ── recall-feedback telemetry: precision proxy + false-positive specimens ──
{
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose"); // hermetic
	delete process.env.TYPELLM_API_KEY;
	const storeR = await import("./store.ts");
	const recall = await import("./recall.ts");
	const { readFileSync: rfs } = await import("node:fs");

	// fixture session: 8 turns. t2 references by shortId, t4 by a ≥6-word gist
	// phrase (assistant text), t5 is a re-injection tail (must NOT count), t6+ clean.
	const proxySession = join(tmp, "recall-proxy.jsonl");
	const P = (u: string, a: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: u }] } }) + "\n" + JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: a }] } });
	writeFileSync(
		proxySession,
		[
			P("how does the exporter work in this repo", "it batches writes behind a cursor"),
			P("used the code-parser:7 fix — thanks", "that was the watcher crash patch"),
			P("now the gist fixture question about the exporter", "sure"),
			P("go on", "right — the exporter ships markdown tables with column alignment hints"),
			P("[majordome recall · code-parser turns 7–9] the exporter ships markdown tables with column alignment hints (intent: implementation)", "ok"),
			P("nothing relevant here at all", "noted"),
			P("still nothing about the exporter", "ok"),
			P("and nothing again", "done"),
		].join("\n"),
	);
	const turnsFix = parseSession(proxySession);
	check("proxy: fixture session parses to 8 turns", turnsFix.length === 8);

	const gistText = "the exporter ships markdown tables with column alignment hints";
	const blocksFix = [
		{ id: "code-parser:7", session: "--home-u-code-parser--", gist: "watcher crash patch" },
		{ id: "exp:3", session: "exp", gist: gistText },
		{ id: "exp:5", session: "exp", gist: "an unrelated gist about consolidation pairing" },
	];
	const q1 = "how does the exporter work in this repo";
	const q3 = "now the gist fixture question about the exporter";
	const q5 = "[majordome recall · code-parser turns 7–9] the exporter ships markdown tables with column alignment hints (intent: implementation)";
	const q6 = "nothing relevant here at all";
	const decisionsFix: any[] = [
		{ ts: "t", query: q1, intent: "i", arm: "lex", winner: "code-parser:7", score: 0.8, injected: true, sessionFile: proxySession, turn: 1 },
		{ ts: "t", query: q3, intent: "i", arm: "lex", winner: "exp:3", score: 0.7, injected: true, sessionFile: proxySession, turn: 3 },
		{ ts: "t", query: q5, intent: "i", arm: "lex", winner: "exp:5", score: 0.7, injected: true, sessionFile: proxySession, turn: 5 },
		{ ts: "t", query: q6, intent: "i", arm: "lex", winner: "exp:3", score: 0.6, injected: true, sessionFile: proxySession, turn: 6 },
		{ ts: "t", query: q1, intent: "i", arm: "lex", winner: "exp:3", score: 0.9, injected: true }, // no sessionFile → unmeasurable
	];
	const proxy1 = recall.precisionProxy(decisionsFix, blocksFix, (f) => (f === proxySession ? turnsFix : null), 0);
	check("proxy: 4 measured (unstamped-session entry skipped, never counted unreferenced)", proxy1.measured === 4);
	check("proxy: referenced via shortId + via gist phrase; re-injection tail stripped; unreferenced stays unreferenced", proxy1.referenced === 2);
	check("proxy: windowing — turn cursor drops old decisions from the denominator", recall.precisionProxy(decisionsFix, blocksFix, () => turnsFix, 106).measured === 0 && recall.precisionProxy(decisionsFix, blocksFix, () => turnsFix, 101).measured === 3); // turn ≤ 101-100 skipped
	check("proxy: unlocatable query and missing file are unmeasurable, not unreferenced", recall.precisionProxy([{ ts: "t", query: "never asked this question anywhere", intent: "i", arm: "lex", winner: "exp:3", score: 1, injected: true, sessionFile: proxySession, turn: 1 }] as any, blocksFix, () => turnsFix, 0).measured === 0 && recall.precisionProxy(decisionsFix, blocksFix, () => null, 0).measured === 0);

	// the primitives under the proxy
	check("proxy: injected tail stripped before matching", !recall.referencedIn([{ user: "u", text: "[majordome recall · x turns 1–2] alpha beta gamma delta epsilon zeta" }], 0, "x:1", "alpha beta gamma delta epsilon zeta") && recall.referencedIn([{ user: "u", text: "plain alpha beta gamma delta epsilon zeta here" }], 0, "x:1", "alpha beta gamma delta epsilon zeta"));
	check("proxy: beyond-3-turns does not count", !recall.referencedIn([{ user: "u", text: "x" }, { user: "u", text: "x" }, { user: "u", text: "x" }, { user: "u", text: "finally mentions code-parser:7" }], 0, "code-parser:7", null));
	check("proxy: gist windows need ≥6 contiguous words (5-word echo is not a reference)", !recall.referencedIn([{ user: "u", text: "the exporter ships markdown tables" }], 0, "x:1", gistText) && recall.referencedIn([{ user: "u", text: "punctuated, line-broken form: The exporter ships markdown tables with column-alignment hints!" }], 0, "x:1", gistText));

	// decision round-trip: the telemetry fields ride the existing log.jsonl
	process.env.MAJORDOME_DIR = join(tmp, "recall-store");
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "recall-trails.jsonl");
	storeR.appendDecision({ ts: "2026-10-05T10:00:00Z", query: "q", intent: "i", arm: "lex", winner: "w:1", score: 0.9, injected: true, sessionFile: proxySession, turn: 42 } as any);
	const back = storeR.lastDecisions(10)[0] as any;
	check("telemetry: decision log carries sessionFile + turn stamps", back.sessionFile === proxySession && back.turn === 42);
	delete process.env.MAJORDOME_DIR;

	// bucket aggregation on a fixture corpus (env override — the hermetic seam)
	const fpFix = join(tmp, "fp-fixture.json");
	writeFileSync(fpFix, JSON.stringify({ specimens: [{ bucket: "wrong-repo" }, { bucket: "wrong-repo" }, { bucket: "stale" }, { bucket: "polysemy" }, { bucket: "weak-match" }, { bucket: "  " }, {}, { bucket: 42 }] }));
	process.env.MAJORDOME_FP_FILE = fpFix;
	const fpFixCounts = recall.fpCounts();
	check("specimens: fixture counts by bucket, junk buckets skipped", fpFixCounts.total === 5 && fpFixCounts.byBucket["wrong-repo"] === 2 && fpFixCounts.byBucket["stale"] === 1);
	check("specimens: stats fragment — canonical buckets fixed order, K total", recall.fpStatsLine(fpFixCounts) === "false-positive specimens: 5 (wrong-repo 2 · stale 1 · polysemy 1 · weak-match 1)");
	writeFileSync(fpFix, "not json");
	check("specimens: corrupt file → zeros + corrupt flag", (() => { const c = recall.fpCounts(); return c.total === 0 && c.corrupt === true; })());
	delete process.env.MAJORDOME_FP_FILE;
	check("specimens: absent file → zeros, not corrupt", (() => { const c = recall.fpCounts(join(tmp, "fp-nowhere.json")); return c.total === 0 && c.corrupt === false; })());

	// the real seed corpus: 8 specimens from the 2026-10-05 session
	const real = recall.fpCounts();
	check("specimens: seed corpus parses — 8 specimens", real.total === 8 && !real.corrupt);
	check("specimens: seed buckets wrong-repo 6 · stale 0 · polysemy 1 · weak-match 1", real.byBucket["wrong-repo"] === 6 && (real.byBucket["stale"] ?? 0) === 0 && real.byBucket["polysemy"] === 1 && real.byBucket["weak-match"] === 1);
	check("specimens: all dated to the 2026-10-05 session", (() => { const j = JSON.parse(rfs(recall.fpFile(), "utf8")); return j.specimens.length === 8 && j.specimens.every((s: any) => s.date === "2026-10-05" && s.slug && s.query && s.injectedRef && s.bucket); })());

	// the full stats line, both windows
	check("stats: recall precision line (windowed)", recall.proxyStatsLine({ measured: 12, referenced: 7, windowed: true }, real) === "recall precision (proxy): 7/12 referenced (last 100 turns) · false-positive specimens: 8 (wrong-repo 6 · stale 0 · polysemy 1 · weak-match 1)");
	check("stats: lifetime window when no turn cursor, null when nothing measurable", (recall.proxyStatsLine({ measured: 1, referenced: 0, windowed: false }, real) ?? "").includes("(lifetime)") && recall.proxyStatsLine({ measured: 0, referenced: 0, windowed: false }, real) === null);
}

// ── doc-drift gate (ext/docdrift.ts via doctor) + STATUS.md status ledger ──
{
	const { readFileSync: rfs6, existsSync: ex6 } = await import("node:fs");
	const { scanDocDrift, evidenceOk, DRIFT_RULES } = await import("./docdrift.ts");

	// fixture README: a present-tense claim of a mechanism with no ext/ tools/
	// code must WARN, naming the drift and the line
	const fixture = [
		"# fixture repo",
		"",
		"A sidecar in watch mode keeps each repo's artifacts fresh.",
		"",
		"Planned: a message-bus retriever (not yet built).",
	].join("\n");
	const noEv = scanDocDrift(fixture, () => false);
	check("docdrift: fixture present-tense claim with no code → WARN names noun + line", noEv.warns.length === 1 && noEv.warns[0].includes('"sidecar"') && noEv.warns[0].includes("line 3"));

	// roadmap-marked wording → note at most, never a WARN (honest plans stay quiet)
	const roadm = scanDocDrift("Planned: a sidecar in watch mode to keep artifacts fresh (not yet built; see STATUS.md).\n", () => false);
	check("docdrift: roadmap-marked claim → note only, zero warns", roadm.warns.length === 0 && roadm.notes.length === 1);

	// claimed AND implemented → fully quiet (no warn, no note)
	const withEv = scanDocDrift(fixture, (r) => r.noun === "sidecar");
	check("docdrift: claim backed by code → fully quiet", withEv.warns.length === 0 && withEv.notes.length === 0);

	// unrelated same-word mentions never false-hit ("lifecycle sidecar" ≠ sidecar watch mode)
	const lookalike = scanDocDrift("ext/store.ts JSONL store: blocks, meta, vocab, lifecycle sidecar\n", () => false);
	check("docdrift: claim signatures — lookalike noun mentions don't fire", lookalike.warns.length === 0 && lookalike.notes.length === 0);

	// the REAL repo (run from ext/, so repo root is one level up)
	const repoRoot = new URL("..", import.meta.url).pathname;
	const real = scanDocDrift(rfs6(new URL("../README.md", import.meta.url), "utf8"), (rule) => evidenceOk(repoRoot, rule));
	check("docdrift: real README — zero drift warns (post-fix wording is roadmap-exempt)", real.warns.length === 0);
	check("docdrift: real README — wrapped sidecar roadmap mention still caught, as a note", real.notes.some((n) => n.includes("sidecar")));
	check("docdrift: real evidence — inbox/orchestrator/panel grading/one-pager all map to code", DRIFT_RULES.filter((r) => r.noun !== "sidecar").every((r) => evidenceOk(repoRoot, r)));
	check("docdrift: sidecar has NO ext/ tools/ evidence (prototype lives unwired in durable-sidecar/)", !evidenceOk(repoRoot, DRIFT_RULES.find((r) => r.noun === "sidecar")!));

	// STATUS.md — since v2.11 the GENERATED EXPORT of the decision fold (the
	// source is blocks.jsonl). The jsonsurf interim (status.json at the repo
	// root) was migrated verbatim into decision blocks at the superseding
	// merge, then demoted like the md it once replaced. The export must still
	// parse to exactly the rows it was generated from, so the raw-shape checks
	// keep grading the file; the fold itself and its gates live in the
	// decision-store section below.
	const stPath = new URL("../STATUS.md", import.meta.url);
	const statusMod = await import("./status.ts");
	check("STATUS.md: exists at repo root", ex6(stPath));
	check("STATUS.md: status.json demoted — gone from the repo root (its rows are decision blocks now)", !ex6(new URL("../status.json", import.meta.url)));
	const stText = rfs6(stPath, "utf8");
	const stLines = stText.split("\n").filter((l) => l.trim().startsWith("|"));
	const stHeader = stLines[0] ?? "";
	const stRows = statusMod.parseStatusRows(stText);
	const cells = (l: string) => l.split("|").map((s) => s.trim());
	check("STATUS.md: table header is item | status | evidence | substrate", ["item", "status", "evidence", "substrate"].every((h) => cells(stHeader).includes(h)));
	check("STATUS.md: has rows", stRows.length >= 20);
	check("STATUS.md: every row has exactly 4 columns (raw rows all parse)", stLines.length - 2 === stRows.length);
	const STATUSES = new Set(["built", "parked", "dropped", "pending"]);
	check("STATUS.md: statuses limited to built/parked/dropped/pending", stRows.every((r) => STATUSES.has(r.status)));
	check("STATUS.md: exactly one row per item (no duplicate items)", new Set(stRows.map((r) => r.item)).size === stRows.length);
	check("STATUS.md: every built row cites a 7-hex commit or global-state evidence", stRows.every((r) => r.status !== "built" || /\b[0-9a-f]{7}\b/.test(r.evidence) || /^global: /.test(r.evidence)));
	check("ledger: one-pager deliverable dropped (removed per captain 2026-10-07)", stRows.some((r) => r.item === "docs/ONE-PAGER.md build-day ledger" && r.status === "dropped" && r.evidence.includes("removed per captain 2026-10-07")));
	check("ledger: no BUILT row still points at the deleted one-pager doc", stRows.every((r) => r.status !== "built" || !/docs\/ONE-PAGER\.md/.test(`${r.evidence} ${r.substrate}`)));
	check("STATUS.md: real export already canonical (normalizer is a no-op)", !statusMod.normalizeStatusText(stText).changed);
}

// ── status join + shared STATUS parser (ext/status.ts) ──────────────────
{
	const { parseStatusRows, normalizeStatusText, loadStatusRows, statusFile, statusJoinLines } = await import("./status.ts");
	const fsSt = await import("node:fs");

	// parser: header + separator skipped, malformed rows skipped, cells trimmed
	const ragged = parseStatusRows("| item | status | evidence | substrate |\n|---|---|---|---|\n| ok row | built | abc1234 | ext/x.ts |\n| just | two |\n|   |   |   |   |\n");
	check("status parser: header/separator/malformed skipped, 4-col rows kept", ragged.length === 1 && ragged[0].item === "ok row" && ragged[0].status === "built");

	const rows = parseStatusRows(
		"| item | status | evidence | substrate |\n|---|---|---|---|\n" +
		"| sidecar watch mode | parked | 26fde67 prototype only, not wired | durable-sidecar/ |\n" +
		"| panel grading (majority-of-available-engines) | built | 7f5e91b | ext/panel.ts |\n" +
		"| pricing tiers | parked | discussed only | conversation notes |\n",
	);

	// match produces the line — exact format, evidence verbatim
	const hit = statusJoinLines("fix the sidecar watch mode crash on rename", rows);
	check("status-join: match produces the bound line", hit.length === 1 && hit[0] === "related status: sidecar watch mode — parked (26fde67 prototype only, not wired)");

	// no match produces nothing (one shared token is below the honest-overlap bar)
	check("status-join: no match → no lines", statusJoinLines("design the pricing checkout flow", rows).length === 0);
	check("status-join: empty ledger or empty text → no lines", statusJoinLines("sidecar watch mode", []).length === 0 && statusJoinLines("", rows).length === 0);

	// multiple matches bound to 2 (a second sidecar row competes; cap holds)
	const many = rows.concat(parseStatusRows("| item | status | evidence | substrate |\n|---|---|---|---|\n| sidecar watch-mode ingest loop | parked | design note | docs/DESIGN.md |\n| third sidecar mode row | parked | note | docs/DESIGN.md |\n"));
	const capped = statusJoinLines("fix the sidecar watch mode crash on rename", many);
	check("status-join: multiple matches bound to 2", capped.length === 2 && capped.every((l) => l.startsWith("related status: ")));

	// long evidence stays bounded on the injected line (row keeps the full text)
	const longEv = statusJoinLines("fix the sidecar watch mode crash", parseStatusRows("| item | status | evidence | substrate |\n|---|---|---|---|\n| sidecar watch mode | parked | " + "x".repeat(140) + " | durable-sidecar/ |\n"));
	check("status-join: evidence truncated to 100 chars on the line", longEv.length === 1 && longEv[0].length < 160 && longEv[0].includes("…"));

	// normalizer: status case + cell spacing, idempotent, skeleton untouched
	const nrm = normalizeStatusText("| item | status | evidence | substrate |\n|---|---|---|---|\n| x | Built |   abc1234  | y |\n");
	check("status normalize: status case + cell spacing", nrm.changed && nrm.text.includes("| x | built | abc1234 | y |"));
	check("status normalize: idempotent on its own output", !normalizeStatusText(nrm.text).changed);

	// loader: an absent/corrupt store reads inert ([] — never fatal). The fold
	// never reads md/json ledger files, so no legacy fallback exists by design
	// (grep-pinned in the decision-store section); MAJORDOME_STATUS_FILE names
	// the EXPORT path (where --export md writes).
	const emptyRepo = join(tmp, "status-empty-repo");
	fsSt.mkdirSync(emptyRepo, { recursive: true });
	process.env.MAJORDOME_DIR = join(tmp, "status-empty-store");
	check("status loader: absent store → [] (inert, never fatal)", loadStatusRows(emptyRepo).length === 0);
	delete process.env.MAJORDOME_DIR;
	check("status file env: MAJORDOME_STATUS_FILE names the export path (STATUS.md)", statusFile("/elsewhere").endsWith("STATUS.md"));
	process.env.MAJORDOME_STATUS_FILE = join(tmp, "export-override", "STATUS.md");
	check("status file env: MAJORDOME_STATUS_FILE overrides the default export path", statusFile("/elsewhere") === join(tmp, "export-override", "STATUS.md"));
	delete process.env.MAJORDOME_STATUS_FILE;
}

// ── decision-block store: append + fold + migration + md export (v2.11) ──
{
	const { mkdirSync, readFileSync: rfsDec, writeFileSync: wfsDec, appendFileSync } = await import("node:fs");
	process.env.MAJORDOME_DIR = join(tmp, "decision-store");
	const store = await import("./store.ts");
	const st = await import("./status.ts");
	const mig = await import("../tools/migrate-status.ts");

	// the schema: appendDecisionStatus → a decision block on the ledger channel
	const repoA = join(tmp, "decision-repo-a");
	st.appendDecisionStatus({ item: "sidecar watch mode", status: "parked", evidence: "26fde67 prototype only, not wired", substrate: "durable-sidecar/" }, repoA);
	st.appendDecisionStatus({ item: "panel grading (majority-of-available-engines)", status: "built", evidence: "7f5e91b", substrate: "ext/panel.ts" }, repoA);
	const decA = st.loadDecisions(repoA);
	check("decision store: appendDecisionStatus → kind=decision blocks on the ledger channel", decA.length === 2 && decA.every((b) => store.isDecisionBlock(b)) && decA.every((b) => b.session === store.DECISION_SESSION && b.firstTurn === 0 && b.lastTurn === 0));
	check("decision store: payload fields stored verbatim", decA[0].decision.item === "sidecar watch mode" && decA[0].decision.evidence === "26fde67 prototype only, not wired" && decA[0].decision.substrate === "durable-sidecar/");
	check("decision store: tags are decision+status+slug-of-item", decA[0].tags?.join(",") === "decision,status,sidecar-watch-mode");

	// scoping: another repo's decisions don't leak, memory blocks never fold in
	const repoB = join(tmp, "decision-repo-b");
	st.appendDecisionStatus({ item: "other repo row", status: "pending", evidence: "x", substrate: "y" }, repoB);
	store.appendBlock({ id: "mem:1", session: "mem", sessionFile: "/x/mem.jsonl", firstTurn: 1, lastTurn: 2, gist: null, intent: null, dims: {}, tokensHybrid: [], head: "", closedAt: "" });
	check("decision store: loadDecisions scopes to the repo, ignores memory blocks", st.loadDecisions(repoB).length === 1 && st.loadDecisions(repoA).length === 2 && st.loadStatusRows(repoB)[0].item === "other repo row");

	// the fold: latest appended wins; disagreeing statuses flag contradicted
	st.appendDecisionStatus({ item: "sidecar watch mode", status: "built", evidence: "abc1234", substrate: "ext/x.ts" }, repoA);
	const rowsA = st.loadStatusRows(repoA);
	const side = rowsA.find((r) => r.item === "sidecar watch mode")!;
	check("fold: latest appended decision wins (older superseded by append order)", side.status === "built" && side.evidence === "abc1234" && side.substrate === "ext/x.ts");
	check("fold: disagreeing statuses flag contradicted, others don't", side.contradicted === true && rowsA.find((r) => r.item === "panel grading (majority-of-available-engines)")?.contradicted === undefined);
	st.appendDecisionStatus({ item: "panel grading (majority-of-available-engines)", status: "built", evidence: "7f5e91b (docs 332b226)", substrate: "ext/panel.ts" }, repoA);
	check("fold: same-status re-append stays unflagged (latest evidence wins)", st.loadStatusRows(repoA).find((r) => r.item === "panel grading (majority-of-available-engines)")?.contradicted === undefined);

	// evidence gate: built rows cite a 7-hex commit or global: state
	check("fold: every built row cites 7-hex or global: evidence", st.loadStatusRows(repoA).every((r) => r.status !== "built" || /\b[0-9a-f]{7}\b/.test(r.evidence) || /^global: /.test(r.evidence)));

	// lenient parse: a malformed decision payload reads as a plain memory block
	appendFileSync(join(process.env.MAJORDOME_DIR!, "blocks.jsonl"), JSON.stringify({ id: "junkd:1", session: "j", sessionFile: "/x/j.jsonl", firstTurn: 1, lastTurn: 1, gist: null, intent: null, dims: {}, tokensHybrid: [], head: "", closedAt: "", kind: "decision", decision: { item: "x", status: "maybe", evidence: "", substrate: "" } }) + "\n");
	const junk = store.loadBlocks().find((b) => b.id === "junkd:1");
	check("decision store: malformed decision payload reads as a plain block (lenient)", !!junk && !store.isDecisionBlock(junk) && st.loadStatusRows(repoA).length === 2);

	// migration: legacy md → decision blocks, verbatim + idempotent (hermetic
	// fixture; the REAL ledger migrates on master at merge)
	const migRepo = join(tmp, "migrate-repo");
	mkdirSync(migRepo, { recursive: true });
	const legacy = [
		"# STATUS — deliverable ledger",
		"",
		"| item | status | evidence | substrate |",
		"|---|---|---|---|",
		"| sidecar watch mode | parked | 26fde67 prototype only, not wired | durable-sidecar/ |",
		"| ledger-only deliverable | built | abc0123 (docs def2345) | ext/nothing.ts |",
		"| weird status row | maybe | — | — |",
	].join("\n");
	const migStatus = join(migRepo, "STATUS.md");
	wfsDec(migStatus, legacy);
	const dry = mig.migrateStatus({ repoRoot: migRepo, statusPath: migStatus, dryRun: true });
	check("migrate: dry-run counts without writing", dry.rows === 3 && dry.migrated === 2 && dry.invalid === 1 && st.loadDecisions(migRepo).length === 0);
	const m1 = mig.migrateStatus({ repoRoot: migRepo, statusPath: migStatus });
	check("migrate: 2 rows migrated, 1 invalid status rejected", m1.migrated === 2 && m1.invalid === 1);
	const want = [
		{ item: "sidecar watch mode", status: "parked", evidence: "26fde67 prototype only, not wired", substrate: "durable-sidecar/" },
		{ item: "ledger-only deliverable", status: "built", evidence: "abc0123 (docs def2345)", substrate: "ext/nothing.ts" },
	];
	check("migrate: fold == legacy rows verbatim (item/status/evidence/substrate, ledger order)", JSON.stringify(st.loadStatusRows(migRepo).map(({ item, status, evidence, substrate }) => ({ item, status, evidence, substrate }))) === JSON.stringify(want));
	const m2 = mig.migrateStatus({ repoRoot: migRepo, statusPath: migStatus });
	check("migrate: idempotent — re-run skips migrated items", m2.migrated === 0 && m2.skipped === 2 && st.loadStatusRows(migRepo).length === 2);

	// export: the md door regenerates from the fold, losslessly
	const exported = st.exportStatusMd(migRepo);
	const expText = rfsDec(migStatus, "utf8");
	check("export: STATUS.md regenerated with the generated-export banner", expText.includes("GENERATED EXPORT") && expText.includes("do not edit; source: decision blocks") && exported.includes("2 item(s)"));
	check("export: parseStatusRows(export) == fold rows (lossless view)", JSON.stringify(st.parseStatusRows(expText)) === JSON.stringify(st.loadStatusRows(migRepo)));

	// GREP PIN: the status data path never reads an md ledger — the fold's
	// source is blocks.jsonl only
	const stSrc = rfsDec(new URL("./status.ts", import.meta.url), "utf8");
	check("pin: ext/status.ts has no readFileSync — the fold never reads an md ledger", !stSrc.includes("readFileSync"));

	// memory surfaces stay clean: decision records feed the fold, never the
	// map / one-pager projections (they are ledger rows, not recall nodes)
	const { compileMap } = await import("./map.ts");
	const { composeOnePager } = await import("./onepager.ts");
	const memBlock: Block = { id: "memx:1", session: "memx", sessionFile: "/x/memx.jsonl", firstTurn: 1, lastTurn: 2, gist: "a gist about things", intent: null, dims: {}, tokensHybrid: [], head: "", closedAt: "" };
	const opMd = composeOnePager([...decA, memBlock]).md;
	check("surfaces: decision records never appear as map / one-pager nodes", !JSON.stringify(compileMap([...decA, memBlock]).json).includes("sidecar watch mode") && opMd.includes("a gist about things") && !opMd.includes("decision-ledger"));

	delete process.env.MAJORDOME_DIR;
}

// ── housekeeping: safe-fix vs needs-yes policy (ext/housekeep.ts) ────────
{
	const hk = await import("./housekeep.ts");
	const { scanDocDrift } = await import("./docdrift.ts");
	const fs2 = await import("node:fs");

	// fixture repo: README carrying the proven drift signature; the ledger is
	// decision blocks in a HERMETIC store (STATUS.md on disk is the generated
	// export — housekeeping reads the fold, never that file)
	const repo = mkdtempSync(join(tmpdir(), "majordome-hk-"));
	process.env.MAJORDOME_DIR = join(tmp, "housekeep-decision-store");
	fs2.mkdirSync(join(repo, "docs"), { recursive: true });
	const readme = ["# fixture repo", "", "A sidecar in watch mode keeps each repo's artifacts fresh.", ""].join("\n");
	fs2.writeFileSync(join(repo, "README.md"), readme);
	const exportMd = "| item | status | evidence | substrate |\n|---|---|---|---|\n| sidecar watch mode | parked | 26fde67 prototype only, not wired | durable-sidecar/ |\n| ledger-only deliverable | built | abc0123 (docs def2345) | ext/nothing.ts |\n";
	fs2.writeFileSync(join(repo, "STATUS.md"), exportMd);
	const stmod = await import("./status.ts");
	stmod.appendDecisionStatus({ item: "sidecar watch mode", status: "parked", evidence: "26fde67 prototype only, not wired", substrate: "durable-sidecar/" }, repo);
	stmod.appendDecisionStatus({ item: "ledger-only deliverable", status: "built", evidence: "abc0123 (docs def2345)", substrate: "ext/nothing.ts" }, repo);
	// the corrupt store file the rm proposal names — must survive housekeeping
	const corrupt = join(repo, "trails.jsonl");
	fs2.writeFileSync(corrupt, "{not json}\n");

	const res = hk.collectHousekeep({
		cwd: repo,
		doctorText: "✓ index: 3 blocks parse\nall clear.",
		readmeText: readme,
		changelogText: "## 1.0.0 — inbox now ships",
		gitShas: [], // ledger cites 26fde67 → stale by construction
		gitDirty: [" M bench/results/last.txt"],
		storeCorrupt: [corrupt],
		extraDocs: [],
	});
	check("housekeep: ledger line reads the fold (decisions folded, items out)", res.checkLines.some((l) => l.includes("status ledger: 2 decisions folded, 2 item(s)")) && res.rows.length === 2);

	// SAFE class: exactly the README reword, to roadmap tense, allowlisted path
	const rewords = res.proposals.filter((p) => p.safe && p.kind === "reword");
	check("housekeep: drift signature → safe reword proposal on README.md", rewords.length === 1 && rewords[0].path === "README.md" && rewords[0].to.includes("planned sidecar in watch mode") && rewords[0].to.includes("not yet built"));

	// DANGEROUS class: rm + git listed for explicit yes, never executed
	const dangerous = res.proposals.filter((p) => !p.safe);
	check("housekeep: dangerous class listed (rm + git state change)", dangerous.length === 2 && dangerous.some((p) => p.kind === "rm") && dangerous.some((p) => p.kind === "git"));

	// STATUS staleness: built rows citing commits git doesn't know (rows come
	// from the decision fold)
	check("housekeep: stale built-row commit flagged", res.needsYes.some((l) => l.includes("abc0123") && l.includes("not in git log")));
	// mechanism mention with no ledger row (CHANGELOG's inbox, no inbox row)
	check("housekeep: mechanism mention with no ledger row flagged", res.needsYes.some((l) => l.includes('"inbox"')));

	// the guard: dangerous kinds refused outright; safe kinds refused outside
	// the hard path allowlist (code files, traversal)
	let refused = false;
	try { hk.assertExecutable({ safe: false, kind: "rm", describe: "x" }); } catch { refused = true; }
	check("housekeep: guard refuses dangerous kinds (rm)", refused);
	refused = false;
	try { hk.assertExecutable({ safe: true, kind: "reword", path: "ext/store.ts", from: "a", to: "b", why: "w" }); } catch { refused = true; }
	check("housekeep: guard refuses code-file paths (allowlist)", refused);
	refused = false;
	try { hk.assertExecutable({ safe: true, kind: "reword", path: "../README.md", from: "a", to: "b", why: "w" }); } catch { refused = true; }
	check("housekeep: guard refuses path traversal", refused);

	// apply: the safe fix rewords the fixture README; the dangerous class is
	// listed, not executed — corrupt file survives, nothing else written
	const fixed = hk.applySafeFixes(repo, res.proposals);
	const after = fs2.readFileSync(join(repo, "README.md"), "utf8");
	check("housekeep: safe-fix applied rewords the fixture README", fixed.length === 1 && after.includes("planned sidecar in watch mode (not yet built — see STATUS.md)"));
	check("housekeep: reworded README is roadmap-exempt (doc-drift gate quiet)", scanDocDrift(after, () => false).warns.length === 0);
	check("housekeep: dangerous action listed NOT executed (corrupt file survives)", fs2.existsSync(corrupt) && fixed.every((f) => !f.includes("rm")));
	check("housekeep: generated STATUS.md export untouched (ledger is decision-owned, safe class never writes it)", fs2.readFileSync(join(repo, "STATUS.md"), "utf8") === exportMd);

	delete process.env.MAJORDOME_DIR;
}

// ── doctor + housekeeping command registration (same registry) ──────────
{
	const { readFileSync: rfsIdx, existsSync: exIdx } = await import("node:fs");
	const idx = rfsIdx(new URL("../index.ts", import.meta.url), "utf8");
	check("commands: /majordome doctor registered in the extension registry", /cmd === "doctor"/.test(idx) && /import \{ doctor \} from "\.\/ext\/doctor\.ts";/.test(idx));
	check("commands: /majordome housekeeping registered in the extension registry", /cmd === "housekeeping"/.test(idx) && /import \{ housekeeping \} from "\.\/ext\/housekeep\.ts";/.test(idx));
	check("commands: doctor CLI entry exists (bare tsx must print, never wait on stdin)", exIdx(new URL("../tools/doctor-cli.ts", import.meta.url)));
	check("commands: one-pager command removed (composeOnePager stays sidecar-only)", !/cmd === "one-pager"/.test(idx) && !idx.includes("composeOnePager"));
	check("commands: /majordome user registered (render + set + reset via userprefs)", /cmd === "user"/.test(idx) && idx.includes("renderUserPrefs") && idx.includes("setUserPref") && idx.includes("resetUserPrefsFile"));
	check("commands: /majordome status --export md door — the merged handler shape (both spellings, write via exportStatusMd)", idx.includes('a === "--export md" || a === "export md"') && idx.includes("exportStatusMd()"));
	check("recall: status-join wired into the injection path", idx.includes("statusJoinTail(winner)") && idx.includes("loadStatusRows"));
	check("wiring: status --export md registered (the generated-export door)", idx.includes('"--export md"') && idx.includes("exportStatusMd"));
	// live smoke: the doctor audit always renders a report (never crashes, never empty)
	const { doctor } = await import("./doctor.ts");
	const doc = await doctor();
	check("doctor: audit renders a non-empty report (incl. advisory checks)", typeof doc === "string" && doc.includes("✓") === true && (doc.includes("all clear") || doc.includes("issue(s) found")));
}

// ── query decomposition v1 (cohesion cap, confidence grill gate, merge) ──
{
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose"); // hermetic
	delete process.env.TYPELLM_API_KEY;
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "decomp-trails.jsonl");
	const jd = await import("./judges.ts");
	const rd = await import("./router.ts");
	jd.resetClassifyFn();

	// offline fail-open: no key, no classifier → null (callers keep today's
	// single-pipeline behavior — never a guessed split)
	let dThrew = false;
	let dOffline: unknown = "sentinel";
	try {
		dOffline = await jd.decomposeQuery("how does recall work and what did we decide about sqlite?");
	} catch {
		dThrew = true;
	}
	check("decompose: offline fail-open null (never throws)", !dThrew && dOffline === null);

	// fixture via the injected classifier seam — array-of-{q,tag} shape; the
	// cap 3 enforces the cohesion bound even when the judge over-splits
	jd.setClassifyFn(async () => ({
		model: "canned",
		answers: {
			subquestions: [
				{ q: "how does the recall injection work?", tag: "recall" },
				{ q: "what did we decide about sqlite storage?", tag: "sqlite" },
				{ q: "x1", tag: "a" },
				{ q: "x2", tag: "b" },
			],
			confidence: 0.95,
			vague: "no",
		},
	}));
	const dec = await jd.decomposeQuery("how does recall work, and sqlite?");
	check("decompose: array fixture settles, cap 3 enforced", dec?.subquestions.length === 3 && dec.subquestions[0].tag === "recall");
	check("decompose: confidence 0.95 proceeds (no grill)", dec ? rd.confidenceGrill(dec) === false : false);

	// guard branches: <0.9 grills with numbered options + soft-proceed; vague
	// forces the ask even at high confidence
	jd.setClassifyFn(async () => ({ model: "canned", answers: { subquestions: [{ q: "a?", tag: "t" }, { q: "b?", tag: "u" }], confidence: 0.4, vague: "no" } }));
	const decLow = await jd.decomposeQuery("hmm things?");
	const grill = decLow ? rd.grillOptionsLine(decLow.subquestions, decLow.confidence) : "";
	check("decompose: confidence <0.9 grills (options + soft-proceed)", decLow ? rd.confidenceGrill(decLow) === true && grill.includes("1)") && grill.includes("if silent, default = 1:") : false);
	jd.setClassifyFn(async () => ({ model: "canned", answers: { subquestions: [{ q: "a?", tag: "t" }, { q: "b?", tag: "u" }], confidence: 0.99, vague: "yes" } }));
	const decVague = await jd.decomposeQuery("the thing?");
	check("decompose: vague forces the grill branch", decVague ? rd.confidenceGrill(decVague) === true : false);

	// string-line shape (typellm line format) settles; malformed → null
	const fromLines = jd.settleDecompose({ subquestions: "recall :: how does injection work?\n1) sqlite :: what did we decide?", confidence: 0.93, vague: "no" }, "typellm");
	check("decompose: `tag :: question` line shape settles (numbering tolerated)", fromLines?.subquestions.length === 2 && fromLines.subquestions[1].tag === "sqlite");
	check("decompose: malformed (no subs / junk confidence) → null fail-open", jd.settleDecompose({ subquestions: [], confidence: 0.9 }, "typellm") === null && jd.settleDecompose({ subquestions: [{ q: "a", tag: "t" }] }, "typellm") === null && jd.settleDecompose({ subquestions: [{ q: "a", tag: "t" }], confidence: "junk", vague: "no" }, "typellm") === null);

	// ≤1 sub-question is the no-regression path: the settle keeps it, and the
	// orchestration (index.ts) only fires on >1 — single pipeline unchanged
	jd.setClassifyFn(async () => ({ model: "canned", answers: { subquestions: [{ q: "one thing?", tag: "solo" }], confidence: 0.99, vague: "no" } }));
	const decSingle = await jd.decomposeQuery("one thing");
	jd.resetClassifyFn();
	check("decompose: single sub-question kept as the no-decomposition path", decSingle?.subquestions.length === 1);

	// merge: dedupe by id keeping the best score, tags accumulate as provenance
	const bA = mkBlock("DA", 1, 3, ["registry"]);
	const bB = mkBlock("DB", 1, 3, ["registry"]);
	const mkSub = (tag: string, hits: { block: Block; score: number }[]): any => ({ tag, q: `${tag}?`, result: { ranked: hits } });
	const mergedRd = rd.mergeDecomposed([mkSub("recall", [{ block: bA, score: 1.0 }, { block: bB, score: 0.5 }]), mkSub("sqlite", [{ block: bA, score: 2.0 }])]);
	check("merge: dedupe by id keeps best score + provenance tags", mergedRd.length === 2 && mergedRd[0].block.id === bA.id && mergedRd[0].score === 2 && JSON.stringify(mergedRd[0].tags) === JSON.stringify(["recall", "sqlite"]));
	check("merge: single sub-question list = plain ranked order (no-regression shape)", rd.mergeDecomposed([mkSub("only", [{ block: bB, score: 0.5 }, { block: bA, score: 2 }])])[0].block.id === bA.id);

	// injection: sections labeled by sub-question tag
	const dinj = rd.decomposedInjection([mkSub("recall", [{ block: bA, score: 2 }]), mkSub("sqlite", [{ block: bB, score: 1 }])]);
	check("injection: decomposed sections labeled by tag", dinj.includes("· recall:") && dinj.includes("· sqlite:") && dinj.startsWith("[majordome recall · decomposed"));

	// round cap: max 2 decompose calls per turn, deterministic
	check("guard: decompose budget is 2 per turn", rd.DECOMPOSE_MAX_PER_TURN === 2 && rd.decomposeAllowed(0) && rd.decomposeAllowed(1) && !rd.decomposeAllowed(2));

	// the shipped wiring is really in index.ts (route → runSubQueries → merge →
	// grill; entities at the turn-end posthook seam)
	const idxText = (await import("node:fs")).readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	check("wiring: decompose orchestration + budget + entity seams live in index.ts", idxText.includes("runSubQueries") && idxText.includes("useDecomposeBudget") && idxText.includes("appendEntities") && idxText.includes("knownEntitiesIn"));

	delete process.env.MAJORDOME_TRAIL_FILE;
}

// ── entity registry (deterministic extraction + exact-match recall boost) ──
{
	process.env.MAJORDOME_KEY_FILE = join(tmp, "no-key-on-purpose");
	process.env.MAJORDOME_ENTITIES_FILE = join(tmp, "entities.jsonl");
	process.env.MAJORDOME_TRAIL_FILE = join(tmp, "entities-trails.jsonl");
	const ent = await import("./entities.ts");
	ent.resetEntityMemo();

	const hits = ent.extractEntities("see https://github.com/o/r and /home/aurel/notes/x.md, plus ~/cfg/y.json and https://example.com/a?b=1. bare github.com/aa/bb ref, (https://wrapped.io/x)");
	check("entities: url / repopath / filepath classes extracted", hits.some((h: any) => h.entity === "github.com/o/r" && h.kind === "repopath") && hits.some((h: any) => h.entity === "/home/aurel/notes/x.md" && h.kind === "filepath") && hits.some((h: any) => h.entity === "~/cfg/y.json" && h.kind === "filepath") && hits.some((h: any) => h.entity === "https://example.com/a?b=1" && h.kind === "url"));
	check("entities: github inside a URL records once as repopath", hits.filter((h: any) => h.entity.includes("github.com")).length === 2);
	check("entities: trailing punctuation stripped", hits.every((h: any) => !/[.,;:)"]$/.test(h.entity)) && hits.some((h: any) => h.entity === "https://wrapped.io/x"));
	check("entities: no matches → empty (plain text)", ent.extractEntities("plain words only").length === 0);

	// registry: append fresh, dedupe exact in-run repeats, read with filters
	ent.resetEntityMemo();
	const n1 = ent.appendEntities([{ entity: "github.com/o/r", kind: "repopath" }, { entity: "/home/aurel/notes/x.md", kind: "filepath" }], "projA", 3);
	const n2 = ent.appendEntities([{ entity: "github.com/o/r", kind: "repopath" }], "projA", 4); // exact repeat, same run
	check("registry: appends fresh, dedupes exact in-run repeats", n1 === 2 && n2 === 0 && ent.readEntities().length === 2);
	check("registry: kind filter reads", ent.readEntities({ kind: "filepath" }).length === 1 && ent.readEntities({ kind: "url" }).length === 0);
	check("registry: query-side gate (known boosted, unknown not)", JSON.stringify(ent.knownEntitiesIn("compare with github.com/o/r")) === JSON.stringify(["github.com/o/r"]) && ent.knownEntitiesIn("github.com/never/seen").length === 0);
	check("registry: advisory line counts distinct + kinds", ent.entitiesAdvisoryLine().includes("entity registry: 2 entities (url 0 · repopath 1 · filepath 1)"));

	// recall precision hook: the +2 exact-match boost reorders through route()
	// (plain: the lexically stronger short block wins; boost: the block whose
	// gist contains the entity verbatim overtakes it)
	const rb = await import("./router.ts");
	const pBlock = mkBlock("EP", 1, 3, ["registry", "noise", "filler", "stuff"]); // longer → lower plain score
	pBlock.gist = "shipped the entity registry at github.com/o/r";
	const qBlock = mkBlock("EQ", 1, 3, ["registry"]); // short, lexically strong
	const mkRoute = (knownEntities?: string[]) => rb.route({
		userMessage: "what about the registry github.com/o/r?",
		blocks: [pBlock, qBlock],
		currentSession: "EP",
		currentTurn: 9,
		currentSessionFile: "/x/EP/s.jsonl",
		routingIntent: async () => ({ intent: "definition_recall", searchTerms: "registry github.com/o/r", needClarification: false, clarifyWhy: "" }),
		queryDims: async () => null,
		tokens,
		...(knownEntities ? { knownEntities } : {}),
	});
	const rPlain = await mkRoute();
	const rBoost = await mkRoute(["github.com/o/r"]);
	const pPlain = rPlain?.ranked.find((s) => s.block.id === pBlock.id)?.score ?? -1;
	const pBoost = rBoost?.ranked.find((s) => s.block.id === pBlock.id)?.score ?? -1;
	check("recall: registry entity boost +2 lifts the exact-match block", rPlain?.winner?.id === qBlock.id && rBoost?.winner?.id === pBlock.id && Math.abs(pBoost - (pPlain + rb.ENTITY_BOOST)) < 1e-9);
	const qPlain = rPlain?.ranked.find((s) => s.block.id === qBlock.id)?.score ?? -1;
	const qBoost = rBoost?.ranked.find((s) => s.block.id === qBlock.id)?.score ?? -1;
	check("recall: blocks without the entity keep their exact score (boost is surgical)", Math.abs(qPlain - qBoost) < 1e-9);

	delete process.env.MAJORDOME_ENTITIES_FILE;
	delete process.env.MAJORDOME_TRAIL_FILE;
}

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall checks passed");
