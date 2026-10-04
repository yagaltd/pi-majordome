/**
 * Shared-brain parity (v2.0): N concurrent writers appending single-line JSON
 * to the SAME blocks.jsonl (appendBlock is a thin appendFileSync wrapper —
 * this tests the syscall class the dispatch protocol relies on).
 *
 *   npx tsx tools/parity.ts
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const WORKERS = 4;
const PER = 50;
const dir = join(tmpdir(), `mjdx-parity-${process.pid}`);
const file = join(dir, "blocks.jsonl");
mkdirSync(dir, { recursive: true });

// each child: open the shared file once, appendFileSync PER single-line records
const childSrc = `
const { appendFileSync } = require("node:fs");
const [file, w, n] = [process.argv[2], process.argv[3], Number(process.argv[4])];
for (let i = 0; i < n; i++) {
	appendFileSync(file, JSON.stringify({ id: "w" + w + ":" + i, w, i, pad: "x".repeat(400) }) + "\\n");
}
`;
const childFile = join(dir, "writer.cjs");
writeSync(openSync(childFile, "w"), childSrc);

const kids = Array.from({ length: WORKERS }, (_, w) =>
	spawn(process.execPath, [childFile, file, String(w), String(PER)], { stdio: "ignore" }),
);
await Promise.all(kids.map((k) => new Promise<number>((res) => k.on("exit", res))));

const raw = readFileSync(file, "utf8").trim().split("\n");
let parseOk = 0;
const ids = new Map<string, number>();
for (const l of raw) {
	try {
		const b = JSON.parse(l);
		parseOk++;
		ids.set(b.id, (ids.get(b.id) ?? 0) + 1);
	} catch {
		/* torn/corrupt line */
	}
}
const expected = WORKERS * PER;
const dupes = [...ids.values()].filter((n) => n > 1).length;
console.log(`parity: lines=${raw.length} parsed=${parseOk} unique=${ids.size} dupes=${dupes} (expected ${expected})`);
console.log(parseOk === expected && ids.size === expected && dupes === 0 ? "PASS — concurrent single-line appends are safe for the shared brain" : "FAIL — appends interleaved or lost");
rmSync(dir, { recursive: true, force: true });
