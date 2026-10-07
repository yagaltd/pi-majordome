/**
 * one-pager (v2.1) — composed, deterministic, vcc-style over GIST atoms.
 *
 * NOT a maintained file: every run recomposes from the index (the trail stays
 * the source; this is a projection). Sections cite [tag:turns] — every line
 * traces to a block, nothing is invented. Command-first (/majordome
 * one-pager); resume auto-injection is a later, measured step (the resumebench
 * A/B gates it).
 *
 * Upgrade bar: bench/results/resume-baseline.json — hit@3 ≥ baseline per class.
 */
/** One-pager (v2.1, composed — never maintained prose). v2.9 adds a Lessons
 * section derived at compose time from the lesson class (Block.lesson, judged
 * at block close): top lesson blocks by recency, every line cited — the
 * section is a PROJECTION of the index, so re-composing after new lessons
 * rewrites it; nothing accumulates as hand-mainted text. */
import { shortTag } from "./core.ts";
import { isDecisionBlock, type Block } from "./store.ts";

const DECISION = /\b(decid|cho[os]e|shipped|dropped|removed|replaced|default|renamed|fixed|flipped|instead|not adopt)/i;

export interface OnePager {
	md: string;
	stats: { blocks: number; now: number; decisions: number; open: number; lessons: number };
}

const cite = (b: Block) => `[${shortTag(b.session)}:${b.firstTurn}–${b.lastTurn}]`;
const line = (b: Block) => {
	const g0 = b.gist ?? b.head;
	const g = g0.length > 130 ? `${g0.slice(0, 127)}…` : g0; // 130-char bullets — terse is the point
	return `- ${g} ${cite(b)}`;
};

export function composeOnePager(blocks: Block[], tag?: string): OnePager {
	// decision-ledger records feed the status fold, not this projection (the
	// "Decisions & commitments" section is session-derived prose, not rows)
	const scope = blocks
		.filter((b) => !isDecisionBlock(b))
		.filter((b) => (tag ? shortTag(b.session).toLowerCase().includes(tag.toLowerCase()) : true));
	const sorted = [...scope].sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
	const decisions = scope.filter((b) => b.gist && DECISION.test(b.gist)).sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
	// lessons: the index class, derived at compose time — recency first, capped
	// (a lesson block that also carries decision vocabulary stays in BOTH
	// sections: a decision that records the lesson is the lesson)
	const lessons = scope.filter((b) => b.lesson === true).sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
	const decisionIds = new Set(decisions.map((b) => b.id));
	const now = sorted.filter((b) => !decisionIds.has(b.id)).slice(0, 6);
	const open = sorted.filter((b) => !decisionIds.has(b.id) && !now.includes(b)).slice(0, 5);
	const byProject = new Map<string, Block[]>();
	for (const b of scope) {
		const t = shortTag(b.session);
		if (!byProject.has(t)) byProject.set(t, []);
		byProject.get(t)!.push(b);
	}

	const L: string[] = [
		"---",
		"generated_by: majordome",
		`generated_at: ${new Date().toISOString().slice(0, 10)}`,
		`stale_after: ${new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)}`,
		tag ? `scope: ${tag}` : "scope: all",
		"---",
		"",
		"# One-pager (composed — the trail is the source)",
		"",
		"## Now",
		...(now.length ? now.map(line) : ["- (nothing recent)"]),
		"",
		"## Decisions & commitments",
		...(decisions.slice(0, 10).map(line) || ["- (none recorded)"]),
		"",
		"## Lessons",
		...(lessons.length ? lessons.slice(0, 6).map(line) : ["- (none recorded — lesson-class blocks appear here as the index classifies them)"]),
		"",
		"## Open threads",
		...(open.length ? open.map(line) : ["- (none)"]),
		"",
		"## Where things live",
		...[...byProject.entries()].map(([t, bs]) => {
			const latest = bs.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1))[0];
			return `- ${t}: ${bs.length} blocks · latest: ${latest.gist ?? latest.head} ${cite(latest)} · record: \`${latest.sessionFile}\``;
		}),
		"",
		`_Grounded: ${scope.length} blocks · detail on demand: /majordome recall · record is append-only._`,
	];
	return { md: L.join("\n"), stats: { blocks: scope.length, now: now.length, decisions: decisions.length, open: open.length, lessons: lessons.length } };
}
