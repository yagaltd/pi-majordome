/**
 * The deliverable ledger — data layer + views (v2.11).
 *
 * SOURCE: decision blocks in the store (blocks.jsonl, the only store). Every
 * status agreement is an APPENDED decision block (appendDecisionStatus →
 * appendBlock, DECISION_SESSION channel, per-repo key = sessionFile). The
 * fold (foldDecisions) groups by item and takes the LATEST appended block —
 * the live ledger is computed on the fly, never maintained.
 *
 * EXPORT: STATUS.md demoted to a generated export (`/majordome status
 * --export md`, exportStatusMd → statusFile, MAJORDOME_STATUS_FILE names the
 * export path). parseStatusRows/normalizeStatusText survive as the md-form
 * parser/normalizer for that one door: the export round-trips through them,
 * and tools/migrate-status.ts used them to read the legacy hand-curated
 * ledger (one-time, run at merge on master).
 *
 * Row shape (the fold output, identical to the legacy table row):
 * `| item | status | evidence | substrate |`, statuses limited to
 * built/parked/dropped/pending; built rows cite a 7-hex commit. When two
 * folded decisions for one item DISAGREE on status, the latest still wins and
 * the row is flagged (contradicted) — a contradiction is surfaced, never
 * hidden and never auto-resolved by anything but append order.
 *
 * The status join is deterministic token overlap only: block title/gist tokens
 * vs row-item tokens (core.ts tokenizer — stopwords stripped). No model call,
 * nothing invented — a line is emitted only when a row actually matches, and
 * never more than two per injection.
 */
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tokens } from "./core.ts";
import {
	DECISION_SESSION,
	DECISION_STATUSES,
	appendBlock,
	isDecisionBlock,
	loadBlocks,
	type Block,
	type DecisionStatus,
} from "./store.ts";

export const STATUS_STATUSES: readonly string[] = DECISION_STATUSES;

export interface StatusRow {
	item: string;
	status: string;
	evidence: string;
	substrate: string;
	/** Decision-fold flag: ≥2 decisions folded into this item disagreed on
	 * status. Latest appended won; the flag says the history is split. */
	contradicted?: boolean;
}

// ── md form (the export door — parse + normalize, no file reads here) ───────

/** Parse STATUS.md table rows: skip the header and the `|---|` separator,
 * keep exactly-4-column rows, trim cells, drop empties. Lenient by design —
 * a malformed row is skipped, never fatal (fail-open like every reader here).
 * Used by the export round-trip and the legacy-ledger migration; the fold
 * NEVER reads this file (grep-pinned in selfcheck). */
export function parseStatusRows(text: string): StatusRow[] {
	const lines = text.split("\n").filter((l) => l.trim().startsWith("|"));
	const rows: StatusRow[] = [];
	for (const line of lines.slice(2)) { // header + separator
		const cells = line.split("|").map((s) => s.trim());
		if (cells.length < 6) continue; // need leading+trailing empties + 4 cells
		const [item, status, evidence, substrate] = cells.slice(1, 5);
		if (!item || !status) continue;
		rows.push({ item, status, evidence: evidence ?? "", substrate: substrate ?? "" });
	}
	return rows;
}

/** Normalize a ledger back to canonical single-spaced 4-column rows (status
 * lowercased when it is a known status in another case, cells trimmed, blank
 * rows dropped). Returns the original text untouched when nothing changes —
 * housekeeping only writes on a real diff. */
export function normalizeStatusText(text: string): { text: string; changed: boolean; rows: number } {
	const lines = text.split("\n");
	const out: string[] = [];
	let changed = false;
	let skipSkeleton = 0; // the header + `|---|` separator pass through untouched
	for (const line of lines) {
		if (!/^\s*\|/.test(line)) {
			out.push(line);
			continue;
		}
		if (skipSkeleton < 2) {
			skipSkeleton++;
			out.push(line);
			continue;
		}
		const cells = line.split("|").map((s) => s.trim());
		// malformed row (not exactly 4 columns): pass through untouched —
		// normalization never invents table structure
		if (cells.length !== 6 || !cells[1] || !cells[2]) {
			out.push(line);
			continue;
		}
		const status = STATUS_STATUSES.includes(cells[2].toLowerCase()) ? cells[2].toLowerCase() : cells[2];
		const norm = `| ${cells[1]} | ${status} | ${cells[3]} | ${cells[4]} |`;
		if (norm !== line) changed = true;
		out.push(norm);
	}
	return { text: out.join("\n"), changed, rows: parseStatusRows(text).length };
}

/** STATUS.md path — the EXPORT path now: where /majordome status --export md
 * writes the generated ledger (and where the legacy migration read it),
 * `MAJORDOME_STATUS_FILE` overrides for hermetic runs (same pattern as
 * MAJORDOME_FP_FILE / MAJORDOME_TRAIL_FILE). Nothing in the live data path
 * reads this file — the fold reads decision blocks. */
export function statusFile(repoRoot: string = process.cwd()): string {
	return process.env.MAJORDOME_STATUS_FILE?.trim() || join(repoRoot, "STATUS.md");
}

// ── the decision-block store layer (append + fold) ──────────────────────────

/** slug-of-item for ids/tags: lowercase, non-alphanumeric runs → "-". */
function itemSlug(item: string): string {
	return item.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

/** True when a decision block belongs to the repo at `repoRoot` — the ledger
 * key is the block's sessionFile (stored = the resolved repo root). */
/** Canonical repo root: git toplevel when p is inside a repo, else p itself.
 * Subdirectory cwds and repo-field stamps all canonicalize through here. */
const repoRootCache = new Map<string, string>();
export function repoOf(p: string): string {
	const key = resolve(p);
	const hit = repoRootCache.get(key);
	if (hit) return hit;
	let root = key;
	try {
		root = execFileSync("git", ["-C", key, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || key;
	} catch { /* not a git repo (or git missing) — the path itself is the root */ }
	repoRootCache.set(key, root);
	return root;
}

/** Cross-repo attribution for direct-mode work (deterministic, no classifier):
 * scan the decision text for absolute paths; if they canonicalize to exactly
 * ONE repo other than the writing cwd, attribute there. Zero or many → cwd. */
export function inferRepo(hints: string, cwdRoot: string): { repo: string; attributed: "cwd" | "evidence-path" } {
	const repos = new Set<string>();
	for (const m of hints.matchAll(/\/home\/[^\s"'`),:;]+/g)) {
		const r = repoOf(m[0].replace(/[.,)]+$/, ""));
		if (r !== cwdRoot) repos.add(r);
	}
	return repos.size === 1
		? { repo: [...repos][0], attributed: "evidence-path" }
		: { repo: cwdRoot, attributed: "cwd" };
}

function decisionInRepo(b: Block, repoRoot: string): boolean {
	const want = repoOf(repoRoot);
	if (b.repo) return b.repo === want;
	try {
		return repoOf(resolve(b.sessionFile)) === want;
	} catch {
		return false;
	}
}

/** Append one status agreement as a decision block: { item, status, evidence,
 * substrate } verbatim, DECISION_SESSION session, firstTurn/lastTurn 0 (not a
 * session artifact), tags ["decision","status",<slug-of-item>]. Never
 * updates — a changed mind appends a new block and the fold moves. */
export function appendDecisionStatus(
	d: { item: string; status: DecisionStatus; evidence: string; substrate: string },
	repoRoot: string = process.cwd(),
): Block {
	const slug = itemSlug(d.item);
	const cwdRoot = repoOf(repoRoot);
	// cross-repo attribution: explicit repoRoot wins; else infer from the
	// decision text (evidence paths naming exactly one other repo win)
	const wantsRepo = repoRoot !== process.cwd();
	const inf = wantsRepo
		? { repo: repoOf(repoRoot), attributed: "cwd" as const }
		: inferRepo(`${d.item}\n${d.evidence}`, cwdRoot);
	const block: Block = {
		id: `decision:${slug}:${Date.now().toString(36)}`,
		session: DECISION_SESSION,
		sessionFile: resolve(repoRoot),
		repo: inf.repo,
		...(inf.attributed === "evidence-path" ? { attributed: "evidence-path" as const } : {}),
		firstTurn: 0,
		lastTurn: 0,
		gist: null,
		intent: null,
		dims: {},
		tokensHybrid: [],
		head: d.item,
		closedAt: new Date().toISOString(),
		kind: "decision",
		decision: { item: d.item, status: d.status, evidence: d.evidence, substrate: d.substrate },
		tags: ["decision", "status", slug],
	};
	appendBlock(block);
	return block;
}

/** Read this repo's decision blocks, in append order (file order — the fold's
 * recency is append order, nothing else). Absent store → []. */
export function loadDecisions(repoRoot: string = process.cwd()): Block[] {
	return loadBlocks().filter((b) => isDecisionBlock(b) && decisionInRepo(b, repoRoot));
}

/** THE FOLD: group decision blocks by item, LATEST appended wins → the live
 * StatusRow[] (same shape the legacy md table parsed to, so every consumer —
 * formatStatus, formatHouseStatus, housekeep, the status join — keeps
 * working unchanged). Disagreeing statuses within one item's history: latest
 * wins + `contradicted` on the row. Non-decision blocks in the input are
 * ignored (defensive lenient — callers may pass raw store reads). */
export function foldDecisions(decisions: Block[]): StatusRow[] {
	const byItem = new Map<string, { row: StatusRow; statuses: Set<string> }>();
	for (const b of decisions) {
		if (!isDecisionBlock(b)) continue;
		const d = b.decision;
		const prev = byItem.get(d.item);
		const statuses = prev?.statuses ?? new Set<string>();
		statuses.add(d.status);
		byItem.set(d.item, {
			row: {
				item: d.item,
				status: d.status,
				evidence: d.evidence,
				substrate: d.substrate,
				...(statuses.size > 1 ? { contradicted: true } : {}),
			},
			statuses,
		});
	}
	return [...byItem.values()].map((e) => e.row);
}

/** Legacy sweep: add the explicit repo stamp to every block missing one
 * (derived from sessionFile's git root — deterministic, no history rewritten).
 * Pure over the input; the tool owns backup + IO. Idempotent: stamped blocks
 * pass through untouched. */
export function sweepRepoStamps(blocks: Block[]): { blocks: Block[]; stamped: number; stripped: number } {
	let stamped = 0;
	let stripped = 0;
	const out = blocks.map((b) => {
		// DECISION blocks only: their sessionFile is the writing cwd (repoOf
		// resolves it). Index blocks carry a session JSONL path, not a cwd —
		// stamping those produced path-garbage (caught in the first live run).
		if (!isDecisionBlock(b)) {
			if (b.repo !== undefined) { stripped++; return { ...b, repo: undefined }; }
			return b;
		}
		if (b.repo) return b;
		stamped++;
		return { ...b, repo: repoOf(resolve(b.sessionFile)) };
	});
	return { blocks: out, stamped, stripped };
}

/** The live ledger of one repo = the fold of its decision blocks. Same return
 * type as the legacy file read — all consumers unchanged. */
export function loadStatusRows(repoRoot: string = process.cwd()): StatusRow[] {
	return foldDecisions(loadDecisions(repoRoot));
}

/** House fold: EVERY repo's decision blocks, unfiltered — the global ledger
 * view (`/majordome ledger house`). Latest-wins across repos, contradicted
 * flags preserved by the same fold. */
export function loadHouseRows(): StatusRow[] {
	return foldDecisions(loadBlocks().filter(isDecisionBlock));
}

// ── the md export (STATUS.md demoted to generated output) ───────────────────

/** Render the fold as the canonical export text: generated-export banner +
 * the 4-column table, rows in fold order (append order). parseStatusRows of
 * this text returns exactly `rows` — the export is a lossless view. */
export function statusExportText(rows: StatusRow[]): string {
	const table = [
		"| item | status | evidence | substrate |",
		"|---|---|---|---|",
		...rows.map((r) => `| ${r.item} | ${r.status} | ${r.evidence} | ${r.substrate} |`),
	];
	return [
		"# STATUS — generated export",
		"",
		"GENERATED EXPORT — do not edit; source: decision blocks (blocks.jsonl).",
		"Regenerate with /majordome status --export md.",
		"",
		...table,
		"",
	].join("\n");
}

/** Write STATUS.md (statusFile — MAJORDOME_STATUS_FILE names the export path)
 * from the live fold. Returns the one-line summary for the command output. */
export function exportStatusMd(repoRoot: string = process.cwd()): string {
	const rows = loadStatusRows(repoRoot);
	writeFileSync(statusFile(repoRoot), statusExportText(rows));
	return `STATUS.md exported: ${rows.length} item(s) from the decision fold — do not edit; source: decision blocks`;
}

// ── the status join (recall injection ↔ ledger rows) ─────────────────────

/** Deterministic match: ≥2 shared non-stopword tokens between the block text
 * (title/gist) and the row item. One shared token is too polysemous ("sidecar"
 * alone would glue every sidecar sentence to every sidecar row); two is the
 * smallest honest overlap. Ties broken by overlap count then row order. */
export function matchStatusRows(blockText: string, rows: StatusRow[], max = 2): StatusRow[] {
	const bt = tokens(blockText);
	if (!bt.size || !rows.length) return [];
	const scored: { row: StatusRow; inter: number }[] = [];
	for (const row of rows) {
		const it = tokens(row.item);
		let inter = 0;
		for (const t of it) if (bt.has(t)) inter++;
		if (inter >= 2) scored.push({ row, inter });
	}
	scored.sort((a, b) => b.inter - a.inter);
	return scored.slice(0, max).map((s) => s.row);
}

/** Evidence stays bounded on the injected line — the row keeps the full text,
 * the tail gets the first 100 chars. Never reworded, never invented. */
function shortEvidence(evidence: string): string {
	const e = evidence.trim();
	return e.length <= 100 ? e : e.slice(0, 100).trimEnd() + "…";
}

/** The bound lines: `related status: <item> — <status> (<evidence>)`, at most
 * `max` (default 2) per injection, [] when nothing matches (no match →
 * literally nothing — the injection stays byte-identical to pre-feature). */
export function statusJoinLines(blockText: string, rows: StatusRow[], max = 2): string[] {
	return matchStatusRows(blockText, rows, max).map(
		(r) => `related status: ${r.item} — ${r.status} (${shortEvidence(r.evidence)})`,
	);
}

/** Render the ledger as the /majordome status panel: pending items in full
 * (fold order), parked inline, built/dropped as counts. Data lives in the
 * decision blocks — this is a view, not a source. */
export function formatStatus(rows: StatusRow[]): string {
	const by = (st: string) => rows.filter((r) => r.status === st);
	const pending = by("pending");
	const parked = by("parked");
	const built = by("built");
	const dropped = by("dropped");
	return [
		"╭─ /majordome status",
		`│ pending (${pending.length})`,
		...(pending.length ? pending.map((r) => `│ · ${r.item}`) : ["│ · (none — queue clear)"]),
		`│ parked (${parked.length}): ${parked.map((r) => r.item).join(" · ") || "(none)"}`,
		`│ built ${built.length} · dropped ${dropped.length} — evidence in decision blocks`,
		"╰─",
	].join("\n");
}

export interface HouseWorkerStatus { name: string; cwd: string; rows: StatusRow[] }

/** Deterministic topic families for the ledger view. Ordered rules; the
 * fallback is core. A VIEW lens only — the store stays flat. */
const TOPIC_RULES: [RegExp, string][] = [
	[/workflow|funnel|grill|concierge/i, "workflow"],
	[/judge|jev|typellm|\bshape\b|panel|clarif|decompose/i, "judgment"],
	[/freshness|recall|substring|verbatim|leiden|attribution/i, "recall"],
	[/orch|worker|fleet|deck|isolation|swarm/i, "orchestration"],
	[/docs|naming|ledger/i, "docs"],
	[/sqlite|storage/i, "storage"],
];
export function topicOf(item: string): string {
	for (const [re, fam] of TOPIC_RULES) if (re.test(item)) return fam;
	return "core";
}

/** The boxed ledger table — the /majordome ledger view. Same fold as status,
 * presented as a status×items table: one row per status, items wrapped in the
 * cell, sized to the full terminal width (detected, or the `width` override;
 * clamped so narrow terminals never break the border). Pure formatting over
 * rows like every renderer here. */
export function formatLedgerTable(rows: StatusRow[], width?: number): string {
	const order = ["pending", "parked", "built", "dropped"];
	const groups = new Map<string, string[]>();
	for (const r of rows) {
		const g = groups.get(r.status) ?? [];
		g.push(r.item);
		groups.set(r.status, g);
	}
	if (!groups.size) return "(no ledger — /majordome init to seed one)";
	const wrap = (items: string[]): string[] => {
		// hard-wrap: items longer than the cell split across lines (a border that
		// never breaks beats pretty joining — padEnd cannot truncate)
		const lines: string[] = [];
		let cur = "";
		for (const raw of items) {
			const chunks: string[] = [];
			for (let i = 0; i < raw.length; i += cellW) chunks.push(raw.slice(i, i + cellW));
			chunks.forEach((chunk, c) => {
				const sep = cur && c === 0 ? " · " : "";
				const piece = cur + sep + chunk;
				if (piece.length > cellW && cur) { lines.push(cur); cur = chunk; }
				else cur = piece;
			});
		}
		if (cur) lines.push(cur);
		return lines;
	};
	// pending: one bullet per item, one row each (readability — the queue is
	// what you scan); every other status keeps the packed " · " flow
	const bullets = (items: string[]): string[] =>
		items.flatMap((it) => {
			const segs: string[] = [];
			for (let i = 0; i < it.length; i += cellW - 2) segs.push(it.slice(i, i + cellW - 2));
			return segs.map((seg, i) => (i === 0 ? `· ${seg}` : `  ${seg}`));
		});
	const body0 = order
		.filter((st) => groups.has(st))
		.map((st) => ({ st, label: `${st} (${groups.get(st)!.length})`, items: groups.get(st)! }));
	const labelW = Math.max(...body0.map((b) => b.label.length)) + 2;
	// full terminal width: detected TTY, COLUMNS env, or the 113-char legacy
	// default; cell = width minus label column and the 3 border glyphs.
	// OR-chain (not ??): Number(undefined) is NaN, not nullish — NaN poisons
	// repeat() into empty borders.
	const detected = width
		|| Number(process.stdout?.columns) || Number.parseInt(process.env.COLUMNS ?? "", 10) || 113;
	const cellW = Math.min(Math.max(detected - labelW - 3, 40), 240);
	// scan-list statuses (pending/parked) group into topic families (≥2 items
	// collapse to one family bullet + sub-bullets; singletons stay flat).
	// built/dropped stay packed (reference lists, not queues).
	const bulletGroup = (items: string[]): string[] => {
		const fams = items.map((it) => ({ it, fam: topicOf(it) }));
		const counts = new Map<string, number>();
		fams.forEach((f) => counts.set(f.fam, (counts.get(f.fam) ?? 0) + 1));
		const out: string[] = [];
		const emitted = new Set<string>();
		for (const { it, fam } of fams) {
			if ((counts.get(fam) ?? 0) < 2 || emitted.has(fam)) continue;
			emitted.add(fam);
			out.push(`${fam} (${counts.get(fam)}):`);
			for (const x of fams.filter((f) => f.fam === fam)) {
				const segs: string[] = [];
				for (let i = 0; i < x.it.length; i += cellW - 5) segs.push(x.it.slice(i, i + cellW - 5));
				out.push(...segs.map((seg, j) => (j === 0 ? `  · ${seg}` : `    ${seg}`)));
			}
		}
		for (const { it, fam } of fams) {
			if ((counts.get(fam) ?? 0) >= 2) continue;
			const segs: string[] = [];
			for (let i = 0; i < it.length; i += cellW - 2) segs.push(it.slice(i, i + cellW - 2));
			out.push(...segs.map((seg, j) => (j === 0 ? `· ${seg}` : `  ${seg}`)));
		}
		return out;
	};
	const body = body0.map((b) => ({ label: b.label, lines: b.st === "pending" || b.st === "parked" ? bulletGroup(b.items) : wrap(b.items) }));
	const top = `┌${"─".repeat(labelW)}┬${"─".repeat(cellW)}┐`;
	const mid = `├${"─".repeat(labelW)}┼${"─".repeat(cellW)}┤`;
	const bot = `└${"─".repeat(labelW)}┴${"─".repeat(cellW)}┘`;
	const out = ["╭─ /majordome ledger", top, `│${"status".padEnd(labelW)}│${"items".padEnd(cellW)}│`, mid];
	body.forEach((b, i) => {
		if (i) out.push(mid);
		b.lines.forEach((line, j) => {
			out.push(`│${(j === 0 ? b.label : "").padEnd(labelW)}│${line.padEnd(cellW)}│`);
		});
	});
	out.push(bot, "╰─");
	return out.join("\n");
}

/** House view: this repo's ledger summary + every registered worker's line
 * (rows count by status, or an honest "no ledger" for repos with no decision
 * blocks of their own). */
export function formatHouseStatus(local: StatusRow[], workers: HouseWorkerStatus[]): string {
	const cnt = (rows: StatusRow[], st: string) => rows.filter((r) => r.status === st).length;
	const lines = [
		"\u256d\u2500 /majordome status (house)",
		`\u2502 this repo: ${local.length} rows \u2014 pending ${cnt(local, "pending")} \u00b7 parked ${cnt(local, "parked")} \u00b7 built ${cnt(local, "built")} \u00b7 dropped ${cnt(local, "dropped")}`,
	];
	for (const w of workers) {
		if (!w.rows.length) lines.push(`\u2502 @${w.name} \u2014 no ledger (not init\u0027d): ${w.cwd}`);
		else lines.push(`\u2502 @${w.name} \u2014 ${w.rows.length} rows: pending ${cnt(w.rows, "pending")} \u00b7 parked ${cnt(w.rows, "parked")} \u00b7 built ${cnt(w.rows, "built")} \u00b7 dropped ${cnt(w.rows, "dropped")}`);
	}
	lines.push("\u2502 detail: /majordome status <@slug> \u2014 full ledger of one worker", "\u2570\u2500");
	return lines.join("\n");
}
