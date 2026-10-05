/**
 * /majordome init (v2.5) — cold-start: classify a repo's PAST sessions into
 * the index, then compose the map + one-pager. Day-one memory for existing
 * repos; the coverage fix the resume bench diagnosed.
 *
 * Triage (lineage design):
 *   - sessions whose slug matches the current repo → full index
 *   - other slugs → PARKED: listed in init.json, shown in the map under a
 *     `lineage` branch (metadata only, zero retrieval weight); index them
 *     explicitly with --lineage <slug>|all (session marked `lineage:<slug>`,
 *     separate federated pool — visible, never silently blended, purgeable)
 *
 * Resumable: per-file cursor in init.json — interrupted runs never write
 * partial blocks (a file's blocks append only after it fully classifies).
 * --dry-run: parse + boundaries only, reports exact block and judge-call
 * estimate before any spend. Fail-open per block (errors.log, live recipe).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blockCores, detectBoundaries, isSubagentSession, parseSession, sessionSlug } from "./core.ts";
import { blockMeta, dimVector, induceDims } from "./judges.ts";
import { appendBlock, loadBlocks, loadVocab, saveVocab, type Block } from "./store.ts";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const CONCURRENCY = 4;

export interface InitState {
	done: string[]; // session files fully classified
	lineage: Record<string, "parked" | "indexed">; // slug → status
}
export function initStateFile(): string {
	return process.env.MAJORDOME_INIT_STATE?.trim() || join(homedir(), ".pi", "majordome", "init.json");
}
function loadState(): InitState {
	try {
		return JSON.parse(readFileSync(initStateFile(), "utf8"));
	} catch {
		return { done: [], lineage: {} };
	}
}
function saveState(s: InitState): void {
	writeFileSync(initStateFile(), JSON.stringify(s, null, 2));
}

function discover(): string[] {
	if (!existsSync(SESSIONS_DIR)) return [];
	const out: string[] = [];
	for (const d of readdirSync(SESSIONS_DIR)) {
		// subagent scratch sessions (.git-subagents worktrees) duplicate the main
		// session's work — their blocks never enter the index via sweeps
		if (isSubagentSession(d)) continue;
		const sub = join(SESSIONS_DIR, d);
		try {
			for (const f of readdirSync(sub)) if (f.endsWith(".jsonl")) out.push(join(sub, f));
		} catch {
			/* not a dir */
		}
	}
	return out;
}

export interface InitOpts {
	cwd: string;
	dryRun?: boolean;
	slug?: string; // override repo-slug match
	lineage?: string | "all"; // park-only slugs to index too
	limit?: number; // max files this run
	noDims?: boolean;
}

export async function initRepo(opts: InitOpts): Promise<string> {
	const files = discover();
	const bySlug = new Map<string, string[]>();
	for (const f of files) {
		const s = sessionSlug(f);
		if (!bySlug.has(s)) bySlug.set(s, []);
		bySlug.get(s)!.push(f);
	}
	// resolve current-repo slug: --slug wins; else the slug containing the cwd basename
	const base = opts.cwd.split("/").filter(Boolean).pop()!.toLowerCase();
	let current = opts.slug ?? null;
	if (!current) {
		const cands = [...bySlug.keys()].filter((s) => s.toLowerCase().includes(base));
		if (cands.length === 1) current = cands[0];
		else if (cands.length === 0) return `majordome init: no sessions found for "${base}" — pass slug explicitly`;
		else return `majordome init: ambiguous slug "${base}" (${cands.length} candidates) — pass --slug`;
	}

	const state = loadState();
	const done = new Set(state.done);
	const target = bySlug.get(current) ?? [];
	const lineageSlugs = opts.lineage === "all" ? [...bySlug.keys()].filter((s) => s !== current) : opts.lineage ? [opts.lineage] : [];
	const todo = [...new Set([...target.filter((f) => !done.has(f)), ...lineageSlugs.flatMap((s) => bySlug.get(s) ?? []).filter((f) => !done.has(f))])].slice(0, opts.limit ?? Infinity);

	// dry-run: boundaries only — exact counts, zero judge spend
	if (opts.dryRun) {
		let blocks = 0;
		for (const f of todo) {
			try {
				blocks += detectBoundaries(parseSession(f)).length;
			} catch {
				/* skip unreadable */
			}
		}
		const calls = opts.noDims ? blocks * 1.33 : blocks * 2.33;
		return `dry-run: ${todo.length} sessions → ~${blocks} blocks → ~${Math.round(calls)} judge calls (${current}${lineageSlugs.length ? ` + lineage: ${lineageSlugs.join(", ")}` : ""}). Run without --dry-run to execute.`;
	}

	const existing = new Set(loadBlocks().map((b) => b.id));
	let vocab = loadVocab();
	let indexed = 0;
	let calls = 0;
	const newDone: string[] = [];
	for (const f of todo) {
		let turns;
		try {
			turns = parseSession(f);
		} catch {
			continue;
		}
		const slug = sessionSlug(f);
		const isLineage = slug !== current;
		const session = isLineage ? `lineage:${slug}` : slug;
		const cores = blockCores(turns, detectBoundaries(turns));
		const fresh = cores.filter((c) => !existing.has(`${session}:${c.firstTurn}`));
		if (!fresh.length) {
			newDone.push(f);
			continue;
		}
		// classify with a small pool; a file appends only when fully classified
		const metas: (Block["gist"] | null)[] = new Array(fresh.length).fill(null);
		let idx = 0;
		let failed = false;
		async function worker() {
			while (idx < fresh.length) {
				const i = idx++;
				try {
					const m = await blockMeta(fresh[i].text);
					metas[i] = m?.gist ?? null;
					intents[i] = m?.intent ?? null;
					calls++;
				} catch {
					failed = true; // live recipe: skip on judge error
					return;
				}
			}
		}
		const intents: (string | null)[] = new Array(fresh.length).fill(null);
		await Promise.all(Array.from({ length: CONCURRENCY }, worker));
		if (failed) continue; // file stays un-done → retried next run
		if (!opts.noDims) {
			for (let i = 0; i < fresh.length; i += 3) {
				if (vocab.length >= 40) break;
				try {
					const induced = await induceDims(fresh[i].text);
					vocab = [...new Set([...vocab, ...induced])].slice(0, 40);
					calls++;
				} catch {
					/* vocab growth is best-effort */
				}
			}
		}
		for (let i = 0; i < fresh.length; i++) {
			const c = fresh[i];
			let dims: Record<string, number> = {};
			if (!opts.noDims && vocab.length) {
				try {
					const vec = await dimVector(c.text, vocab, "segment");
					dims = vec ? Object.fromEntries(vec) : {};
					calls++;
				} catch {
					/* dims fail open */
				}
			}
			const b: Block = {
				id: `${session}:${c.firstTurn}`,
				session,
				sessionFile: f,
				firstTurn: c.firstTurn,
				lastTurn: c.lastTurn,
				gist: metas[i],
				intent: intents[i],
				dims,
				tokensHybrid: [...c.tokensHybrid].sort(),
				head: (turns[c.firstTurn - 1] as any)?.user?.slice(0, 200) ?? "",
				closedAt: statSync(f).mtime.toISOString(), // ORIGINAL time — ingest-time stamping floods recency sections (caught by the one-pager A/B: 4/6 → 3/6)
			};
			try {
				appendBlock(b);
				existing.add(b.id);
				indexed++;
			} catch {
				/* errors are the live recipe's problem class — skip */
			}
		}
		saveVocab(vocab);
		newDone.push(f);
		state.done = [...new Set([...state.done, ...newDone])];
		for (const s of lineageSlugs) state.lineage[s] = "indexed";
		saveState(state);
		if (opts.lineage) for (const s of lineageSlugs) if (!state.lineage[s]) state.lineage[s] = "parked";
		saveState(state);
	}
	// park unselected slugs (map-only visibility)
	for (const s of bySlug.keys()) if (s !== current && !state.lineage[s] && !lineageSlugs.includes(s)) state.lineage[s] = "parked";
	saveState(state);
	const parkedCount = Object.values(state.lineage).filter((v) => v === "parked").length;
	// v2.4: a plain init consolidates — lifecycle statuses land on the fresh
	// blocks immediately (judge seam + lexical fallback, trail-recorded)
	let lifecycleNote = "";
	if (indexed > 0) {
		try {
			const { runConsolidation, summaryLine } = await import("./consolidate.ts");
			const cr = await runConsolidation();
			lifecycleNote = ` ${summaryLine(cr)}.`;
		} catch {
			/* consolidation is maintenance, never a reason to fail init */
		}
	}
	return `majordome init complete: +${indexed} blocks from ${newDone.length} sessions.${lifecycleNote} ${parkedCount} other project(s) parked (map-only) — /majordome init --lineage <slug> to index one.`;
}
