/**
 * /majordome housekeeping — the doctor's advisory checks plus STATUS.md
 * staleness, then a two-class fix policy:
 *
 *   SAFE      — writes ONLY to README.md / docs/*.md / STATUS.md, and only
 *               (a) rewording a known drift signature (DRIFT_RULES) to
 *               roadmap tense so the doctor's doc-drift gate goes quiet, or
 *               (b) normalizing STATUS rows (spacing/status case). Applied
 *               automatically by the command.
 *   DANGEROUS — rm, any git state change, any code-file edit. Reported for
 *               explicit user yes, NEVER executed: the executor refuses any
 *               dangerous kind outright and any path outside the hard
 *               allowlist (isSafeDocPath) — defense in depth, so a bug in a
 *               rule can never turn into a destructive action.
 *
 * Pure collection (collectHousekeep) is injectable for hermetic tests; the
 * live wrapper (housekeeping) probes the real repo (doctor audit, git log,
 * store parse health) and formats the fixed/needs-yes report.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { doctor } from "./doctor.ts";
import { DRIFT_RULES, ROADMAP_RE } from "./docdrift.ts";
import { majordomeDir } from "./store.ts";
import { parseStatusRows, normalizeStatusText, type StatusRow } from "./status.ts";

// ── the two fix classes ──────────────────────────────────────────────────────

export type DangerKind = "rm" | "git" | "edit-code";
export const DANGEROUS_KINDS: readonly DangerKind[] = ["rm", "git", "edit-code"];

export type Proposal =
	| { safe: true; kind: "reword"; path: string; from: string; to: string; why: string }
	| { safe: true; kind: "normalize-status"; why: string }
	| { safe: false; kind: DangerKind; describe: string };

/** Hard path allowlist for the safe class: repo-root-relative doc paths only.
 * No absolute paths, no traversal, nothing outside README/STATUS/docs/*.md.
 * The executor checks this IN ADDITION to the kind check — a safe kind aimed
 * at a code file is refused exactly like a dangerous one. */
const SAFE_PATH_RE = /^(README\.md|STATUS\.md|docs\/[^/]+\.md)$/;

export function isSafeDocPath(p: string): boolean {
	const norm = p.replace(/\\/g, "/");
	return !norm.includes("..") && SAFE_PATH_RE.test(norm);
}

/** Hard guard, boolean form — the executor's only gate. Dangerous kinds
 * never run; safe kinds run only on allowlisted doc paths; unknown kinds are
 * dangerous by default. */
export function canExecute(p: Proposal): boolean {
	if (!p.safe) return false;
	if (p.kind === "reword") return isSafeDocPath(p.path);
	if (p.kind === "normalize-status") return isSafeDocPath("STATUS.md");
	return false;
}

/** The guard in throwing form, for callers that want a hard failure (tests,
 * future executors). The shipped executor uses canExecute + skip — a refused
 * proposal is reported, never a crash. */
export function assertExecutable(p: Proposal): void {
	if (!p.safe) throw new Error(`refused: ${p.kind} is in the dangerous class — listed for your yes, never executed`);
	if (!canExecute(p)) {
		const at = p.kind === "reword" ? p.path : "STATUS.md";
		throw new Error(`refused: "${at}" is outside the safe path allowlist (README.md, STATUS.md, docs/*.md)`);
	}
}

// ── safe-fix derivation (known drift signatures → roadmap tense) ────────────

/** Rewording rule: the matched claim span gets "planned" before it and the
 * roadmap parenthetical after it, so ROADMAP_RE matches the line and the
 * doctor's doc-drift gate downgrades the mention (the exact class the gate
 * was built for — the sidecar README lie). */
export function rewordLine(line: string, pattern: RegExp): string | null {
	const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
	const m = re.exec(line);
	if (!m) return null;
	if (ROADMAP_RE.test(line)) return null; // already roadmap-marked — nothing to fix
	const reworded = line.replace(m[0], `planned ${m[0]} (not yet built — see STATUS.md)`);
	return reworded === line ? null : reworded;
}

function rewordProposalsFor(text: string, relPath: string, hasEvidence: (noun: string) => boolean): Proposal[] {
	const out: Proposal[] = [];
	const lines = text.split("\n");
	for (const rule of DRIFT_RULES) {
		if (hasEvidence(rule.noun)) continue; // claimed AND implemented → quiet
		const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
		for (let i = 0; i < lines.length; i++) {
			re.lastIndex = 0;
			const m = re.exec(lines[i]);
			if (!m) continue;
			const context = [lines[i - 1], lines[i], lines[i + 1]].filter((x): x is string => typeof x === "string").join(" ");
			if (ROADMAP_RE.test(context)) continue; // roadmap-marked → note, never a fix
			const to = rewordLine(lines[i], rule.pattern);
			if (to) {
				out.push({ safe: true, kind: "reword", path: relPath, from: lines[i], to, why: `"${rule.noun}" claim at line ${i + 1} has no ext/ tools/ implementation — reworded to roadmap tense` });
			}
			break; // first present-tense hit per rule per file is enough
		}
	}
	return out;
}

// ── STATUS staleness ─────────────────────────────────────────────────────────

const SHA_RE = /\b[0-9a-f]{7,40}\b/g;

/** Built rows must cite commits that exist in this repo's history. A cited sha
 * with no prefix match in `git log` is stale — reported, never rewritten
 * (editing evidence is not in the safe class). */
export function staleCommitFindings(rows: StatusRow[], gitShas: string[]): string[] {
	const out: string[] = [];
	for (const r of rows) {
		if (r.status !== "built") continue;
		const shas = (r.evidence.match(SHA_RE) ?? []).filter((s) => s.length === 7 || s.length === 40);
		for (const sha of shas) {
			if (!gitShas.some((h) => h.startsWith(sha))) {
				out.push(`[gap] STATUS row "${r.item}" cites commit ${sha} — not in git log (update or correct the row)`);
			}
		}
	}
	return out;
}

/** A mechanism README/CHANGELOG still talks about with no STATUS row covering
 * it — the ledger's own rule is "every discussed deliverable gets exactly one
 * row". Reported for a yes (adding a row is ledger content, not normalization). */
export function mechanismGapFindings(readme: string, changelog: string, rows: StatusRow[]): string[] {
	const out: string[] = [];
	const haystack = rows.map((r) => `${r.item} ${r.evidence} ${r.substrate}`).join(" ").toLowerCase();
	for (const rule of DRIFT_RULES) {
		const inReadme = rule.pattern.test(readme);
		const inChangelog = rule.pattern.test(changelog);
		if (!inReadme && !inChangelog) continue;
		if (haystack.includes(rule.noun.toLowerCase())) continue;
		const where = [inReadme ? "README" : null, inChangelog ? "CHANGELOG" : null].filter(Boolean).join(" + ");
		out.push(`[gap] ${where} mentions "${rule.noun}" with no STATUS.md row — add a row or roadmap-mark the mention`);
	}
	return out;
}

// ── collection (injectable → hermetic) ───────────────────────────────────────

export interface HousekeepInput {
	cwd: string;
	/** doctor audit text (live default: doctor()); tests inject */
	doctorText?: string;
	/** ledger text (live default: STATUS.md / MAJORDOME_STATUS_FILE) */
	statusText?: string;
	readmeText?: string;
	changelogText?: string;
	/** full-hex shas from `git log --format=%H` (live default: git) */
	gitShas?: string[];
	/** `git status --porcelain` lines (live default: git; [] when clean) */
	gitDirty?: string[];
	/** optional store files that fail to parse (live default: store probe) */
	storeCorrupt?: string[];
	/** extra docs scanned for drift + safe-reworded (live default: docs/*.md) */
	extraDocs?: { path: string; text: string }[];
}

export interface HousekeepResult {
	checkLines: string[];
	proposals: Proposal[];
	needsYes: string[];
	rows: StatusRow[];
}

export function collectHousekeep(input: HousekeepInput): HousekeepResult {
	const cwd = input.cwd;
	const read = (p: string): string => {
		try {
			return existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), "utf8") : (undefined as unknown as string);
		} catch {
			return undefined as unknown as string;
		}
	};
	const statusText = input.statusText ?? read("STATUS.md") ?? "";
	const readmeText = input.readmeText ?? read("README.md") ?? "";
	const changelogText = input.changelogText ?? read("CHANGELOG.md") ?? "";
	const rows = parseStatusRows(statusText);

	const checkLines: string[] = [];
	const proposals: Proposal[] = [];
	const needsYes: string[] = [];

	// doctor audit (advisory checks incl. doc-drift) — embedded as-is
	const dt = input.doctorText ?? "";
	if (dt) for (const l of dt.split("\n")) checkLines.push(l);
	checkLines.push(`status ledger: ${rows.length} row(s) parsed`);

	// evidence allowlist per rule, against this repo's ext/ tools/ tree
	const evidenceFor = (noun: string): boolean => {
		const rule = DRIFT_RULES.find((r) => r.noun === noun);
		if (!rule) return true;
		for (const ev of rule.evidence) {
			const p = join(cwd, ev.path);
			if (!existsSync(p)) continue;
			if (!ev.symbol) return true;
			try {
				if (ev.symbol.test(readFileSync(p, "utf8"))) return true;
			} catch { /* unreadable evidence file: not evidence */ }
		}
		return false;
	};

	// drift in the SAFE-writable docs → reword proposals; drift anywhere else
	// (CHANGELOG is deliberately not safe-writable) → reported only
	proposals.push(...rewordProposalsFor(readmeText, "README.md", evidenceFor));
	for (const d of input.extraDocs ?? []) proposals.push(...rewordProposalsFor(d.text, d.path, evidenceFor));

	const st = normalizeStatusText(statusText);
	if (st.changed) proposals.push({ safe: true, kind: "normalize-status", why: `normalized ${st.rows} ledger row(s) (spacing/status case)` });

	// staleness: built rows citing commits git doesn't know + mechanisms with
	// no row — both are ledger-content decisions → needs your yes
	const gitShas = input.gitShas ?? [];
	for (const f of staleCommitFindings(rows, gitShas)) needsYes.push(f);
	for (const f of mechanismGapFindings(readmeText, changelogText, rows)) needsYes.push(f);

	// dangerous proposals: derived from findings, listed never executed
	for (const f of input.storeCorrupt ?? []) {
		proposals.push({ safe: false, kind: "rm", describe: `rm the unparseable store file ${f} (destructive — recreate with /majordome reindex instead)` });
	}
	for (const g of input.gitDirty ?? []) {
		proposals.push({ safe: false, kind: "git", describe: `worktree dirty: ${g} — any git state change (commit/restore/stash) is yours to run` });
	}

	return { checkLines, proposals, needsYes, rows };
}

// ── execution (guarded) ──────────────────────────────────────────────────────

/** Apply the SAFE class through the hard guard. Dangerous proposals and any
 * safe proposal aimed outside the allowlist are skipped — listed for explicit
 * user yes, never executed. Returns one line per applied fix. */
export function applySafeFixes(cwd: string, proposals: Proposal[]): string[] {
	const fixed: string[] = [];
	for (const p of proposals) {
		if (!canExecute(p)) continue; // the guard: dangerous / non-allowlisted → cannot run
		if (p.kind === "reword") {
			const full = join(cwd, p.path);
			if (!existsSync(full)) continue;
			const text = readFileSync(full, "utf8");
			if (!text.includes(p.from)) continue; // already fixed (or changed under us)
			writeFileSync(full, text.replace(p.from, p.to));
			fixed.push(`${p.path}: ${p.why}`);
		} else if (p.kind === "normalize-status") {
			const full = join(cwd, "STATUS.md");
			if (!existsSync(full)) continue;
			const { text, changed } = normalizeStatusText(readFileSync(full, "utf8"));
			if (!changed) continue;
			writeFileSync(full, text);
			fixed.push(`STATUS.md: ${p.why}`);
		}
	}
	return fixed;
}

// ── live probes + the command ────────────────────────────────────────────────

function probeGit(cwd: string): { shas: string[]; dirty: string[] } {
	try {
		const shas = execFileSync("git", ["log", "--format=%H"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean);
		const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).split("\n").filter((l) => l.trim());
		return { shas, dirty };
	} catch {
		return { shas: [], dirty: [] }; // not a repo / no git — checks fail open
	}
}

function probeStoreCorrupt(): string[] {
	const dir = majordomeDirSafe();
	if (!dir) return [];
	const out: string[] = [];
	for (const f of ["trails.jsonl", "init.json", "orchestrator.json"]) {
		const p = join(dir, f);
		if (!existsSync(p)) continue;
		try {
			const raw = readFileSync(p, "utf8");
			if (f === "trails.jsonl") raw.split("\n").filter(Boolean).forEach((l) => JSON.parse(l));
			else JSON.parse(raw);
		} catch {
			out.push(p);
		}
	}
	return out;
}

function majordomeDirSafe(): string | null {
	try {
		// housekeeping never writes the store — read-only use of its dir helper
		return majordomeDir();
	} catch {
		return null;
	}
}

function docsIn(cwd: string): { path: string; text: string }[] {
	try {
		const d = join(cwd, "docs");
		if (!existsSync(d)) return [];
		return readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => ({ path: `docs/${f}`, text: readFileSync(join(d, f), "utf8") }));
	} catch {
		return [];
	}
}

/** The /majordome housekeeping command: doctor checks + STATUS staleness,
 * safe fixes applied, dangerous class listed for explicit yes. */
export async function housekeeping(cwd: string = process.cwd(), opts: { apply?: boolean } = {}): Promise<string> {
	const apply = opts.apply !== false;
	let doctorText = "";
	try {
		doctorText = await doctor();
	} catch (e) {
		doctorText = `✗ doctor audit failed: ${(e as Error).message}`;
	}
	const { shas, dirty } = probeGit(cwd);
	const res = collectHousekeep({
		cwd,
		doctorText,
		gitShas: shas,
		gitDirty: dirty,
		storeCorrupt: probeStoreCorrupt(),
		extraDocs: docsIn(cwd),
	});
	const fixed = apply ? applySafeFixes(cwd, res.proposals) : [];
	const dangerous = res.proposals.filter((p): p is Extract<Proposal, { safe: false }> => !p.safe).map((p) => `[dangerous · ${p.kind}] ${p.describe}`);
	const needsYes = [...res.needsYes, ...dangerous];
	const L: string[] = ["╭─ /majordome housekeeping"];
	for (const l of res.checkLines) L.push(`│ ${l}`);
	L.push("├─ fixed (safe class — README/STATUS/docs only)");
	L.push(...(fixed.length ? fixed.map((f) => `│ · ${f}`) : ["│ · nothing to fix"]));
	L.push("├─ needs your yes (listed, never executed)");
	L.push(...(needsYes.length ? needsYes.map((f) => `│ · ${f}`) : ["│ · nothing"]));
	L.push(`╰─ housekeeping ${apply ? "" : "(dry-run) "}: ${fixed.length} fixed, ${needsYes.length} need your yes`);
	return L.join("\n");
}
