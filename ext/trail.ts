/**
 * majordome judgment trail — v1.x governance seed.
 *
 * Append-only verdict metadata at every judge decision point. Never message
 * text — verdicts, judge identity, versions only. Fail-open: a failed trail
 * write can never break a judge. Consumed by: calibration (dogfood), audit,
 * judge-cost telemetry (aggregate()), and any future dataset compile.
 *
 * Override the location with MAJORDOME_TRAIL_FILE (selfcheck isolation).
 *
 * v2.8 judge-cost telemetry: the trail is the single source of truth — cost
 * numbers are AGGREGATED here, never counted in parallel. New lines carry
 *   turn      cumulative turn cursor (setTrailTurn; the extension stamps it
 *             from the store's turn counter at turn_end) — omitted when 0
 *   estTokens transport-reported usage where the judge response exposes it
 *             (OpenAI-style usage.total_tokens) — omitted otherwise
 * Old lines (and engines without usage reporting) count calls only.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadMeta, majordomeDir } from "./store.ts";

const TRAIL_VERSION = 1;

export function trailFile(): string {
	return process.env.MAJORDOME_TRAIL_FILE?.trim() || join(majordomeDir(), "trails.jsonl");
}

/** Cumulative-turn cursor stamped onto NEW trail lines (0/absent = unknown —
 * the extension sets it from the store's turn counter at turn_end; benches
 * that never count turns simply leave it at 0 and omit the field). */
let turnCursor = 0;
export function setTrailTurn(n: number): void {
	turnCursor = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function trail(judge: string, fields: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(trailFile()), { recursive: true });
		const line = { t: new Date().toISOString(), j: judge, v: TRAIL_VERSION, ...(turnCursor ? { turn: turnCursor } : {}), ...fields };
		appendFileSync(trailFile(), JSON.stringify(line) + "\n");
	} catch {
		// fail open — never break a judge for a trail write
	}
}

// ── judge-cost telemetry (v2.8) ──────────────────────────────────────────────

/** Judge decision points — one trail line per judge-function invocation
 * (internal retries are the transport's business, same granularity generate()
 * already hides). consolidate / docsNudge / selfcheck lines are DECISION
 * records (assignments, nudge gates, fixtures), not judge calls — they cost
 * nothing and are excluded from cost totals by design. */
export const JUDGE_LINES: readonly string[] = [
	"blockMeta", "induceDims", "rewriteQuery", "keyPhrases", "routingIntent",
	"contradicts", "docsVerdict", "shapeVerdict", "lifecycleVerdict", "dimVector", "simplifyVerdict",
];

/** Compact display tags for the stats line (routingIntent → intent, …). */
export const JUDGE_TAGS: Record<string, string> = {
	routingIntent: "intent",
	shapeVerdict: "shape",
	docsVerdict: "docs",
	lifecycleVerdict: "pair",
	blockMeta: "gist",
	induceDims: "dims",
	rewriteQuery: "rewrite",
	keyPhrases: "keys",
	contradicts: "contra",
	dimVector: "dimvec",
	simplifyVerdict: "simpl",
};

export interface JudgeCalls {
	calls: number;
	ok: number; // verdict recorded and parseable (ok !== false on the line)
	failOpen: number; // ok:false — transport/malformed verdict, caller fell back
	estTokens: number; // summed usage where lines carry estTokens
}

export interface TrailAggregate {
	byJudge: Record<string, JudgeCalls>; // judge line name → counts
	total: number; // judge calls (JUDGE_LINES only)
	today: number; // judge calls with today's UTC date on the line
	estTokens: number; // total estTokens where reported (new lines only)
	turns: number; // cumulative turns from the store meta (0 = never counted)
	tagged: number; // judge lines carrying a turn cursor (new-schema lines)
	callsLast100: number; // judge calls within the last 100 turns (tagged lines only)
	avgPerTurn: number; // last-100 window when tagged lines exist, else lifetime
	lines: number; // trail lines scanned (incl. decision records)
}

/** Aggregate the trail (full scan — a small JSONL) into per-judge cost counts.
 * `sinceTurn` optionally windows the scan at a turn cursor (only lines with
 * turn ≥ sinceTurn count; untagged lines are skipped). Corrupt lines and
 * decision records never break the scan. */
export function aggregate(sinceTurn = 0): TrailAggregate {
	const out: TrailAggregate = { byJudge: {}, total: 0, today: 0, estTokens: 0, turns: 0, tagged: 0, callsLast100: 0, avgPerTurn: 0, lines: 0 };
	try {
		out.turns = Math.floor(loadMeta().turns ?? 0) || 0;
	} catch {
		/* meta unreadable → turn windowing degrades to lifetime */
	}
	const today = new Date().toISOString().slice(0, 10);
	let f: string;
	try {
		f = readFileSync(trailFile(), "utf8");
	} catch {
		return out; // no trail yet — zero everything
	}
	for (const line of f.split("\n")) {
		if (!line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue; // corrupt line (append-only file: never fatal)
		}
		out.lines++;
		if (typeof e?.j !== "string" || !JUDGE_LINES.includes(e.j)) continue;
		if (sinceTurn > 0 && (typeof e.turn !== "number" || e.turn < sinceTurn)) continue;
		const s = (out.byJudge[e.j] ??= { calls: 0, ok: 0, failOpen: 0, estTokens: 0 });
		s.calls++;
		if (e.ok === false) s.failOpen++;
		else s.ok++;
		if (typeof e.estTokens === "number" && Number.isFinite(e.estTokens) && e.estTokens > 0) {
			const tk = Math.round(e.estTokens);
			s.estTokens += tk;
			out.estTokens += tk;
		}
		out.total++;
		if (typeof e.t === "string" && e.t.slice(0, 10) === today) out.today++;
		if (typeof e.turn === "number") {
			out.tagged++;
			if (out.turns > 0 && e.turn > out.turns - 100) out.callsLast100++;
		}
	}
	const avg = out.tagged && out.turns > 0 ? out.callsLast100 / Math.min(100, out.turns) : out.turns > 0 ? out.total / out.turns : 0;
	out.avgPerTurn = Math.round(avg * 100) / 100;
	return out;
}

const fmtInt = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The compact /majordome stats judge-cost section. Pure formatting over
 * aggregate() — selfcheck-smoked, no IO. Empty when the trail has no judge
 * calls at all. */
export function judgeStatsLines(ag: TrailAggregate): string[] {
	if (!ag.total) return [];
	const entries = Object.entries(ag.byJudge).sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]));
	const ok = entries.reduce((n, [, s]) => n + s.ok, 0);
	const okPct = Math.round((ok / ag.total) * 100);
	const window = ag.tagged && ag.turns > 0 ? " (last 100 turns)" : ag.turns > 0 ? " (lifetime)" : "";
	const tok = ag.estTokens ? ` · ~${fmtInt(ag.estTokens)} tok reported` : "";
	return [
		`judge calls: ${fmtInt(ag.total)} total · ${ag.today} today${ag.avgPerTurn ? ` · avg ${ag.avgPerTurn}/turn${window}` : ""}${tok}`,
		`by judge: ${entries.map(([j, s]) => `${JUDGE_TAGS[j] ?? j} ${s.calls}`).join(" · ")} (ok ${okPct}% · fail-open ${100 - okPct}%)`,
	];
}
