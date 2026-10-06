/**
 * recall-feedback telemetry — the self-improving loop's measurement half.
 *
 * PRECISION PROXY: an injection is working when the session actually picks it
 * up. A ✓ decision (injected: true, log.jsonl) counts REFERENCED when, within
 * the following 3 session turns, the session text shows either
 *   - the winner's shortId (slug:N — the agent citing the recall), or
 *   - a ≥6-word contiguous phrase of the winner's gist (the work continuing).
 * Zero new judge calls, zero new write paths: the proxy reads the SAME
 * decision log the dash already shows and the SAME session JSONLs the indexer
 * parses (parseSession — user+assistant text per turn). The injected tail
 * itself ("[majordome recall · …]") is stripped before matching so a
 * re-injection of the same block never counts as the user referencing it.
 *
 * FALSE-POSITIVE SPECIMENS: bench/false_positives.json (this repo's bench dir,
 * MAJORDOME_FP_FILE overrides for hermetic runs) seeds a hand-curated corpus
 * of known-wrong injections, bucketed wrong-repo / stale / polysemy /
 * weak-match. Stats reads it for counts — specimens are mined by hand from
 * real sessions, never auto-judged.
 *
 * Pure functions + tiny lenient readers; fail-open everywhere (missing files
 * → zeros, corrupt lines skipped). Formatting is selfcheck-smoked.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RoutingDecision } from "./store.ts";

/** Minimal shapes so benches/selfcheck can pass plain fixtures. */
export interface ProxyTurn {
	user: string;
	text: string;
}
export interface ProxyBlock {
	id: string;
	session: string;
	gist: string | null;
}

// ── the proxy ────────────────────────────────────────────────────────────────

/** Cut the injected tail off turn text: everything from the recall marker on
 * (the tail is request-local but lands in the session JSONL with the turn). */
export function stripInjectedTail(text: string): string {
	const i = text.indexOf("[majordome recall");
	return i >= 0 ? text.slice(0, i) : text;
}

function norm(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** All ≥6-word contiguous windows of the gist (whole gist when shorter) —
 * normalized so punctuation/line breaks don't hide a match. */
export function gistWindows(gist: string, k = 6): string[] {
	const w = norm(gist).split(" ").filter(Boolean);
	if (!w.length) return [];
	if (w.length <= k) return [w.join(" ")];
	const out: string[] = [];
	for (let i = 0; i + k <= w.length; i++) out.push(w.slice(i, i + k).join(" "));
	return out;
}

/** REFERENCED test: scan turns (1-based) fromTurn+1 … fromTurn+within for the
 * shortId or a ≥6-word gist phrase. Strips injected tails first. */
export function referencedIn(turns: ProxyTurn[], fromTurn: number, shortId: string, gist: string | null, within = 3): boolean {
	for (let n = fromTurn + 1; n <= fromTurn + within && n <= turns.length; n++) {
		const text = norm(stripInjectedTail(turns[n - 1]?.text ?? ""));
		if (!text) continue;
		const sid = norm(shortId);
		if (sid && text.includes(sid)) return true;
		if (gist) for (const w of gistWindows(gist)) if (text.includes(w)) return true;
	}
	return false;
}

/** Locate the injected turn in a parsed session: exact user-text match first,
 * then a whitespace-normalized contains fallback (log queries are the trimmed
 * user text at injection time). 0 = not found → the decision is unmeasurable. */
export function locateTurn(turns: ProxyTurn[], query: string): number {
	for (let i = 0; i < turns.length; i++) if (turns[i].user === query) return i + 1;
	const q = query.toLowerCase().replace(/\s+/g, " ").trim();
	if (q.length >= 10) {
		for (let i = 0; i < turns.length; i++) if (turns[i].user.toLowerCase().replace(/\s+/g, " ").includes(q)) return i + 1;
	}
	return 0;
}

function gistFor(winner: string, blocks: ProxyBlock[]): string | null {
	const exact = blocks.find((b) => b.id === winner);
	if (exact) return exact.gist ?? null;
	const m = winner.match(/^(.+):(\d+)$/);
	if (!m) return null;
	const tag = m[1].toLowerCase();
	const hit = blocks.find((b) => {
		const mm = b.id.match(/^(.+):(\d+)$/);
		return mm && mm[2] === m[2] && (b.session.replace(/^lineage:/, "").toLowerCase() === tag || b.id.toLowerCase().endsWith(`:${winner.toLowerCase()}`));
	});
	return hit?.gist ?? null;
}

export interface ProxyResult {
	measured: number; // ✓ decisions resolvable to a session + turn (the N)
	referenced: number; // of those, picked up within 3 turns (the M)
	windowed: boolean; // any measured decision carried the turn cursor
}

/** The precision proxy over the decision log. `sessionTurns` re-parses a
 * session file (the indexer's own parseSession — wired by index.ts); decisions
 * that can't be measured (no ✓ stamp, no session file on disk, query not
 * found in the file) are excluded from the denominator, never counted as
 * unreferenced. Window: the same last-100-turns cursor the judge-cost
 * telemetry uses (turn > currentTurns - window); currentTurns 0 → lifetime. */
export function precisionProxy(
	decisions: RoutingDecision[],
	blocks: ProxyBlock[],
	sessionTurns: (file: string) => ProxyTurn[] | null,
	currentTurns: number,
	window = 100,
): ProxyResult {
	const out: ProxyResult = { measured: 0, referenced: 0, windowed: false };
	for (const d of decisions) {
		if (!d.injected || !d.winner || !d.sessionFile) continue;
		if (typeof d.turn === "number") {
			if (currentTurns > 0 && d.turn <= currentTurns - window) continue;
		} else if (currentTurns > 0) continue; // unstamped ✓ under a counted store: unmeasurable
		const turns = sessionTurns(d.sessionFile);
		if (!turns || !turns.length) continue;
		const at = locateTurn(turns, d.query);
		if (!at) continue;
		out.measured++;
		if (typeof d.turn === "number") out.windowed = true;
		if (referencedIn(turns, at, d.winner, gistFor(d.winner, blocks))) out.referenced++;
	}
	return out;
}

// ── false-positive specimens ────────────────────────────────────────────────

/** Canonical buckets, display order fixed for the stats line. */
export const FP_BUCKETS: readonly string[] = ["wrong-repo", "stale", "polysemy", "weak-match"];

export interface FpCounts {
	total: number;
	byBucket: Record<string, number>;
	corrupt: boolean; // present but unparseable/wrong shape (stats stays quiet on the file, counts stay 0)
}

/** Specimen corpus path: the repo's own bench dir (this module lives in ext/),
 * overridable for hermetic runs — same pattern as MAJORDOME_TRAIL_FILE. */
export function fpFile(): string {
	return process.env.MAJORDOME_FP_FILE?.trim() || fileURLToPath(new URL("../bench/false_positives.json", import.meta.url));
}

/** Counts by bucket. Absent file → zeros (not corrupt — the corpus is a seed,
 * empty is a fine state). Corrupt file → zeros + corrupt. Junk specimens
 * (missing/blank bucket) are skipped, never fatal. */
export function fpCounts(path: string = fpFile()): FpCounts {
	if (!existsSync(path)) return { total: 0, byBucket: {}, corrupt: false };
	let j: any;
	try {
		j = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { total: 0, byBucket: {}, corrupt: true };
	}
	if (!j || !Array.isArray(j.specimens)) return { total: 0, byBucket: {}, corrupt: true };
	const byBucket: Record<string, number> = {};
	let total = 0;
	for (const s of j.specimens) {
		const b = typeof s?.bucket === "string" ? s.bucket.trim() : "";
		if (!b) continue;
		byBucket[b] = (byBucket[b] ?? 0) + 1;
		total++;
	}
	return { total, byBucket, corrupt: false };
}

/** The stats fragment: 'false-positive specimens: K (wrong-repo a · stale b ·
 * polysemy c · weak-match d)' — canonical buckets always shown (a 0 stale is
 * information: the corpus hasn't seen one yet), unknown buckets appended. */
export function fpStatsLine(c: FpCounts): string {
	const parts = FP_BUCKETS.map((b) => `${b} ${c.byBucket[b] ?? 0}`);
	for (const [b, n] of Object.entries(c.byBucket)) if (!FP_BUCKETS.includes(b)) parts.push(`${b} ${n}`);
	return `false-positive specimens: ${c.total} (${parts.join(" · ")})`;
}

/** The full recall-feedback stats line, e.g.
 * 'recall precision (proxy): 7/12 referenced (last 100 turns) · false-positive specimens: 8 (…)'.
 * Null when nothing is measurable yet — stats stays byte-identical pre-data. */
export function proxyStatsLine(p: ProxyResult, c: FpCounts): string | null {
	if (!p.measured) return null;
	const win = p.windowed ? "last 100 turns" : "lifetime";
	return `recall precision (proxy): ${p.referenced}/${p.measured} referenced (${win}) · ${fpStatsLine(c)}`;
}
