/**
 * Mine recall probes from the two INDEXED sessions (exact turn numbers = exact
 * gold). Past-recall candidates: recall-regex turns at turn N where the lex
 * argmax over PAST blocks (lastTurn < N) has a margin — printed with gists for
 * hand-curation into bench/key_live.json.
 *
 *   npx tsx tools/mine_probes.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSession, tokens, jaccard } from "../ext/core.ts";
import { loadBlocks } from "../ext/store.ts";

const files: [string, string][] = [
	["A", `${homedir()}/.pi/agent/sessions/--home-aurel-Documents-current-code-parser--/2026-09-28T07-30-31-842Z_01a0e6ec-2921-733b-9736-2b6ea32df080.jsonl`],
	["B", `${homedir()}/.pi/agent/sessions/--home-aurel-Documents-current-MorphFam-MorphEditor--/2026-09-06T15-48-04-240Z_01a07767-c40e-763a-bb21-3e7b5ab074ab.jsonl`],
];
const blocks = loadBlocks();
const RE = /remind|where were|what did we|how did we|remember|previously|last time|we decided|do you recall|summariz|forgot|status of/i;

console.log("== indexed blocks ==");
for (const b of blocks) console.log(`${b.id.split("--").pop()}  T${b.firstTurn}-${b.lastTurn}  ${(b.gist ?? "").slice(0, 70)}`);

for (const [sid, file] of files) {
	const slug = file.match(/sessions\/([^/]+)\//)![1];
	const turns = parseSession(file);
	console.log(`\n== session ${sid} (${slug.split("--").slice(1).join("-")}, ${turns.length} turns) — recall-style turns ==`);
	for (const t of turns) {
		if (!RE.test(t.user) || t.user.length < 25) continue;
		const past = blocks.filter((b) => b.session === slug && b.lastTurn < t.n);
		if (!past.length) continue;
		const q = tokens(t.user);
		const scored = past
			.map((b) => ({ b, s: jaccard(q, new Set(b.tokensHybrid)) + jaccard(q, tokens(b.gist ?? "")) }))
			.sort((x, y) => y.s - x.s);
		const gap = Math.round((scored[0].s - (scored[1]?.s ?? 0)) * 100) / 100;
		const tag = gap >= 0.015 ? "*" : " ";
		console.log(`${tag} turn ${t.n} | argmax ${scored[0].b.id.split("--").pop()} gap ${gap} | ${t.user.slice(0, 88).replace(/\n/g, " ")}`);
	}
}
