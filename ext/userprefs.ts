/**
 * user.json — the captain's structured preference file (the personal tier's
 * data half; user.md stays the prose half). Lives at ~/.pi/majordome/user.json
 * (MAJORDOME_USER_FILE overrides — hermetic benches point it at a fixture).
 *
 * Schema (lenient everywhere: missing/junk fields read as the defaults):
 *   {
 *     updated: "2026-10-07",
 *     answer_shape: "auto",            // or an OUTPUT_SHAPES value — standing
 *                                      // output preference for the shape judge
 *     preferences: [{ key, value, added, source }],  // captain-addable pairs
 *     query_style: { avg_topics_per_query, samples, imperative_ratio }, // 0 until measured
 *     confidence_calibration: []       // future decompose-confidence calibration
 *   }
 *
 * Zero-token by design: /majordome user renders this file as a view; set/reset
 * are the only writes. The judge-facing lines live in prefLines() — consumed
 * by judges.ts userPrefLines() (user.json lines first, prose user.md after).
 *
 * Fail-open like every reader here: absent/corrupt file → fresh defaults,
 * never a throw into pi.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { majordomeDir } from "./store.ts";

export interface UserPreference {
	key: string;
	value: string;
	added: string; // ISO date the preference was first set
	source: string; // who set it ("captain" — the command is captain-addable)
}

export interface QueryStyle {
	avg_topics_per_query: number;
	samples: number;
	imperative_ratio: number;
}

export interface UserPrefs {
	updated: string;
	answer_shape: string; // "auto" = no standing preference
	preferences: UserPreference[];
	query_style: QueryStyle;
	confidence_calibration: unknown[];
}

/** user.json path: the majordome dir's user.json, MAJORDOME_USER_FILE overrides. */
export function userFile(): string {
	return process.env.MAJORDOME_USER_FILE?.trim() || join(majordomeDir(), "user.json");
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Fresh ledger state — also the reset target. */
export function defaultUserPrefs(now: string = today()): UserPrefs {
	return {
		updated: now,
		answer_shape: "auto",
		preferences: [],
		query_style: { avg_topics_per_query: 0, samples: 0, imperative_ratio: 0 },
		confidence_calibration: [],
	};
}

/** Lenient normalization: junk/absent fields fall back to defaults per field,
 * so a hand-edited file can never crash a read. */
export function normalizeUserPrefs(raw: unknown, now: string = today()): UserPrefs {
	const r = (raw ?? {}) as Record<string, unknown>;
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const q = (r.query_style ?? {}) as Record<string, unknown>;
	const prefs: UserPreference[] = Array.isArray(r.preferences)
		? r.preferences
			.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
			.map((p) => ({
				key: String(p.key ?? ""),
				value: String(p.value ?? ""),
				added: String(p.added ?? now),
				source: String(p.source ?? "captain"),
			}))
			.filter((p) => p.key)
		: [];
	return {
		updated: typeof r.updated === "string" ? r.updated : now,
		answer_shape: typeof r.answer_shape === "string" ? r.answer_shape : "auto",
		preferences: prefs,
		query_style: { avg_topics_per_query: num(q.avg_topics_per_query), samples: num(q.samples), imperative_ratio: num(q.imperative_ratio) },
		confidence_calibration: Array.isArray(r.confidence_calibration) ? r.confidence_calibration : [],
	};
}

/** Load (absent/corrupt → defaults — never fatal). */
export function loadUserPrefs(): UserPrefs {
	try {
		return normalizeUserPrefs(JSON.parse(readFileSync(userFile(), "utf8")));
	} catch {
		return defaultUserPrefs();
	}
}

/** Persist (the only writer — /majordome user set|reset). */
export function saveUserPrefs(p: UserPrefs): void {
	mkdirSync(majordomeDir(), { recursive: true });
	writeFileSync(userFile(), JSON.stringify(p, null, 1) + "\n");
}

const IMPERATIVES = new Set(["build", "fix", "add", "run", "make", "write", "show", "list", "check", "update", "remove", "delete", "create", "ship", "refactor", "generate", "inspect", "test", "deploy", "extend", "migrate", "revert", "set", "reset", "load", "read", "open"]);
const STOP = new Set(["the", "and", "was", "for", "with", "that", "this", "what", "why", "how", "are", "can", "should", "does", "not", "you", "our", "its"]);

export interface QuerySample { topics: number; imperative: boolean }

/** Deterministic query-style metrics (the "tokei" idea): distinctive-token
 * count + imperative-shape detection. Zero judge calls — pure string work. */
export function computeQueryMetrics(query: string): QuerySample {
	const q = query.trim();
	const toks = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
	const first = toks[0] ?? "";
	const imperative = !q.includes("?") && IMPERATIVES.has(first);
	return { topics: toks.length, imperative };
}

/** Rolling-average update: the profile learns HOW the captain asks. */
export function updateQueryStyle(p: UserPrefs, sample: QuerySample): UserPrefs {
	const samples = p.query_style.samples + 1;
	const avg = ((p.query_style.avg_topics_per_query * p.query_style.samples) + sample.topics) / samples;
	const imp = ((p.query_style.imperative_ratio * p.query_style.samples) + (sample.imperative ? 1 : 0)) / samples;
	return { ...p, updated: today(), query_style: { avg_topics_per_query: Math.round(avg * 100) / 100, samples, imperative_ratio: Math.round(imp * 100) / 100 } };
}

/** The judge-consumption line: quiet until 5 samples (cold-start honest). */
export function styleLine(p: UserPrefs): string | null {
	if (p.query_style.samples < 5) return null;
	const pct = Math.round(p.query_style.imperative_ratio * 100);
	return `user query style (${p.query_style.samples} samples): avg ${p.query_style.avg_topics_per_query} topics/query · ${pct}% imperative — prefer terse, direct answers with minimal preamble`;
}

/** Upsert one captain setting and stamp updated. `answer_shape` is the
 * structured field (the shape judge reads it as a standing preference, not a
 * pair); everything else lands in preferences. Re-set keeps the original
 * added date. Returns the saved prefs. */
export function setUserPref(key: string, value: string): UserPrefs {
	const p = loadUserPrefs();
	const now = today();
	if (key === "answer_shape") {
		p.answer_shape = value;
	} else {
		const existing = p.preferences.find((x) => x.key === key);
		if (existing) {
			existing.value = value;
			existing.source = "captain";
		} else {
			p.preferences.push({ key, value, added: now, source: "captain" });
		}
	}
	p.updated = now;
	saveUserPrefs(p);
	return p;
}

/** Back to fresh defaults (file stays, content reset). */
export function resetUserPrefs(): UserPrefs {
	const p = defaultUserPrefs();
	saveUserPrefs(p);
	return p;
}

/** Judge-facing lines: the standing answer_shape first (when not auto), then
 * the preference pairs. Prose user.md lines are appended by the caller
 * (judges.ts) — this module stays file-single. */
export function prefLines(p: UserPrefs): string[] {
	const out: string[] = [];
	if (p.answer_shape && p.answer_shape !== "auto") out.push(`user's standing output preference: answer_shape=${p.answer_shape}`);
	for (const pr of p.preferences) out.push(`${pr.key}=${pr.value}`);
	const style = styleLine(p);
	if (style) out.push(style);
	return out;
}

/** The /majordome user render — a view of the file, nothing computed. */
export function renderUserPrefs(p: UserPrefs): string {
	const lines = [
		"╭─ /majordome user",
		`│ updated ${p.updated} · answer_shape ${p.answer_shape}`,
		`│ preferences (${p.preferences.length})`,
		...(p.preferences.length
			? p.preferences.map((pr) => `│ · ${pr.key}=${pr.value} (added ${pr.added}, ${pr.source})`)
			: ["│ · (none — /majordome user set <key> <value>)"]),
		`│ query_style: ${p.query_style.avg_topics_per_query} topics/query · ${p.query_style.samples} samples · imperative ${p.query_style.imperative_ratio}`,
		`│ confidence_calibration: ${p.confidence_calibration.length} entr${p.confidence_calibration.length === 1 ? "y" : "ies"}`,
		"│ set: /majordome user set <key> <value> · reset: /majordome user reset",
		"╰─",
	];
	return lines.join("\n");
}
