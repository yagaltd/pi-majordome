/**
 * Resume bench (v2 point 0 — define success BEFORE the one-pager exists).
 *
 * Question the one-pager must answer: "a fresh session continues prior work —
 * does the memory layer surface the right context without re-reading the raw
 * session?" Baseline = the current recall path only (route(): recall
 * injection, no composed one-pager). After the one-pager ships, re-run: the
 * A/B is THIS file's numbers vs the post-one-pager numbers. Same probes,
 * same grading, versioned in git.
 *
 * Success criteria (pre-registered):
 *   decision/leaveoff : gold must appear in top-3 of the recall (hit@3)
 *   invalidated       : gold appears in top-3 AND outranks its predecessor
 *   continuation      : route() abstains (gate)
 * One-pager upgrade bar: hit@3 ≥ baseline on every class, and at least one
 * class improves. No regression tolerated.
 *
 *   npx tsx tools/resumebench.ts
 *
 * Same judge wiring as livebench (typellm judges; typellm dims fallback —
 * jev registry absent outside pi).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokens } from "../ext/core.ts";
import { dimVector, routingIntent } from "../ext/judges.ts";
import { route } from "../ext/router.ts";
import { loadBlocks, loadVocab, type Block } from "../ext/store.ts";

type Probe = { id: string; class: "decision" | "leaveoff" | "invalidated" | "continuation"; query: string; goldMustMatch?: string[] };

const probes: Probe[] = JSON.parse(readFileSync(join(import.meta.dirname ?? "tools", "..", "bench", "resume_probes.json"), "utf8"));

const blocks: Block[] = loadBlocks();
const vocab = loadVocab();
console.log(`index: ${blocks.length} blocks, vocab ${vocab.length} dims\n`);

function goldHit(r: Awaited<ReturnType<typeof route>>, probe: Probe): { rank: number; block: Block | null } {
	if (!probe.goldMustMatch || !r?.ranked) return { rank: -1, block: null };
	for (let i = 0; i < Math.min(3, r.ranked.length); i++) {
		const b = r.ranked[i].block;
		const hay = `${b.gist ?? ""} ${b.head ?? ""}`.toLowerCase();
		if (probe.goldMustMatch.every((k) => hay.includes(k))) return { rank: i + 1, block: b };
	}
	return { rank: -1, block: null };
}

const rows: any[] = [];
for (const p of probes) {
	const r = await route({
		userMessage: p.query,
		blocks,
		currentSession: "__bench__",
		currentTurn: 99999,
		routingIntent,
		queryDims: (q) => (vocab.length ? dimVector(q, vocab, "message") : Promise.resolve(null)),
		tokens,
	});
	const g = goldHit(r, p);
	let mark: string;
	if (p.class === "continuation") mark = r === null ? "PASS(abstain)" : `FAIL(ranked ${r.ranked.length})`;
	else if (g.rank > 0) mark = `hit@${g.rank}`;
	else mark = "MISS";
	rows.push({ id: p.id, class: p.class, intent: r?.intent ?? "continuation", arm: r?.arm ?? "-", hitRank: p.class === "continuation" ? null : g.rank, score: r ? Math.round(r.score * 100) / 100 : null, winner: r?.winner?.id ?? null });
	console.log(`${mark.padEnd(14)} ${p.id.padEnd(24)} ${rows[rows.length - 1].intent.slice(0, 17).padEnd(17)} ${rows[rows.length - 1].arm}`);
}

const recall = rows.filter((r) => r.class !== "continuation");
const hits = recall.filter((r) => (r.hitRank ?? -1) > 0).length;
const cont = rows.filter((r) => r.class === "continuation");
const contOk = cont.filter((r) => r.intent === "continuation").length;
const summary = { date: new Date().toISOString(), probes: probes.length, recallHitAt3: `${hits}/${recall.length}`, continuationGate: `${contOk}/${cont.length}`, rows };
mkdirSync(join(import.meta.dirname ?? "tools", "..", "bench", "results"), { recursive: true });
writeFileSync(join(import.meta.dirname ?? "tools", "..", "bench", "results", "resume-baseline.json"), JSON.stringify(summary, null, 2));
console.log(`\nbaseline: hit@3 ${hits}/${recall.length}, continuation gate ${contOk}/${cont.length} → bench/results/resume-baseline.json`);
