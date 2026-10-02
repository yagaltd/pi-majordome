/**
 * Backfill the live index from the bench artifacts (real sessions, real gists,
 * real slice-5 Jev vectors — zero judge spend). This is the same data the
 * 3/7 specialist result was measured on, materialized into ~/.pi/majordome/.
 *
 *   npx tsx tools/backfill.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockCores, parseSession, sessionSlug, tokens } from "../ext/core.ts";
import { appendBlock, loadBlocks, rewriteBlocks, saveVocab, type Block } from "../ext/store.ts";

const bench = join(import.meta.dirname ?? "tools", "..", "bench");
const cfg = JSON.parse(readFileSync(join(bench, "key_cross.json"), "utf8"));
const report = JSON.parse(readFileSync(join(bench, "results", "slice5", "report.json"), "utf8"));
const vecs = existsSync(join(bench, "results", "slice5", "jev_vecs.json"))
	? JSON.parse(readFileSync(join(bench, "results", "slice5", "jev_vecs.json"), "utf8"))
	: {};
const cross = JSON.parse(readFileSync(join(bench, "results", "cross", "cross_report.json"), "utf8"));

const dims: string[] = report.dims ?? [];
const gists = new Map<string, { gist: string; intent: string | null }>();
for (const sess of cross.index) {
	for (const [i, b] of (sess.blocks as any[]).entries()) {
		gists.set(`${sess.session}:${i}`, { gist: b.gist ?? "", intent: b.intent ?? null });
	}
}

const out: Block[] = [];
for (const [sid, scfg] of Object.entries<any>(cfg.sessions)) {
	const path = (scfg.path as string).replace(/^~/, process.env.HOME ?? "");
	const turns = parseSession(path);
	const firsts = (scfg.gold as any[]).map((g) => g.first_turn);
	const cores = blockCores(turns, firsts);
	const slug = sessionSlug(path);
	cores.forEach((core, i) => {
		const raw = vecs[`${sid}:${i}`];
		const vec = Array.isArray(raw)
			? Object.fromEntries(dims.map((d, j) => {
				const v = raw[j];
				return [d, v === true || v === 1 || (v && typeof v === "object" && Number(v.noul) >= 0.5) ? 1 : 0];
			}))
			: {};
		const gist = gists.get(`${sid}:${i}`)?.gist ?? "";
		out.push({
			id: `${slug}:${core.firstTurn}`,
			session: slug,
			sessionFile: path,
			firstTurn: core.firstTurn,
			lastTurn: core.lastTurn,
			gist: gist || null,
			intent: gists.get(`${sid}:${i}`)?.intent ?? null,
			dims: vec,
			tokensHybrid: [...core.tokensHybrid, ...tokens(gist)].sort(),
			head: turns[core.firstTurn - 1].user.slice(0, 200),
			closedAt: new Date().toISOString(),
		});
	});
	console.log(`${sid}: ${cores.length} blocks from ${turns.length} turns (${Object.keys(out[out.length - 1]?.dims ?? {}).length} dims)`);
}

if (dims.length) saveVocab(dims);
// idempotent backfill: drop prior backfilled ids, then append
const keep = loadBlocks().filter((b) => !out.some((o) => o.id === b.id));
rewriteBlocks([...keep, ...out]);
console.log(`index: ${out.length} blocks written, vocab ${dims.length} dims → ~/.pi/majordome/`);
