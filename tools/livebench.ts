/**
 * Live-hardening bench: run the ACTUAL router (live judges) over mined real
 * probes against the live index. No pi shell — this isolates routing quality.
 *
 *   npx tsx tools/livebench.ts
 *
 * Note: runs outside pi, so Jev registry is absent → dimVector uses the
 * guarded TypeLLM-number fallback (a shipped config). Report records that.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tokens } from "../ext/core.ts";
import { dimVector, routingIntent } from "../ext/judges.ts";
import { route } from "../ext/router.ts";
import { loadBlocks, loadVocab, type Block } from "../ext/store.ts";

const cfg = JSON.parse(readFileSync(join(import.meta.dirname ?? "tools", "..", "bench", "key_live.json"), "utf8"));
const slugOf = (s: string) => s.replace(/^~/, homedir()).match(/sessions\/([^/]+)\//)![1];
const slugs: Record<string, string> = Object.fromEntries(Object.entries(cfg.sessions).map(([k, v]: any) => [k, slugOf(v)]));
const blocks: Block[] = loadBlocks();
const vocab = loadVocab();
console.log(`index: ${blocks.length} blocks, vocab ${vocab.length} dims, judges: typellm (jev n/a outside pi)\n`);

const rows: any[] = [];
for (const p of cfg.probes) {
	const currentSession = p.sess ? slugs[p.sess] : "__bench__";
	const currentTurn = p.turn ?? 99999;
	const r = await route({
		userMessage: p.query,
		blocks,
		currentSession,
		currentTurn,
		routingIntent,
		queryDims: (q) => (vocab.length ? dimVector(q, vocab, "message") : Promise.resolve(null)),
		tokens,
	});
	const goldTurn = p.gold ? p.gold.split(":").pop() : null;
	const goldSess = p.gold && !p.gold.startsWith(":") ? slugs[p.gold.split(":")[0]] : currentSession;
	const rank = r?.ranked && goldTurn ? r.ranked.findIndex((x) => x.block.session === goldSess && x.block.id.endsWith(":" + goldTurn)) + 1 : -1;
	rows.push({
		id: p.id, class: p.class, intent: r?.intent ?? "continuation", arm: r?.arm ?? "-",
		winner: r?.winner ? r.winner.id.split("--").pop() : null, score: r ? Math.round(r.score * 100) / 100 : null,
		goldRank: p.gold && r ? (rank > 0 ? rank : -1) : null,
	});
	const mark =
		p.class === "continuation" ? (r === null ? "PASS" : "miss") :
		p.class === "past" ? (rows[rows.length - 1].goldRank === 1 ? "PASS" : `rank ${rows[rows.length - 1].goldRank}`) :
		p.class === "cross" ? (rows[rows.length - 1].goldRank === 1 ? "PASS" : `rank ${rows[rows.length - 1].goldRank}`) :
		(r === null ? "abstained" : `noise(${rows[rows.length - 1].winner} ${rows[rows.length - 1].score})`);
	console.log(`${mark.padEnd(16)} ${p.id.padEnd(20)} ${rows[rows.length - 1].intent.slice(0, 17).padEnd(17)} ${rows[rows.length - 1].arm} → ${rows[rows.length - 1].winner ?? "-"}`);
}

const hard = rows.filter((r) => r.class === "past" || r.class === "cross");
const r1 = hard.filter((r) => r.goldRank === 1).length;
const cont = rows.filter((r) => r.class === "continuation");
const contOk = cont.filter((r) => r.intent === "continuation").length;
const soft = rows.filter((r) => r.class === "current" || r.class === "future" || r.class === "abstain");
const softOk = soft.filter((r) => r.intent === "continuation" || r.winner === null).length;
const noiseScores = soft.filter((r) => r.winner && typeof r.score === "number").map((r) => r.score);
console.log(`\nhard recall: ${r1}/${hard.length} @1`);
console.log(`continuation gate: ${contOk}/${cont.length} correctly gated`);
console.log(`soft abstention: ${softOk}/${soft.length} abstained; noise scores when injected: [${noiseScores.join(", ")}] (threshold candidate)`);

mkdirSync(join(import.meta.dirname ?? "tools", "..", "bench", "results", "live"), { recursive: true });
writeFileSync(
	join(import.meta.dirname ?? "tools", "..", "bench", "results", "live", "report.json"),
	JSON.stringify({ judge_config: "typellm-only (jev n/a outside pi)", rows, summary: { hard_r1: `${r1}/${hard.length}`, continuation: `${contOk}/${cont.length}`, soft_abstain: `${softOk}/${soft.length}`, noise_scores: noiseScores } }, null, 1),
);
console.log("report → bench/results/live/report.json");
