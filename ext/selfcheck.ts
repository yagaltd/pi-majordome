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
import { timeTravel, rankArm, injectionText, armFor } from "./router.ts";
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

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall checks passed");
