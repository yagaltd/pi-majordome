/**
 * AGENTS.md adoption (advisory) — repo-conventions gap report + scaffold/
 * augment proposals at init + doctor.
 *
 * Detects AGENTS.md in the repo cwd and reports ONE compact line:
 *   present → "AGENTS.md: present · <gap list>" (gaps: no Lessons section, no
 *             testing rules, no parked-dependencies rule, and — greenfield
 *             only — no no-compat rule; zero gaps → "present · ok")
 *   absent  → "AGENTS.md: absent — recommend one (init proposes a scaffold)"
 *
 * Scaffold/augment flow (init): agentsOffer(cwd) composes the proposal —
 *   absent  → scaffold: the bundled AGENTS_TEMPLATE (principles, invariants,
 *             structure/placement, how-to-work incl. the parked-dependencies
 *             bullet, gates)
 *   present → augment: paste-ready additions for exactly the gaps found
 *   ok      → null (nothing to propose)
 * The offer is PURE. Writes happen only at the UI/CLI boundary (index.ts,
 * tools/init-cli.ts) and only after an explicit user yes — every not-yes
 * outcome (declined, headless) instead records the offer as a pending
 * proposal under .majordome/proposals/ via ext/proposals.ts (writeOfferProposal)
 * and prints its path. This module itself never touches the filesystem for
 * writing (selfcheck pins that), so an auto-write is structurally impossible
 * here.
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
 * Leaf module: fs/path reads only (plus docsprofile) — init/doctor import it
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
 * guidance (the same class Block.lesson indexes) — proposed ONLY where the
 * index does not already keep lessons (majordomeDir present ⇒ lessons have a
 * home; a section there would be a second home — captain decision
 * 2026-10-05: lessons live in the index, agents forget static files). A
 * testing section records how to verify; a no-compat rule frees greenfield
 * work from shims; the parked-dependencies rule keeps documented behavior
 * from outliving the mechanisms it promised. */
export function agentsGaps(content: string, greenfield: boolean, hasMajordome = false): string[] {
	const gaps: string[] = [];
	if (!hasMajordome && !/(^|\n)#{1,6}[^\n]*lessons/i.test(content)) gaps.push("no Lessons section");
	if (!/(^|\n)#{1,6}[^\n]*\btest/i.test(content) && !/(^|\n)[ \t]*[-*][^\n]*\btest/i.test(content)) gaps.push("no testing rules");
	if (greenfield && !/no[\s-]*compat|without[ \t]+(?:backward[ \t]+)?compat|no[ \t]+backward/i.test(content)) {
		gaps.push("no-compat rule missing (greenfield)");
	}
	if (!/parked[\s-]*depend/i.test(content)) gaps.push("no parked-dependencies rule");
	return gaps;
}

/** Gap string → the proposed addition that closes it (augment mode). Keys
 * MUST stay in lockstep with agentsGaps — selfcheck pins both. */
const GAP_ADDITIONS: Record<string, string> = {
	"no Lessons section": "## Lessons\n- Record mistakes as guidance here, newest first — a lesson beats a lecture.",
	"no testing rules": "## Testing\n- The check battery stays green before any commit: run the repo's tests, fix red before proceeding.",
	"no-compat rule missing (greenfield)": "- No compat shims — this repo is greenfield: it has no installed base to stay compatible with.",
	"no parked-dependencies rule": "- **Parked dependencies invalidate dependents** — when a planned mechanism parks or drops, every documented behavior that relied on it is re-decided and re-documented in the same change: wire it, or document the fallback as the trigger (manual is a trigger when it is documented as one).",
};

/** The bundled scaffold template (greenfield-clean: passes agentsGaps with
 * zero gaps) — adapted from the pi-majordome house AGENTS.md. */
export const AGENTS_TEMPLATE = `# AGENTS.md

Constraints, not a checklist. When two rules conflict, choose the option with
the lowest long-term cost for this repository and note it in the commit.

## Design Principles

- **Separation of concerns**: domain logic, persistence, presentation, and routing stay separated — one concern per file; the name says which.
- **Encapsulation**: expose public contracts only; modules talk through exported functions.
- **DRY**: one home per rule, constant, format, or schema fact; search before writing logic.
- **KISS / YAGNI**: simplest working shape; no speculative hooks or flags; abstraction only after a pattern repeats twice.
- **Depend on contracts**: core logic takes and returns plain values; no framework or UI types in core.

## Hard Invariants

1. **One owning module per domain** — every behavior has one home; everyone else calls it.
2. **Never duplicate logic** — second use moves to a shared place, callers updated with tests green.
3. **No business logic in rendering or UI layers** — views wire values; they never compute rules.

## Compatibility

- No compat shims — this repo is greenfield: it has no installed base to stay compatible with.

## Structure & Placement

- Repo root: \`README.md\` (product truth) · \`CHANGELOG.md\` (append-only history) · \`STATUS.md\` (deliverable ledger).
- \`docs/\` — product documentation. \`docs/dev/\` — research and design, never product claims.
- New files go next to similar code; never a new top-level directory without proposing it first.

## How to Work

- **Refactor first, then change** — behavior-preserving refactor (tests green) to make room, then the change; never both in one unverifiable diff.
- **Parked dependencies invalidate dependents** — when a planned mechanism parks or drops, every documented behavior that relied on it is re-decided and re-documented in the same change: wire it, or document the fallback as the trigger (manual is a trigger when it is documented as one).
- **Gates, not promises** — every claim is enforceable by a check where possible; a prompt alone is not enough.
- **Plan non-trivial work** — >~80–100 lines or >1–2 files: a short plan first.
- **Verify before push, gates before commit** — never chain a gate and a push in one command; a red gate stops the chain.

## Testing

- The check battery stays green before any commit: run the repo's tests, fix red before proceeding.

## Lessons

- Record mistakes as guidance here, newest first — a lesson beats a lecture.
<!-- scaffolded by pi-majordome init — edit freely -->
`;

/** The full report for a repo cwd. Absent file → the recommend line. */
export function agentsReport(cwd: string): AgentsReport {
	const f = join(cwd, "AGENTS.md");
	if (!existsSync(f)) {
		return { present: false, ok: false, greenfield: greenfieldRepo(cwd), gaps: [], line: "AGENTS.md: absent — recommend one (init proposes a scaffold)" };
	}
	const content = readAgentsContent(f);
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

function readAgentsContent(f: string): string {
	try {
		return readFileSync(f, "utf8");
	} catch {
		return ""; // unreadable → empty content → gaps reported (never throw)
	}
}

export interface AgentsOffer {
	kind: "scaffold" | "augment";
	target: string; // the AGENTS.md a user yes would write/append
	doc: string; // paste-ready: the full template (scaffold) or the additions (augment)
	message: string; // the ONE compact ask (confirm dialog / headless print)
}

/** The init proposal for a repo cwd, PURE (no writes — see the module
 * docstring). Null = present and zero gaps → nothing to propose. */
export function agentsOffer(cwd: string): AgentsOffer | null {
	const f = join(cwd, "AGENTS.md");
	if (!existsSync(f)) {
		return {
			kind: "scaffold",
			target: f,
			doc: AGENTS_TEMPLATE,
			message: "No AGENTS.md found — scaffold one from the bundled template? (principles · invariants · structure · how-to-work · gates)",
		};
	}
	const gaps = agentsGaps(readAgentsContent(f), greenfieldRepo(cwd));
	if (!gaps.length) return null;
	const doc = [
		"<!-- pi-majordome init: proposed AGENTS.md additions -->",
		"",
		gaps.map((g) => GAP_ADDITIONS[g] ?? "").filter(Boolean).join("\n\n"),
	].join("\n");
	return {
		kind: "augment",
		target: f,
		doc,
		message: `AGENTS.md: present · ${gaps.join(" · ")} — propose these additions?`,
	};
}
