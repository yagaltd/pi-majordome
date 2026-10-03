/**
 * reasoning map (v2.3) — lazy compile of the index into an IBIS-style ToC.
 *
 * trail = append-only source; this map is a derived projection, rebuilt on
 * every run (never the truth). Tree: project → session → blocks (gist +
 * turn pointers); blocks whose gist marks a drop/reject/reversal render with
 * ✗ (invalidation memory — cheap now, judge-battery refinement in v2.4).
 * Output: .majordome/map.mmd (Mermaid mindmap, short labels; render in a
 * Herdr pane: `termaid .majordome/map.mmd`) + .majordome/map.json (turn
 * pointers — the machine side, cited by one-pager sections).
 */
import { shortTag } from "./core.ts";
import type { Block } from "./store.ts";

const DROPPED = /\b(dropped|rejected|reverted|instead of|not adopt|won't use|will not use|no longer)\b/i;
const clean = (s: string) =>
	s.replace(/["`()]/g, "'").replace(/[[\]{};:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "(block)";

export interface CompiledMap {
	mmd: string;
	json: { generated: string; root: string; children: any[] };
}

export function compileMap(blocks: Block[], root = "work"): CompiledMap {
	const bySession = new Map<string, Block[]>();
	for (const b of blocks) {
		if (!bySession.has(b.session)) bySession.set(b.session, []);
		bySession.get(b.session)!.push(b);
	}
	const children: any[] = [];
	const mmd: string[] = ["mindmap", `  root((${clean(root)}))`];
	for (const [session, bs] of [...bySession.entries()].sort()) {
		const tag = shortTag(session);
		const sorted = [...bs].sort((a, b) => a.firstTurn - b.firstTurn);
		mmd.push(`    ${clean(tag).replace(/\s+/g, "_")}`);
		const nodes = sorted.map((b) => {
			const status = DROPPED.test(b.gist ?? "") ? "✗ " : "";
			const label = `${status}${b.gist ?? b.head} [${b.firstTurn}–${b.lastTurn}]`;
			mmd.push(`      ${clean(label).replace(/\s+/g, "_")}`);
			return { id: b.id, label, session, turns: [b.firstTurn, b.lastTurn], status: status ? "invalidated" : "active", gist: b.gist, sessionFile: b.sessionFile };
		});
		children.push({ session, tag, nodes });
	}
	return { mmd: mmd.join("\n") + "\n", json: { generated: new Date().toISOString(), root, children } };
}
