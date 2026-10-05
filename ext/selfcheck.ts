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
import { timeTravel, rankArm, route, injectionText, judgeLine, docsNudge, scanDocsTouched, armFor, slugScopeFrom, slugOfBlock } from "./router.ts";
import { resolveWorkerRef } from "./orch.ts";
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

	// 2. profile resolution precedence: override > stored > detected
	const repoC = join(tmp, "prof-coding");
	const repoG = join(tmp, "prof-generic");
	mkd(join(repoC, "lib"), { recursive: true });
	writeFileSync(join(repoC, "Cargo.toml"), "[package]\n");
	mkd(join(repoG, "docs"), { recursive: true });
	check("profile: code manifest → coding (README+CHANGELOG+docs/)", JSON.stringify(detectDocsProfile(repoC)) === JSON.stringify({ watch: [...BUILTIN_DOC_WATCH], source: "detected-coding" }));
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

	// user.md preference context: read, comments stripped, missing → none,
	// cached per session until resetUserPrefs()
	const userFile = join(tmp, "user-fixture.md");
	writeFileSync(userFile, "# personal rules (comment line)\n\n- Prefer a diagram over prose for flow questions.\n- Keep answers STE-80 short.\n");
	process.env.MAJORDOME_USER_FILE = userFile;
	resetUserPrefs();
	const lines1 = userPrefLines();
	writeFileSync(userFile, "- rewritten on disk after the cache\n");
	const lines2 = userPrefLines(); // same process → cached
	resetUserPrefs();
	const lines3 = userPrefLines(); // re-read
	process.env.MAJORDOME_USER_FILE = join(tmp, "definitely-missing-user.md");
	resetUserPrefs();
	const lines4 = userPrefLines();
	resetUserPrefs();
	delete process.env.MAJORDOME_USER_FILE;
	delete process.env.MAJORDOME_TRAIL_FILE;
	check("shape: user.md lines read, comments/blanks stripped", lines1.length === 2 && lines1[0].includes("diagram") && !lines1.join("|").includes("personal rules"));
	check("shape: prefs cached per session until reset", lines2.length === 2 && lines3.length === 1 && lines4.length === 0);
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
	const fnSrc = (name: string): string => src.match(new RegExp(`export (async )?function ${name}\\b[\\s\\S]*?\\n}`))?.[0] ?? "";
	const trailHome: Record<string, string[]> = { shapeVerdict: ["shapeVerdict", "settleShape"] }; // judge → fns that may trail for it
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

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall checks passed");
