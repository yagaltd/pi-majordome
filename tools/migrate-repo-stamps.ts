// one-time legacy sweep: explicit repo stamps on every block missing one
// (cross-repo attribution row). Backup + deterministic verify + IO shell
// around the pure sweepRepoStamps core.
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadBlocks, rewriteBlocks } from "../ext/store.ts";
import { sweepRepoStamps } from "../ext/status.ts";

const storePath = join(homedir(), ".pi", "majordome", "blocks.jsonl");
const before = loadBlocks();
copyFileSync(storePath, storePath + ".bak-sweep");
const { blocks, stamped, stripped } = sweepRepoStamps(before);
if (blocks.length !== before.length) throw new Error(`count drift ${before.length} → ${blocks.length}`);
for (let i = 0; i < blocks.length; i++) {
	const [a, b] = [before[i], blocks[i]];
	for (const k of Object.keys(a)) if (k !== 'repo' && JSON.stringify((a as any)[k]) !== JSON.stringify((b as any)[k])) throw new Error(`field drift at #${i}: ${k}`);
}
rewriteBlocks(blocks);
const byRepo = new Map<string, number>();
for (const b of blocks) byRepo.set(b.repo!, (byRepo.get(b.repo!) ?? 0) + 1);
console.log(`swept: ${stamped} stamped · ${stripped} stripped (non-decision) · backup: blocks.jsonl.bak-sweep`);
for (const [r, n] of [...byRepo.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${r}`);
console.log(readFileSync(storePath, "utf8").split("\n").length - 1, "lines — count preserved");
