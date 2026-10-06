/**
 * STATUS.md — the repo's deliverable ledger, parsed once and shared.
 *
 * Row shape (see STATUS.md header): `| item | status | evidence | substrate |`,
 * statuses limited to built/parked/dropped/pending; built rows cite a 7-hex
 * commit. The parser used to live inline in ext/selfcheck.ts (14 ledger checks
 * parsed rows ad hoc) — extracted here so the recall injection path (status
 * join) and the housekeeping checks read the SAME rows selfcheck grades.
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

/** Parse STATUS.md table rows: skip the header and the `|---|` separator,
 * keep exactly-4-column rows, trim cells, drop empties. Lenient by design —
 * a malformed row is skipped, never fatal (fail-open like every reader here). */
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

/** STATUS.md path: the repo root's ledger, `MAJORDOME_STATUS_FILE` overrides
 * for hermetic runs (same pattern as MAJORDOME_FP_FILE / MAJORDOME_TRAIL_FILE). */
export function statusFile(repoRoot: string = process.cwd()): string {
	return process.env.MAJORDOME_STATUS_FILE?.trim() || join(repoRoot, "STATUS.md");
}

/** Load rows from disk. Absent/unreadable ledger → [] (no ledger, no join
 * lines — the feature is inert outside repos that keep one). */
export function loadStatusRows(repoRoot: string = process.cwd()): StatusRow[] {
	const p = statusFile(repoRoot);
	if (!existsSync(p)) return [];
	try {
		return parseStatusRows(readFileSync(p, "utf8"));
	} catch {
		return [];
	}
}

// ── the status join (recall injection ↔ STATUS.md rows) ─────────────────────

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
 * STATUS.md — this is a view, not a source. */
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
		`│ built ${built.length} · dropped ${dropped.length} — evidence in STATUS.md`,
		"╰─",
	].join("\n");
}
