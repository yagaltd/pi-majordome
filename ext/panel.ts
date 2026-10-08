/**
 * majordome panel grading — majority-of-available-engines for live
 * judge-graded gates (bench gate seam; not wired into the live extension).
 *
 * Problem (pre-documented): a live gate graded by ONE engine (shapebench (f)
 * fact retention) flipped 112%→89%→95% across identical code — server-side
 * model drift moved the verdict, not the code. Fix the GRADER, not the bar:
 * grade each fact with every engine configured at run time and settle the
 * fact on the MAJORITY of the graders that served.
 *
 * Engines (whatever is configured — a missing engine is never fabricated):
 *   typellm   — the TypeLLM judge transport (key present)
 *   jev       — pi's classifier registry when wired (setClassifyFn)
 *   typellm2  — a SECOND TypeLLM pass: the transport body ({context,
 *               questions}) exposes no seed/temperature knob, so the second
 *               pass is an independent re-ask of the same grading question.
 *
 * Verdict rule (pre-registered, applies per fact, votes from graders that
 * SERVED — a grader that threw or returned an unparseable verdict is
 * recorded as failed-open and excluded):
 *   ≥2 graders served → the fact counts as stated when ≥ half the serving
 *     graders saw it. Odd panels: strict majority. Even-panel ties resolve
 *     PRESENCE-ward — one grader DID see the fact, the drift mode being
 *     damped is spurious under-count, and this continues the replaced
 *     max-of-two guard's lean (absence must be evidenced by omission, not
 *     by a split vote).
 *   1 grader served → its verdict stands; the result is marked
 *     variance-prone (single-engine drift can move it — callers must say so
 *     in output).
 *   0 graders served/available → found: null (fail-open; callers report
 *     n/a, never a pass).
 *
 * Trail: one panelGrade line per attempted grader (judge: 'panel:<engine>',
 * ok:false when it failed open — a failed judge call still costs and must
 * be seen), plus one panelVerdict decision record (judge: 'panel') with the
 * panel composition and the settled verdict. Verdict metadata only — never
 * message text.
 */
import { generate, getClassifyFn, loadKey, tokensOf, type ClassifyFn } from "./judges.ts";
import { trail } from "./trail.ts";

/** One grader engine: a name for the trail and a run that returns per-fact
 * presence votes (index-aligned with the facts list) or null when it could
 * not produce a parseable verdict. `estTokens` rides along when the
 * transport reported usage (cost telemetry only). */
export interface PanelGrader {
	engine: string;
	run: (ctx: PanelGradeCtx) => Promise<GraderVote | null>;
}

export interface GraderVote {
	votes: boolean[];
	estTokens?: number;
}

export interface PanelGradeCtx {
	prompt: string; // the user ask the answer answered (grader context)
	facts: string[]; // fact phrases to look for
	output: string; // the answer under grade
}

export interface PanelGrade {
	found: number | null; // majority-settled fact count; null = fail-open (no grader served)
	total: number; // facts.length
	graders: string[]; // engines that SERVED (parseable verdict), in attempt order
	attempted: string[]; // engines configured (call attempts) — superset of graders
	perGrader: { engine: string; found: number | null }[]; // every attempt, null when failed open
	varianceProne: boolean; // exactly one grader served
}

/** The pure majority rule (unit-checked in selfcheck): fact i is present iff
 * 2·(yes votes for i) ≥ number of serving graders. */
export function majorityFacts(votes: boolean[][], nFacts: number): boolean[] {
	const n = votes.length;
	return Array.from({ length: nFacts }, (_, i) => 2 * votes.filter((v) => v[i] === true).length >= n);
}

// ── the three engines ───────────────────────────────────────────────────────

/** Shared TypeLLM grading question set: one batched call, one yes/no per
 * fact (any wording counts; only omission of the substance is a no). */
function factQuestions(facts: string[]): Record<string, unknown> {
	return Object.fromEntries(
		facts.map((f, i) => [
			`fact_${i + 1}`,
			{
				type: "string",
				enum: ["yes", "no"],
				return_probabilities: true, // v0.6.6: permutation-averaged, order-debiased votes
				instructions: `Does the answer state this fact — count it when the answer states it in ANY wording (different phrasing or synonyms still count); answer no only when the substance of the fact is omitted. Fact: "${f}". Answer yes or no.`,
			},
		]),
	);
}

function factContext({ prompt, facts, output }: PanelGradeCtx): string {
	const list = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
	return `A user asked a coding agent:\n${prompt}\n\nThe answer should state these facts:\n${list}\n\nAnswer to grade:\n${output.slice(0, 1600)}`;
}

/** Exported for selfcheck: both answer shapes vote identically. */
export function votesOf(res: Record<string, unknown>, n: number): boolean[] | null {
	const votes = Array.from({ length: n }, (_, i) => {
		const v = res[`fact_${i + 1}`];
		if (typeof v === "string") return v.trim().toLowerCase() === "yes";
		const val = (v as any)?.value; // v0.6.6 probability answer {value, probabilities, confidence}
		return typeof val === "string" ? val.trim().toLowerCase() === "yes" : null;
	});
	return votes.some((v) => v === null) ? null : (votes as boolean[]);
}

/** TypeLLM grader (engine "typellm" and, for the independent re-ask, the
 * same closure under engine "typellm2"). Null on transport failure or any
 * unparseable per-fact answer — the grader failed open, not voted no. */
function typellmGrader(engine: string): PanelGrader {
	return {
		engine,
		run: async (ctx) => {
			const r = await generate(factContext(ctx), factQuestions(ctx.facts));
			const votes = r?.result ? votesOf(r.result as Record<string, unknown>, ctx.facts.length) : null;
			if (!votes) return null;
			const n = tokensOf(r);
			return n ? { votes, estTokens: n } : { votes };
		},
	};
}

/** Jev grader via pi's classifier registry: per-fact noul yes/no. */
function jevGrader(fn: ClassifyFn): PanelGrader {
	return {
		engine: "jev",
		run: async ({ prompt, facts, output }) => {
			const res = await fn(
				{ prompt: prompt.slice(0, 500), answer: output.slice(0, 1200) },
				Object.fromEntries(
					facts.map((f, i) => [
						`fact_${i + 1}`,
						{
							type: "noul",
							instructions: `State has 'prompt' (the user's ask) and 'answer' (the agent's answer). Does the answer state this fact — any wording counts; no only when the substance is omitted? Fact: "${f}". Answer yes/no.`,
						},
					]),
				),
			);
			const answers = res?.answers ?? {};
			const votes = facts.map((_, i) => {
				const a = answers[`fact_${i + 1}`];
				if (typeof a === "boolean") return a;
				if (a && typeof a === "object" && typeof (a as any).noul === "boolean") return (a as any).noul as boolean;
				return null;
			});
			if (votes.some((v) => v === null)) return null;
			const n = tokensOf(res);
			return n ? { votes: votes as boolean[], estTokens: n } : { votes: votes as boolean[] };
		},
	};
}

/** The panel as configured RIGHT NOW — production composition. No key → no
 * typellm/typellm2 grader; no classifier → no jev grader. A missing engine
 * is never fabricated: the panel is whatever is configured, and a
 * single-engine panel is honestly marked variance-prone by gradeWithPanel. */
export function panelGraders(): PanelGrader[] {
	const out: PanelGrader[] = [];
	if (loadKey()) out.push(typellmGrader("typellm"));
	const jev = getClassifyFn();
	if (jev) out.push(jevGrader(jev));
	if (loadKey()) out.push(typellmGrader("typellm2"));
	return out;
}

// ── the seam ────────────────────────────────────────────────────────────────

export interface PanelGradeOpts {
	prompt: string;
	/** Trail context tag (e.g. "shapebench:f") — never message text. */
	label?: string;
	/** Bench/selfcheck injection ONLY — overrides the configured engines so
	 * majority logic is testable with zero network. Production callers never
	 * pass this; it can never fabricate an engine into a real run. */
	graders?: PanelGrader[];
}

/** Grade `output` against `facts` with the panel: every configured grader in
 * parallel, per-fact majority of the graders that served, composition and
 * per-grader verdicts on the trail. Fail-open: found null when no grader is
 * available or none serves a parseable verdict — callers report n/a, never
 * a pass. */
export async function gradeWithPanel(facts: string[], output: string, opts: PanelGradeOpts): Promise<PanelGrade> {
	const label = opts.label ?? "";
	const panel = opts.graders ?? panelGraders();
	const attempted = panel.map((g) => g.engine);
	const gradable = facts.length > 0 && !!output.trim() && panel.length > 0;
	if (!gradable) {
		// nothing configured to grade with (or nothing to grade): fail open,
		// composition recorded, no judge call made
		trail("panelVerdict", { judge: "panel", attempted, graders: [], found: null, total: facts.length, varianceProne: false, ...(label ? { label } : {}), unconfigured: panel.length === 0 });
		return { found: null, total: facts.length, graders: [], attempted, perGrader: [], varianceProne: false };
	}
	const ctx: PanelGradeCtx = { prompt: opts.prompt, facts, output };
	const results = await Promise.allSettled(panel.map((g) => g.run(ctx)));
	const served: boolean[][] = [];
	const perGrader: PanelGrade["perGrader"] = [];
	for (let i = 0; i < panel.length; i++) {
		const engine = panel[i].engine;
		const r = results[i];
		const vote = r.status === "fulfilled" ? r.value : null;
		if (vote && vote.votes.length === facts.length) {
			const found = vote.votes.filter(Boolean).length;
			served.push(vote.votes);
			perGrader.push({ engine, found });
			trail("panelGrade", { judge: `panel:${engine}`, ok: true, found, total: facts.length, ...(vote.estTokens ? { estTokens: vote.estTokens } : {}), ...(label ? { label } : {}) });
		} else {
			// gap-rule: the grader was attempted — a failed-open judge call is
			// still a judge call (cost must see it), recorded and excluded from
			// the majority
			perGrader.push({ engine, found: null });
			trail("panelGrade", { judge: `panel:${engine}`, ok: false, total: facts.length, ...(label ? { label } : {}) });
		}
	}
	const settled = served.length ? majorityFacts(served, facts.length) : null;
	const found = settled ? settled.filter(Boolean).length : null;
	const graders = perGrader.filter((g) => g.found !== null).map((g) => g.engine);
	const varianceProne = served.length === 1;
	const splits = settled ? facts.filter((_, i) => !unanimous(served, i)).length : 0;
	trail("panelVerdict", { judge: "panel", attempted, graders, found, total: facts.length, varianceProne, ...(splits ? { splits } : {}), ...(label ? { label } : {}) });
	return { found, total: facts.length, graders, attempted, perGrader, varianceProne };
}

/** Fact every serving grader scored identically (unanimous)? */
function unanimous(served: boolean[][], fact: number): boolean {
	const first = served[0][fact];
	return served.every((v) => v[fact] === first);
}
