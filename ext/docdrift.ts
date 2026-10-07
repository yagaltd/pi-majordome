/**
 * Doc-drift gate (doctor, advisory) — README mechanism claims must map to
 * real code in ext/ or tools/. Proven drift class: README.md claimed "a
 * sidecar in watch mode keeps each repo's artifacts fresh" in the present
 * tense while the only sidecar code was an unwired prototype under
 * durable-sidecar/ — nothing in the shipped extension kept anything fresh.
 *
 * Rules are claim signatures (not bare nouns) so unrelated mentions of the
 * same word ("lifecycle sidecar" in the store layout line) never false-hit.
 * A present-tense claim with no implementation = WARN naming the drift.
 * Roadmap-marked wording (planned / not yet / prototype / …) is exempt from
 * WARN — it gets a note at most, never a failure. The doctor reports; you
 * choose the fix (build it, or mark it planned and give it a status.json row).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DriftEvidence {
	/** repo-root-relative file that must exist for the claim to be grounded */
	path: string;
	/** optional symbol that must appear in that file (grep-level, not parsed) */
	symbol?: RegExp;
}

export interface DriftRule {
	/** the mechanism, named for the report */
	noun: string;
	/** claim signature: matches a README line only when the mechanism is claimed */
	pattern: RegExp;
	/** evidence alternatives — any one grounds the claim */
	evidence: DriftEvidence[];
}

/** wording that demotes a mention to roadmap status (never a present-tense claim) */
export const ROADMAP_RE = /\b(planned|roadmap|not\s+yet|future|parked|prototype|unbuilt|todo|design\s+note)\b/i;

export const DRIFT_RULES: DriftRule[] = [
	{
		noun: "sidecar",
		pattern: /sidecar\s+(in\s+)?watch\s+mode/i,
		// the claim is about the SHIPPED extension keeping artifacts fresh — a
		// watch-mode sidecar must live in ext/ or tools/. durable-sidecar/ is
		// an unwired prototype and deliberately does NOT count.
		evidence: [{ path: "ext/sidecar.ts" }, { path: "tools/sidecar.ts" }],
	},
	{
		noun: "inbox",
		pattern: /\binbox\b/i,
		evidence: [{ path: "ext/inbox.ts", symbol: /export function (pushInbox|drainInbox|drainNotices)\b/ }],
	},
	{
		noun: "orchestrator",
		pattern: /\borchestrator\b/i,
		evidence: [{ path: "ext/orch.ts", symbol: /export (async )?function (orch|resolveWorkerRef)\b/ }],
	},
	{
		noun: "panel grading",
		pattern: /panel grading/i,
		evidence: [{ path: "ext/panel.ts", symbol: /export (async )?function gradeWithPanel\b/ }],
	},
	{
		noun: "one-pager",
		pattern: /\bone-?pager\b/i,
		evidence: [{ path: "ext/onepager.ts", symbol: /export function composeOnePager\b/ }],
	},
];

/** does any evidence alternative ground this rule in the given repo root? */
export function evidenceOk(repoRoot: string, rule: DriftRule): boolean {
	for (const ev of rule.evidence) {
		const p = join(repoRoot, ev.path);
		if (!existsSync(p)) continue;
		if (!ev.symbol) return true;
		try {
			if (ev.symbol.test(readFileSync(p, "utf8"))) return true;
		} catch { /* unreadable evidence file: not evidence */ }
	}
	return false;
}

export interface DriftReport {
	/** present-tense claims with no code — WARN these */
	warns: string[];
	/** roadmap-marked mentions of unimplemented mechanisms — notes, never failures */
	notes: string[];
}

/** scan a README's text; `hasEvidence` is injected so checks stay hermetic.
 * Matches are found in the WHOLE text (markdown hard-wraps split claim phrases
 * across lines) and mapped back to line numbers; the roadmap exemption looks
 * at the match line plus its neighbors (the wrap carries the qualifier). */
export function scanDocDrift(readme: string, hasEvidence: (rule: DriftRule) => boolean): DriftReport {
	const lines = readme.split("\n");
	const warns: string[] = [];
	const notes: string[] = [];
	for (const rule of DRIFT_RULES) {
		const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
		const hits: { n: number; context: string }[] = [];
		for (let m = re.exec(readme); m !== null; m = re.exec(readme)) {
			if (m.index === re.lastIndex) re.lastIndex++; // zero-length guard
			const n = readme.slice(0, m.index).split("\n").length; // 1-based line of the match
			const context = [lines[n - 2], lines[n - 1], lines[n]].filter((x): x is string => typeof x === "string").join(" ");
			hits.push({ n, context });
		}
		if (!hits.length) continue;
		if (hasEvidence(rule)) continue; // claimed AND implemented → quiet
		const present = hits.filter(({ context }) => !ROADMAP_RE.test(context));
		if (present.length) {
			const at = [...new Set(present.map((h) => `line ${h.n}`))].join(", ");
			warns.push(
				`doc drift: README claims "${rule.noun}" in the present tense (${at}) but no implementation exists in ext/ or tools/ — mark it planned (see status.json) or build it`,
			);
		} else {
			notes.push(
				`doc note: "${rule.noun}" appears in README only as roadmap/prototype wording and has no ext/ tools/ implementation — its status.json row should say so`,
			);
		}
	}
	return { warns, notes };
}
