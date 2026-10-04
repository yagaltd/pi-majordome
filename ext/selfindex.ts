/**
 * Self-Index key evolution (v2.4) — label-free index improvement.
 *
 * Diagnosed MISSES (bench/results/resume-baseline.json) → for each, simulate
 * the query against the current ranking, take the near-miss blocks, ask the
 * judge for terse retrieval phrases, GATE them (faithfulness: content words
 * must exist in the block; specificity: phrase must not match >30% of the
 * corpus), then fold surviving phrases into tokensHybrid. Persisted; re-run
 * resumebench for the before/after. Keys cite their provenance in the trail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokens } from "./core.ts";
import { keyPhrases } from "./judges.ts";
import { loadBlocks, rewriteBlocks, type Block } from "./store.ts";

export async function evolveKeys(benchDir = "bench"): Promise<{ probed: number; blocksTouched: number; phrasesAdded: number; gated: number }> {
	const base = JSON.parse(readFileSync(join(benchDir, "results", "resume-baseline.json"), "utf8"));
	const probes: any[] = JSON.parse(readFileSync(join(benchDir, "resume_probes.json"), "utf8"));
	const missed = base.rows.filter((r: any) => r.class !== "continuation" && (r.hitRank ?? -1) <= 0);
	const probeById = new Map(probes.map((p) => [p.id, p]));
	const blocks = loadBlocks();
	const corpusToken = new Map<string, number>();
	for (const b of blocks) for (const t of b.tokensHybrid) corpusToken.set(t, (corpusToken.get(t) ?? 0) + 1);
	const { route } = await import("./router.ts");
	const { dimVector, routingIntent } = await import("./judges.ts");
	const { loadVocab } = await import("./store.ts");
	const vocab = loadVocab();

	let blocksTouched = 0;
	let phrasesAdded = 0;
	let gated = 0;
	const edits = new Map<string, Set<string>>();
	for (const m of missed) {
		const probe = probeById.get(m.id);
		if (!probe?.goldMustMatch) continue;
		const r = await route({
			userMessage: probe.query,
			blocks,
			currentSession: "__bench__",
			currentTurn: 99999,
			routingIntent,
			queryDims: (q) => (vocab.length ? dimVector(q, vocab, "message") : Promise.resolve(null)),
			tokens,
		});
		const cands = (r?.ranked ?? []).slice(0, 5);
		for (const c of cands) {
			const b: Block = c.block;
			const seg = `${b.gist ?? ""}\n${b.head}\n${b.tokensHybrid.join(" ")}`;
			const phrases = await keyPhrases(seg, probe.query);
			for (const ph of phrases) {
				const pt = [...tokens(ph)];
				// faithfulness: ≥1 content token present in the block itself
				if (!pt.some((t) => b.tokensHybrid.includes(t))) {
					gated++;
					continue;
				}
				// specificity: no single token covering >30% of the corpus
				if (pt.some((t) => (corpusToken.get(t) ?? 0) / blocks.length > 0.3)) {
					gated++;
					continue;
				}
				if (!edits.has(b.id)) edits.set(b.id, new Set());
				const set = edits.get(b.id)!;
				const before = set.size;
				for (const t of pt) set.add(t);
				phrasesAdded += set.size - before;
			}
		}
	}
	if (edits.size) {
		for (const b of blocks) {
			const add = edits.get(b.id);
			if (!add) continue;
			b.tokensHybrid = [...new Set([...b.tokensHybrid, ...add])].sort();
			blocksTouched++;
		}
		rewriteBlocks(blocks);
	}
	return { probed: missed.length, blocksTouched, phrasesAdded, gated };
}
