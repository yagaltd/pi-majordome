/**
 * AGENTS.md adoption (advisory) — repo-conventions gap report at init + doctor.
 *
 * Detects AGENTS.md in the repo cwd and reports ONE compact line:
 *   present → "AGENTS.md: present · <gap list>" (gaps: no Lessons section, no
 *             testing rules, and — greenfield only — no no-compat rule;
 *             zero gaps → "present · ok")
 *   absent  → "AGENTS.md: absent — recommend one (draft via /majordome docs)"
 *
 * ADVISORY ONLY: nothing here ever writes AGENTS.md (same contract as the
 * docs digest — the agent writes docs, majordome reports gaps).
 *
 * Greenfield test: no .git history AND no code manifests (the docsprofile
 * detection list — one shared predicate, two consumers). Greenfield repos
 * have no installed base to stay compatible with, so a no-compat rule is the
 * one convention they should declare up front; brownfield repos are never
 * flagged for it.
 *
 * AGENTS.md is already indexed as a doc kind: brownfieldDocDates seeds an
 * "AGENTS" cursor (docsprofile.ts) and a custom watch name "AGENTS" matches
 * AGENTS.md at a path boundary (watchRegexFor; docsbench asserts it). This
 * module only reads it for convention gaps — no new store/write paths.
 *
 * Leaf module: fs/path only (plus docsprofile) — init/doctor import it
 * without cycles. Fail-open: an unreadable AGENTS.md reads as empty content
 * (gaps reported); detection never throws into the caller.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasCodeManifest } from "./docsprofile.ts";

export interface AgentsReport {
	present: boolean;
	ok: boolean; // present AND zero gaps
	greenfield: boolean;
	gaps: string[];
	line: string; // the ONE compact init/doctor line
}

/** Greenfield = no .git history (dir or worktree .git file) AND no code
 * manifests — the same marker list detectDocsProfile uses for coding vs
 * generic. Unreadable cwd → not greenfield (fail closed: fewer false gaps). */
export function greenfieldRepo(cwd: string): boolean {
	if (existsSync(join(cwd, ".git"))) return false;
	try {
		return !hasCodeManifest(cwd);
	} catch {
		return false;
	}
}

/** Convention gaps in AGENTS.md content. Heuristic headings/bullets — this is
 * an advisory nudge, not a linter. A "Lessons" section records mistakes-as-
 * guidance (the same class Block.lesson indexes); a testing section records
 * how to verify; a no-compat rule frees greenfield work from shims. */
export function agentsGaps(content: string, greenfield: boolean): string[] {
	const gaps: string[] = [];
	if (!/(^|\n)#{1,6}[^\n]*lessons/i.test(content)) gaps.push("no Lessons section");
	if (!/(^|\n)#{1,6}[^\n]*\btest/i.test(content) && !/(^|\n)[ \t]*[-*][^\n]*\btest/i.test(content)) gaps.push("no testing rules");
	if (greenfield && !/no[\s-]*compat|without[ \t]+(?:backward[ \t]+)?compat|no[ \t]+backward/i.test(content)) {
		gaps.push("no-compat rule missing (greenfield)");
	}
	return gaps;
}

/** The full report for a repo cwd. Absent file → the recommend line. */
export function agentsReport(cwd: string): AgentsReport {
	const f = join(cwd, "AGENTS.md");
	if (!existsSync(f)) {
		return { present: false, ok: false, greenfield: greenfieldRepo(cwd), gaps: [], line: "AGENTS.md: absent — recommend one (draft via /majordome docs)" };
	}
	let content = "";
	try {
		content = readFileSync(f, "utf8");
	} catch {
		/* unreadable → empty content → gaps reported (never throw) */
	}
	const greenfield = greenfieldRepo(cwd);
	const gaps = agentsGaps(content, greenfield);
	return {
		present: true,
		ok: gaps.length === 0,
		greenfield,
		gaps,
		line: gaps.length ? `AGENTS.md: present · ${gaps.join(" · ")}` : "AGENTS.md: present · ok",
	};
}
