/**
 * status.json — the repo's deliverable ledger, loaded once and shared.
 *
 * File shape (repo root): { updated: "YYYY-MM-DD", rows: [{ item, status,
 * evidence, substrate }] }, statuses limited to built/parked/dropped/pending;
 * built rows cite a 7-hex commit. STATUS.md is no longer the source — it is a
 * generated view (/majordome status --export md, the only md door). The md
 * parser/serializer stay here for that door and for unmigrated worker repos
 * whose ledger is still a STATUS.md table (loadStatusRows falls back to it).
 *
 * The parser used to live inline in ext/selfcheck.ts (14 ledger checks parsed
 * rows ad hoc) — extracted so the recall injection path (status join) and the
 * housekeeping checks read the SAME rows selfcheck grades.
 *
 * The status join is deterministic token overlap only: block title/gist tokens
 * vs row-item tokens (core.ts tokenizer — stopwords stripped). No model call,
 * nothing invented — a line is emitted only when a row actually matches, and
 * never more than two per injection.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokens } from "./core.ts";

export const STATUS_STATUSES: readonly string[] = ["built", "parked", "dropped", "pending"];

export interface StatusRow {
	item: string;
	status: string;
	evidence: string;
	substrate: string;
}

export interface StatusLedger {
	updated: string;
	rows: StatusRow[];
}

/** Parse a legacy STATUS.md table: skip the header and the `|---|` separator,
 * keep exactly-4-column rows, trim cells, drop empties. Kept for the --export
 * md door's roundtrip and for worker repos not yet migrated to status.json.
 * Lenient by design — a malformed row is skipped, never fatal. */
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

/** Serialize rows back to the legacy STATUS.md table (the --export md door). */
export function exportStatusMd(rows: StatusRow[]): string {
	return [
		"# STATUS — deliverable ledger",
		"",
		"Every discussed deliverable gets exactly one row. built rows cite a commit.",
		"Update on land or drop — never leave a row stale past the session that changed it.",
		"",
		"| item | status | evidence | substrate |",
		"|---|---|---|---|",
		...rows.map((r) => `| ${r.item} | ${r.status} | ${r.evidence} | ${r.substrate} |`),
		"",
	].join("\n");
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

/** Normalize JSON rows: known statuses lowercased (a hand-edited "Built" is
 * the JSON-era equivalent of the old spacing drift). */
export function normalizeStatusRows(rows: StatusRow[]): { rows: StatusRow[]; changed: boolean } {
	let changed = false;
	const next = rows.map((r) => {
		const status = STATUS_STATUSES.includes(r.status.toLowerCase()) ? r.status.toLowerCase() : r.status;
		if (status !== r.status) changed = true;
		return { ...r, status };
	});
	return { rows: next, changed };
}

/** Ledger path: the repo root's status.json, `MAJORDOME_STATUS_FILE` overrides
 * for hermetic runs (same pattern as MAJORDOME_FP_FILE / MAJORDOME_TRAIL_FILE). */
export function statusFile(repoRoot: string = process.cwd()): string {
	return process.env.MAJORDOME_STATUS_FILE?.trim() || join(repoRoot, "status.json");
}

/** Lenient row reader: objects with item+status strings survive; evidence/
 * substrate coerce to strings; everything else is skipped. */
function rowsOf(raw: unknown): StatusRow[] {
	if (!Array.isArray(raw)) return [];
	const out: StatusRow[] = [];
	for (const r of raw) {
		const o = (r ?? {}) as Record<string, unknown>;
		if (typeof o.item !== "string" || !o.item || typeof o.status !== "string" || !o.status) continue;
		out.push({ item: o.item, status: o.status, evidence: typeof o.evidence === "string" ? o.evidence : "", substrate: typeof o.substrate === "string" ? o.substrate : "" });
	}
	return out;
}

/** Load rows from disk: status.json first (the ledger); an unmigrated repo
 * with only a legacy STATUS.md still reads (md fallback), so cross-repo
 * status views keep working before each worker migrates. Absent/unreadable →
 * [] (no ledger, no join lines — the feature is inert outside repos that
 * keep one). */
export function loadStatusRows(repoRoot: string = process.cwd()): StatusRow[] {
	const p = statusFile(repoRoot);
	try {
		if (existsSync(p)) return rowsOf(JSON.parse(readFileSync(p, "utf8"))?.rows);
	} catch {
		return []; // corrupt ledger → inert (fail-open like every reader here)
	}
	try {
		const legacy = join(repoRoot, "STATUS.md");
		if (existsSync(legacy)) return parseStatusRows(readFileSync(legacy, "utf8"));
	} catch { /* unreadable → no rows */ }
	return [];
}

// ── the status join (recall injection ↔ status.json rows) ────────────────────

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
 * (ledger order), parked inline, built/dropped as counts. Data stays in
 * status.json — this is a view, not a source. */
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
		`│ built ${built.length} · dropped ${dropped.length} — evidence in status.json`,
		"╰─",
	].join("\n");
}

export interface HouseWorkerStatus { name: string; cwd: string; rows: StatusRow[] }

/** House view: this repo's ledger summary + every registered worker's line
 * (rows count by status, or an honest "no ledger" for cold repos). */
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
