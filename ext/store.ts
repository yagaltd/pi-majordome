/**
 * pi-majordome side-car store — global, append-only, never touches the
 * session JSONLs (source of truth). Layout under ~/.pi/majordome/:
 *   blocks.jsonl  one JSON block record per line (append-only)
 *   index.json    { dims: string[], stats: {...} }  (dims vocabulary, cap 40)
 *   log.jsonl     routing decision log (calibration evidence)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Block {
	id: string; // <slug>:<firstTurn>
	session: string; // cwd slug
	sessionFile: string;
	firstTurn: number;
	lastTurn: number;
	gist: string | null;
	intent: string | null; // block-close intent (implementation/…)
	dims: Record<string, number>; // named dim vector (sparse)
	tokensHybrid: string[]; // sorted token array = BM25 field
	head: string; // first user message snippet
	closedAt: string;
}

export interface RoutingDecision {
	ts: string;
	query: string;
	intent: string;
	arm: string;
	winner: string | null;
	score: number | null;
	injected: boolean;
}

export function majordomeDir(): string {
	return process.env.MAJORDOME_DIR?.trim() || join(homedir(), ".pi", "majordome");
}

function p(name: string): string {
	return join(majordomeDir(), name);
}

export function loadBlocks(): Block[] {
	const f = p("blocks.jsonl");
	if (!existsSync(f)) return [];
	const out: Block[] = [];
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// skip corrupt line (append-only file: never fatal)
		}
	}
	return out;
}

export function appendBlock(b: Block): void {
	mkdirSync(majordomeDir(), { recursive: true });
	appendFileSync(p("blocks.jsonl"), JSON.stringify(b) + "\n");
}

/** Forget = rewrite blocks.jsonl without the victims (only mutating write). */
export function rewriteBlocks(keep: Block[]): void {
	mkdirSync(majordomeDir(), { recursive: true });
	writeFileSync(p("blocks.jsonl"), keep.map((b) => JSON.stringify(b)).join("\n") + (keep.length ? "\n" : ""));
}

export function loadVocab(): string[] {
	const f = p("index.json");
	if (!existsSync(f)) return [];
	try {
		return (JSON.parse(readFileSync(f, "utf8")).dims ?? []) as string[];
	} catch {
		return [];
	}
}

export function saveVocab(dims: string[]): void {
	mkdirSync(majordomeDir(), { recursive: true });
	let meta: any = {};
	try {
		if (existsSync(p("index.json"))) meta = JSON.parse(readFileSync(p("index.json"), "utf8"));
	} catch {
		// fresh
	}
	meta.dims = dims;
	writeFileSync(p("index.json"), JSON.stringify(meta, null, 1));
}

export function appendDecision(d: RoutingDecision): void {
	try {
		mkdirSync(majordomeDir(), { recursive: true });
		appendFileSync(p("log.jsonl"), JSON.stringify(d) + "\n");
	} catch {
		// logging never breaks routing
	}
}

export function lastDecisions(n: number): RoutingDecision[] {
	const f = p("log.jsonl");
	if (!existsSync(f)) return [];
	try {
		const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
		return lines.slice(-n).map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return { query: "(corrupt)", intent: "?", arm: "?", winner: null, score: null, injected: false, ts: "" };
			}
		});
	} catch {
		return [];
	}
}
