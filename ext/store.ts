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
import { isValidDocsProfile, type DocsProfile } from "./docsprofile.ts";

/** Lifecycle state (v2.4). Absent reads as "valid" — pre-v2.4 records and
 * hand-written store lines stay first-class without migration. Assigned only
 * by consolidation, always backed by a recorded verdict (trail + artifact). */
export type BlockStatus = "valid" | "superseded" | "failed" | "speculative";
export const BLOCK_STATUSES: readonly BlockStatus[] = ["valid", "superseded", "failed", "speculative"];

/** Decision-block ledger statuses (v2.11) — the deliverable-ledger vocabulary,
 * distinct from the lifecycle vocabulary above. A block is EITHER a memory
 * block (BlockStatus) OR a decision record (DecisionStatus); the two fields
 * never mix: decision blocks carry `decision.status`, never `status`. */
export type DecisionStatus = "built" | "parked" | "dropped" | "pending";
export const DECISION_STATUSES: readonly DecisionStatus[] = ["built", "parked", "dropped", "pending"];

/** The deliverable-ledger payload of a decision block: one status agreement
 * about one item, appended — never updated. The FOLD (ext/status.ts) reads
 * the latest appended block per item as the live row. Evidence/substrate are
 * stored verbatim from the agreement (a 7-hex commit for built rows). */
export interface DecisionPayload {
	item: string;
	status: DecisionStatus;
	evidence: string;
	substrate: string;
}

/** Session tag all decision blocks share (the ledger channel — not a real
 * session; list/dash show them under this tag). The per-repo ledger key rides
 * `sessionFile` (= the repo root the decision belongs to), so @slug house
 * views fold only that repo's decisions and cold repos stay honest. */
export const DECISION_SESSION = "decision-ledger";

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
	status?: BlockStatus; // absent = valid (lenient parse below)
	/** Canonical repo root this block belongs to (cross-repo attribution):
	 * git toplevel of the writing cwd or evidence-inferred repo. Absent on
	 * pre-sweep blocks — decisionInRepo falls back to sessionFile. */
	repo?: string;
	/** Set when attribution came from evidence paths, not the writing cwd. */
	attributed?: "evidence-path";
	/** Provenance (v2.9): TRUE only for blocks ingested from outside the
	 * session channels — ingest-docs sources and .majordome-shared/ shared
	 * sources. Session blocks stay UNSET (trusted-class by decision: the
	 * pi-guard/jev-guard pair covers the tool-call + instruction channels;
	 * this flag covers the recall-amplification channel — content that never
	 * passed through a judged session turn). Lenient parse below. */
	fromUntrusted?: boolean;
	/** Lesson classification (v2.9): the block-close judge (blockMeta seam —
	 * the SAME batched call, no extra call) answered "does this block record a
	 * mistake/error/lesson worth remembering as guidance?". Fail-open: absent
	 * or malformed reads false — only a confident yes makes a lesson. Lessons
	 * are an index class, NOT a doc: recall boosts them, the one-pager derives
	 * a Lessons section from them, consolidation pairs them (same-mistake-twice
	 * rule). Lenient parse below. */
	lesson?: boolean;
	/** Decision-record discriminant (v2.11): "decision" marks a deliverable-
	 * ledger block (the DECISION_SESSION channel) whose payload lives in
	 * `decision`. Absent = a memory block. Lenient parse below. */
	kind?: "decision";
	/** The ledger payload (item · status · evidence · substrate) — present iff
	 * kind === "decision". Never the lifecycle `status` field above. */
	decision?: DecisionPayload;
	/** Free-form tags (v2.11, decision blocks first): ["decision", "status",
	 * <slug-of-item>] — grep/display metadata, never recall keys. */
	tags?: string[];
}

/** Narrow a block to a well-formed decision record. Lenient: kind/decision
 * junk reads as a plain memory block (same class as the corrupt-status
 * parse — the append-only file is never fatal). */
export function isDecisionBlock(b: Block): b is Block & { kind: "decision"; decision: DecisionPayload } {
	return b.kind === "decision" && !!b.decision && typeof b.decision.item === "string"
		&& DECISION_STATUSES.includes(b.decision.status)
		&& typeof b.decision.evidence === "string" && typeof b.decision.substrate === "string";
}

export function statusOf(b: { status?: BlockStatus }): BlockStatus {
	return b.status ?? "valid";
}

/** Lifecycle sidecar artifact (v2.4): statuses may also live here for stores
 * where records were not rewritten. Bench/doctor read either shape. */
export interface Supersession {
	older: string; // block id demoted
	newer: string; // block id that supersedes it
	verdict: string; // e.g. "contradicts" | "tried-and-failed"
	source: string; // "typellm" | "jev" | "heuristic-lexical"
}
export interface Lifecycle {
	statuses: Record<string, BlockStatus>;
	supersessions: Supersession[];
}

export function loadLifecycle(): Lifecycle {
	try {
		const m = JSON.parse(readFileSync(p("lifecycle.json"), "utf8"));
		const ok = (s: unknown): s is BlockStatus => BLOCK_STATUSES.includes(s as BlockStatus);
		const statuses: Record<string, BlockStatus> = {};
		for (const [id, s] of Object.entries(m.statuses ?? {})) if (ok(s)) statuses[id] = s;
		return { statuses, supersessions: Array.isArray(m.supersessions) ? m.supersessions : [] };
	} catch {
		return { statuses: {}, supersessions: [] };
	}
}

export function saveLifecycle(l: Lifecycle): void {
	mkdirSync(majordomeDir(), { recursive: true });
	writeFileSync(p("lifecycle.json"), JSON.stringify(l, null, 1) + "\n");
}

/** Best-known status for a block: record field first, sidecar fallback. */
export function effectiveStatus(b: Block, art: Lifecycle): BlockStatus {
	return b.status ?? art.statuses[b.id] ?? "valid";
}

export interface RoutingDecision {
	ts: string;
	query: string;
	intent: string;
	arm: string;
	winner: string | null;
	score: number | null;
	injected: boolean;
	/** Recall-feedback telemetry (v2.10): the session the decision happened in
	 * and the cumulative turn cursor (meta.turns + 1 — the in-flight turn, the
	 * same cursor trail lines carry). Optional + lenient: pre-telemetry records
	 * read fine without them (proxy skips unstamped ✓ entries — unmeasurable,
	 * not unreferenced). No parallel store: these ride the existing log.jsonl. */
	turn?: number;
	sessionFile?: string;
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
			const b = JSON.parse(line) as Block;
			// lenient lifecycle parse: unknown/corrupt status values read as valid
			if (b.status !== undefined && !BLOCK_STATUSES.includes(b.status)) delete b.status;
			// lenient provenance/classification parse: non-boolean junk reads as absent
			if (b.fromUntrusted !== undefined && typeof b.fromUntrusted !== "boolean") delete b.fromUntrusted;
			if (b.lesson !== undefined && typeof b.lesson !== "boolean") delete b.lesson;
			// lenient decision parse: malformed kind/payload reads as a plain block
			if (b.kind !== undefined && b.kind !== "decision") delete b.kind;
			if (b.decision !== undefined && !isDecisionBlock(b)) { delete b.decision; delete b.kind; }
			out.push(b);
		} catch {
			// skip corrupt line (append-only file: never fatal)
		}
	}
	return out;
}

/** Dim vector for a NEW block record: the judged dims, plus the `lessons`
 * topic dim when the block-close judge classified the block as a lesson
 * (v2.9). Lessons ride the SAME dims arm as every other topic — a lesson
 * block is retrievable on 'lessons' dim queries exactly like any induced
 * topic, and the one-pager/consolidation class off Block.lesson. */
export function blockDims(vec: Map<string, number> | null, lesson: boolean): Record<string, number> {
	return { ...(vec ? Object.fromEntries(vec) : {}), ...(lesson ? { lessons: 1 } : {}) };
}

export function appendBlock(b: Block): void {
	mkdirSync(majordomeDir(), { recursive: true });
	// write-seam guard: partial writes must never produce session-less blocks
	// (they crash shortTag in list/dash — found 2026-10-06)
	if (!(b as Partial<Block>).session) (b as Partial<Block>).session = "(direct)";
	appendFileSync(p("blocks.jsonl"), JSON.stringify(b) + "\n");
}

/** Forget = rewrite blocks.jsonl without the victims (only mutating write). */
export function rewriteBlocks(keep: Block[]): void {
	mkdirSync(majordomeDir(), { recursive: true });
	writeFileSync(p("blocks.jsonl"), keep.map((b) => JSON.stringify(b)).join("\n") + (keep.length ? "\n" : ""));
}

export interface Meta {
	dims: string[];
	docsCursor: Record<string, string>; // doc name -> ISO time last touched
	turns?: number; // cumulative turn counter (judge-cost telemetry denominator; stamped at turn_end)
	docsProfile?: DocsProfile; // per-repo docs watch — detected at init; .majordome/docs.json overrides at read time
}

export function loadMeta(): Meta {
	const f = p("index.json");
	try {
		const m = JSON.parse(readFileSync(f, "utf8"));
		const out: Meta = { dims: m.dims ?? [], docsCursor: m.docsCursor ?? {} };
		if (typeof m.turns === "number") out.turns = m.turns;
		if (isValidDocsProfile(m.docsProfile)) out.docsProfile = m.docsProfile; // lenient: junk profile reads as absent
		return out;
	} catch {
		return { dims: [], docsCursor: {} };
	}
}

export function saveMeta(meta: Meta): void {
	mkdirSync(majordomeDir(), { recursive: true });
	// docsProfile is adopted at init and long-lived, and the turn counter is
	// stamped every turn_end: callers that only rotate dims/cursors (most
	// saveMeta sites) must not clobber either
	let docsProfile = meta.docsProfile;
	let turns = typeof meta.turns === "number" ? meta.turns : undefined;
	if (!docsProfile || turns === undefined) {
		try {
			const prev = JSON.parse(readFileSync(p("index.json"), "utf8"));
			if (!docsProfile && isValidDocsProfile(prev?.docsProfile)) docsProfile = prev.docsProfile;
			if (turns === undefined && typeof prev?.turns === "number") turns = prev.turns;
		} catch {
			/* fresh store */
		}
	}
	writeFileSync(p("index.json"), JSON.stringify({ dims: meta.dims, docsCursor: meta.docsCursor, ...(turns ? { turns } : {}), ...(docsProfile ? { docsProfile } : {}) }, null, 1));
}

export function loadVocab(): string[] {
	return loadMeta().dims;
}

export function saveVocab(dims: string[]): void {
	const m = loadMeta();
	m.dims = dims;
	saveMeta(m);
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
