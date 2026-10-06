/**
 * per-repo docs profile + brownfield adoption (magic-docs v2.7).
 *
 * A docs profile says which docs a repo watches for the nudge pipeline:
 *   { watch: string[] }  — names are built-ins ("README", "CHANGELOG",
 *   "docs/") or custom doc names ("NOTES" → matches /notes\.md at a path
 *   boundary, case-insensitive).
 *
 * Resolution order (resolveDocsProfile):
 *   1. repo override  .majordome/docs.json  {"watch":[...]}
 *   2. stored profile (index.json docsProfile — detected at init)
 *   3. detected default: any code manifest in the repo cwd → coding
 *      (README+CHANGELOG+docs/); else generic (docs/ only)
 *
 * Init is sometimes HEADLESS (worker cold-start) — detection never prompts;
 * the init output notes the resolution and the override path instead.
 *
 * Brownfield adoption (seedDocsCursor + brownfieldDocDates): existing doc
 * files seed per-slug cursors from their REAL dates — git last-commit date
 * when the repo has .git and git answers, else the file mtime; docs/ dirs
 * take the newest *.md mtime within depth ≤2. Absent keys only, so adoption
 * is idempotent and never overwrites a cursor the agent has since advanced.
 * (Lesson recorded at init.ts's closedAt comment: ingest-time stamping was a
 * caught bug — seeded dates must be the files' own history, never "now".)
 *
 * Leaf module: fs/path only, no ext imports — router/store/init/doctor all
 * pull from here without cycles.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Built-in watch names — these keep their exact touch regexes (scanDocsTouched). */
export const BUILTIN_DOC_WATCH: readonly string[] = ["README", "CHANGELOG", "docs/"];

export interface DocsProfile {
	watch: string[]; // doc names watched by the nudge pipeline
	source: string; // "override" | "detected-coding" | "detected-generic"
}

export interface SeedFinding {
	doc: string; // cursor doc name ("README", "docs/", custom "NOTES")
	date: string; // ISO time of the file's real last touch
}

/** Code manifests that mark a repo as a coding repo (→ coding profile). */
const CODE_MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile", "composer.json", "pom.xml", "build.gradle", "mix.exs"];

export function isValidDocsProfile(p: unknown): p is DocsProfile {
	const w = (p as DocsProfile)?.watch;
	return !!p && typeof p === "object" && Array.isArray(w) && w.length > 0 && w.every((n) => typeof n === "string" && n.trim().length > 0);
}

/** Touch regex for a watch name. Built-ins keep their exact regexes (the
 * `"` alternative catches JSON-escaped session-file paths); a custom name N
 * matches N.md at a path boundary, case-insensitively. */
export function watchRegexFor(name: string): RegExp {
	if (name === "README") return /[/"\\]readme\.md/i;
	if (name === "CHANGELOG") return /[/"\\]changelog\.md/i;
	if (name === "docs/") return /[/"\\]docs\//i;
	const esc = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`[/\\\\]${esc}\\.md`, "i");
}

/** Normalize an override watch entry: built-ins canonicalized (case/shape),
 * custom names trimmed. Unknown shapes kept as trimmed names — the custom
 * matcher is case-insensitive anyway. */
function normalizeWatchName(n: string): string {
	const t = n.trim();
	if (/^readme$/i.test(t)) return "README";
	if (/^changelog$/i.test(t)) return "CHANGELOG";
	if (/^docs\/?$/i.test(t)) return "docs/";
	return t;
}

/** Read .majordome/docs.json in a repo cwd. Null = absent; "invalid" =
 * present but not a usable {"watch":[...]} (caller fails open + doctor notes
 * it); else the normalized watch list. */
export function readDocsOverride(cwd: string): { watch: string[] } | null | "invalid" {
	const f = join(cwd, ".majordome", "docs.json");
	if (!existsSync(f)) return null;
	try {
		const j = JSON.parse(readFileSync(f, "utf8"));
		const w = j?.watch;
		if (Array.isArray(w) && w.length && w.every((n: unknown) => typeof n === "string" && n.trim())) {
			const watch = [...new Set(w.map(normalizeWatchName))];
			return watch.length ? { watch } : "invalid";
		}
		return "invalid";
	} catch {
		return "invalid";
	}
}

/** Code-marker predicate over the repo cwd: any known manifest file, else a
 * *.csproj/*.cabal glob. Shared by profile detection AND the AGENTS.md
 * greenfield test (ext/agentsmd.ts) — one list, one predicate, two consumers. */
export function hasCodeManifest(cwd: string): boolean {
	let code = CODE_MANIFESTS.some((m) => existsSync(join(cwd, m)));
	if (!code) {
		try {
			code = readdirSync(cwd).some((f) => f.endsWith(".csproj") || f.endsWith(".cabal"));
		} catch {
			/* unreadable cwd → no markers */
		}
	}
	return code;
}

/** Detect the default profile from the repo cwd: any code manifest → coding
 * (README+CHANGELOG+docs/); otherwise generic (docs/ only). Never prompts. */
export function detectDocsProfile(cwd: string): DocsProfile {
	return hasCodeManifest(cwd)
		? { watch: [...BUILTIN_DOC_WATCH], source: "detected-coding" }
		: { watch: ["docs/"], source: "detected-generic" };
}

/** Resolution: override > stored > detected. Invalid overrides fail open to
 * the stored/detected default (doctor reports them). */
export function resolveDocsProfile(cwd: string, stored?: DocsProfile | null): DocsProfile {
	const ov = readDocsOverride(cwd);
	if (ov !== null && ov !== "invalid") return { watch: ov.watch, source: "override" };
	if (isValidDocsProfile(stored)) return stored;
	return detectDocsProfile(cwd);
}

// ── brownfield adoption: real file/git dates for existing doc files ─────────

function gitDate(cwd: string, rel: string): string | null {
	if (!existsSync(join(cwd, ".git"))) return null; // covers dir and worktree .git files
	try {
		const out = execFileSync("git", ["-C", cwd, "log", "-1", "--format=%cI", "--", rel], {
			timeout: 4000,
			stdio: ["ignore", "pipe", "ignore"],
		}).toString().trim();
		return /^\d{4}-\d{2}-\d{2}T/.test(out) ? out : null;
	} catch {
		return null; // no git binary / not tracked → mtime fallback
	}
}

function mtimeIso(path: string): string {
	return statSync(path).mtime.toISOString();
}

/** Newest *.md mtime within a docs dir, depth ≤2 (docs/x.md and docs/x/y.md). */
function docsDirDate(docsDir: string): string | null {
	let newest: number | null = null;
	const scan = (dir: string, depth: number): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory() && depth < 2) scan(full, depth + 1);
			else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
				const m = statSync(full).mtimeMs;
				if (newest === null || m > newest) newest = m;
			}
		}
	};
	scan(docsDir, 1);
	return newest !== null ? new Date(newest).toISOString() : null;
}

/** Real last-touch dates for brownfield doc files present in a repo cwd:
 * README.md/CHANGELOG.md/AGENTS.md/CLAUDE.md (git date when available, else
 * file mtime) and the docs/ dir (newest *.md mtime, depth ≤2). */
export function brownfieldDocDates(cwd: string): SeedFinding[] {
	const out: SeedFinding[] = [];
	for (const [file, doc] of [["README.md", "README"], ["CHANGELOG.md", "CHANGELOG"], ["AGENTS.md", "AGENTS"], ["CLAUDE.md", "CLAUDE"]] as const) {
		const full = join(cwd, file);
		if (!existsSync(full)) continue;
		out.push({ doc, date: gitDate(cwd, file) ?? mtimeIso(full) });
	}
	const docsDir = join(cwd, "docs");
	if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
		const d = docsDirDate(docsDir);
		if (d) out.push({ doc: "docs/", date: d });
	}
	return out;
}

/** Seed per-slug cursors from brownfield findings — absent keys ONLY (never
 * overwrite; re-running init changes nothing → idempotent adoption). */
export function seedDocsCursor(
	cursor: Record<string, string>,
	slug: string,
	findings: SeedFinding[],
): { next: Record<string, string>; seeded: SeedFinding[] } {
	const next = { ...cursor };
	const seeded: SeedFinding[] = [];
	for (const f of findings) {
		const k = `${slug}:${f.doc}`;
		if (next[k] !== undefined) continue;
		next[k] = f.date;
		seeded.push(f);
	}
	return { next, seeded };
}

// ── shared sources (v2.9): the cross-project doc drop-dir ─────────────────

/** A repo can expose docs for cross-project recall by dropping *.md files
 * under <cwd>/.majordome-shared/. They are THIRD-PARTY text: not written by
 * a judged session turn in this repo, so every block they produce carries
 * fromUntrusted: true (store.ts) and their recall lines read '· unverified
 * source'. Ingested by the same /majordome ingest-docs sweep as configured
 * docs-sources.json paths (ext/ingest_docs.ts), so the shared dir needs no
 * separate command — drop files, sweep, recalled marked unverified. */
export const SHARED_SOURCES_DIR = ".majordome-shared";

/** True when a path points INTO a shared-sources dir (the marker segment is
 * the path boundary `/.majordome-shared/`). */
export function isSharedSourcePath(p: string): boolean {
	return p.includes(`/${SHARED_SOURCES_DIR}/`);
}

/** The *.md files in <cwd>/.majordome-shared/ (flat, sorted for determinism).
 * Absent dir → empty list (ingest stays a no-op). */
export function listSharedSources(cwd: string): string[] {
	const dir = join(cwd, SHARED_SOURCES_DIR);
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	try {
		return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort().map((f) => join(dir, f));
	} catch {
		return []; // unreadable dir → nothing shared
	}
}

/** The one compact init adoption line, e.g.
 * "docs adopted: README ← 2026-09-30, CHANGELOG ← 2026-10-01 (cursors seeded)". */
export function adoptionLine(seeded: SeedFinding[]): string {
	return `docs adopted: ${seeded.map((f) => `${f.doc} ← ${f.date.slice(0, 10)}`).join(", ")} (cursors seeded)`;
}

/** The init profile note (headless-safe discovery/override hint). */
export function profileNoteLine(profile: DocsProfile, overrideInvalid: boolean): string {
	if (profile.source === "override") return `docs profile: override .majordome/docs.json — watching ${profile.watch.join(", ")}`;
	const detected = profile.source === "detected-coding" ? "coding (code markers)" : "generic (no code markers)";
	if (overrideInvalid) return `docs profile: ${detected} — override .majordome/docs.json INVALID (failing open — see /majordome doctor)`;
	return `docs profile: ${detected} — override: .majordome/docs.json {"watch":[...]}`;
}
