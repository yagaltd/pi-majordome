/**
 * entity registry (v1) — deterministic per-turn entity extraction, zero judge.
 *
 * URLs (http/https), github.com/owner/repo refs (bare or inside URLs), and
 * absolute file paths (/home/…, ~/…) are pulled from turn text and appended
 * to ~/.pi/majordome/entities.jsonl — {entity, kind, turn, session, firstSeen}.
 * Exact repeats dedupe in-memory per run (a session that mentions the same
 * URL fifty times appends it once per run). Recall intersects the QUERY's
 * entities with the registry and boosts blocks whose text contains the entity
 * verbatim (router.ts blockEntityBoost) — the token-soup false-positive
 * killer: exact strings, no substring luck (the false-positive specimen that
 * queued this row matched only as substring luck).
 *
 * Fail-open everywhere: unreadable/corrupt registry → [], append failures
 * never break a turn, no trails (nothing here is a judge). SQLite note: the
 * STATUS row plans a table swap — these functions are the only seam that
 * touches the file.
 *
 * MAJORDOME_ENTITIES_FILE overrides the location (selfcheck/bench isolation,
 * same pattern as MAJORDOME_TRAIL_FILE).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { majordomeDir } from "./store.ts";

export type EntityKind = "url" | "repopath" | "filepath";

export interface EntityHit {
	entity: string;
	kind: EntityKind;
}

export interface EntityRecord extends EntityHit {
	turn: number;
	session: string;
	firstSeen: string; // ISO timestamp of the first sighting
}

export function entitiesFile(): string {
	return process.env.MAJORDOME_ENTITIES_FILE?.trim() || join(majordomeDir(), "entities.jsonl");
}

const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

const GITHUB_RE = /\bgithub\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const PATH_RE = /(?:\/home\/|~\/)[^\s"'`,;:)\]]+/g;

/** Deterministic extraction, one kind per entity (a github URL records as its
 * github.com/owner/repo ref, not as a URL too). Trailing prose punctuation is
 * stripped from every match. Pure — no IO, no judge. */
export function extractEntities(text: string): EntityHit[] {
	const out: EntityHit[] = [];
	const seen = new Set<string>();
	const push = (raw: string, kind: EntityKind): void => {
		const entity = raw.replace(TRAILING_PUNCT, "");
		if (!entity || seen.has(entity)) return;
		seen.add(entity);
		out.push({ entity, kind });
	};
	for (const m of text.matchAll(GITHUB_RE)) push(m[0], "repopath");
	for (const m of text.matchAll(URL_RE)) {
		const gh = m[0].match(GITHUB_RE);
		if (gh) push(gh[0], "repopath"); // github URL → repo ref only, no URL double-record
		else push(m[0], "url");
	}
	for (const m of text.matchAll(PATH_RE)) push(m[0], "filepath");
	return out;
}

// ── the registry ─────────────────────────────────────────────────────────────

const runSeen = new Set<string>();

/** Test/run isolation: forget the in-run dedupe memo. */
export function resetEntityMemo(): void {
	runSeen.clear();
}

/** Append fresh entities to the registry. Exact repeats within this run are
 * skipped (the memo), so the same entity lands once per run — firstSeen stays
 * the first sighting. Returns the appended count; failures return 0 and never
 * throw (the registry never breaks a turn). */
export function appendEntities(hits: EntityHit[], session: string, turn: number): number {
	const fresh = hits.filter((h) => h.entity && !runSeen.has(h.entity));
	if (!fresh.length) return 0;
	try {
		mkdirSync(dirname(entitiesFile()), { recursive: true });
		const now = new Date().toISOString();
		appendFileSync(
			entitiesFile(),
			fresh.map((h) => JSON.stringify({ entity: h.entity, kind: h.kind, turn, session, firstSeen: now })).join("\n") + "\n",
		);
		for (const h of fresh) runSeen.add(h.entity);
		return fresh.length;
	} catch {
		return 0; // registry never breaks a turn
	}
}

/** Read registry records, newest-last. Lenient: corrupt lines skipped,
 * absent file → []. Optional filter by kind and/or session slug. */
export function readEntities(filter?: { kind?: EntityKind; session?: string }): EntityRecord[] {
	if (!existsSync(entitiesFile())) return [];
	let raw: string;
	try {
		raw = readFileSync(entitiesFile(), "utf8");
	} catch {
		return [];
	}
	const out: EntityRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line) as EntityRecord;
			if (typeof r?.entity !== "string" || !r.entity) continue;
			if (filter?.kind && r.kind !== filter.kind) continue;
			if (filter?.session && r.session !== filter.session) continue;
			out.push(r);
		} catch {
			// corrupt line (append-only file: never fatal)
		}
	}
	return out;
}

/** Query-side recall hook: entities in `text` that the registry has already
 * seen (registry-gated — a never-seen string earns no boost). Deterministic;
 * the registry is only read when the text contains extractable entities. */
export function knownEntitiesIn(text: string): string[] {
	const hits = extractEntities(text);
	if (!hits.length) return [];
	const seen = new Set(readEntities().map((r) => r.entity));
	return [...new Set(hits.map((h) => h.entity))].filter((e) => seen.has(e));
}

/** The doctor/housekeep advisory line: distinct entity count + kind split.
 * Advisory only — an empty registry is a fine state, never a warning. */
export function entitiesAdvisoryLine(): string {
	const recs = readEntities();
	if (!recs.length) return "· entity registry: empty (optional — URLs/repo refs/paths land here as sessions mention them)";
	const distinct = new Map<string, EntityKind>();
	for (const r of recs) if (!distinct.has(r.entity)) distinct.set(r.entity, r.kind);
	const by = { url: 0, repopath: 0, filepath: 0 } as Record<EntityKind, number>;
	for (const k of distinct.values()) by[k]++;
	return `· entity registry: ${distinct.size} entities (url ${by.url} · repopath ${by.repopath} · filepath ${by.filepath}) — ${entitiesFile()}`;
}
