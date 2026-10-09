/** Proposals: formal change requests awaiting the captain. STORE-BACKED
 * (kind=proposal blocks — the same append-only discipline as decisions; the
 * files-as-artifacts compromise is replaced, see the ledger row). The
 * historical file API surface is preserved signature-for-signature — callers
 * (housekeep, index, init-cli) keep compiling; `path`-style handles are now
 * virtual (`proposal:<id>`). Also hosts the batched triage judgment that
 * tags pending ledger rows as proposal-worthy. One owning module for the
 * whole proposals domain. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentsOffer } from "./agentsmd.ts";
import { appendBlock, isProposalBlock, loadBlocks, type Block, type ProposalPayload } from "./store.ts";
import { loadKey } from "./judges.ts";
import { loadStatusRows, topicOf } from "./status.ts";
import { generate } from "./judges.ts";
import { trail } from "./trail.ts";

export type ProposalStatus = "pending" | "approved" | "rejected" | "superseded";
export type DecisionStatus = "approved" | "rejected"; // a decision is never "pending"
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["pending", "approved", "rejected", "superseded"];

export interface ProposalMeta {
	kind: string; // the proposal slug (stable id)
	status: ProposalStatus;
	added: string; // YYYY-MM-DD
	source: string;
	decided?: string;
	by?: string;
	reason?: string;
}

export interface ProposalEntry {
	path: string; // virtual handle: proposal:<id>
	file: string; // display identity: <created-date>-<id>.md
	meta: ProposalMeta;
	title: string;
	body: string;
}

export interface Decision {
	status: DecisionStatus;
	by: string;
	reason?: string;
}

export function todayISO(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

export function proposalsDir(cwd: string): string {
	return join(cwd, ".majordome", "proposals");
}

/** Header parse (key:value lines up to the first blank line, body after) —
 * total; kept for the legacy-file migration and any future md door. */
export function parseProposalText(text: string): { meta: Record<string, string>; title: string; body: string } {
	const sep = text.indexOf("\n\n");
	const head = sep === -1 ? text : text.slice(0, sep);
	const body = sep === -1 ? "" : text.slice(sep + 2);
	const meta: Record<string, string> = {};
	for (const line of head.split("\n")) {
		const m = /^([a-z][a-z0-9-]*):[ \t]*(.*)$/.exec(line);
		if (m) meta[m[1]] = m[2].trim();
	}
	const t = /^#\s+(.+)$/m.exec(body);
	return { meta, title: t ? t[1].trim() : "", body };
}

// ── the store backing ────────────────────────────────────────────────────────

/** The fold: latest block per proposal id wins (same rule as decisions). */
export function foldProposals(blocks: Block[]): ProposalPayload[] {
	const byId = new Map<string, ProposalPayload>();
	for (const b of blocks) {
		if (!isProposalBlock(b)) continue;
		byId.set(b.proposal.id, b.proposal);
	}
	return [...byId.values()].sort((a, b) => a.created.localeCompare(b.created));
}

export function loadProposals(): ProposalPayload[] {
	return foldProposals(loadBlocks().filter(isProposalBlock));
}

function appendProposalState(p: { id: string; title: string; body: string; status: ProposalStatus; created: string; decided?: string; by?: string; reason?: string }): void {
	appendBlock({
		id: `proposal:${p.id}:${Date.now().toString(36)}`,
		session: "proposals",
		sessionFile: "proposals",
		firstTurn: 0,
		lastTurn: 0,
		gist: null,
		intent: null,
		dims: {},
		tokensHybrid: [],
		head: p.title,
		closedAt: new Date().toISOString(),
		kind: "proposal",
		proposal: {
			id: p.id,
			title: p.title,
			body: p.body,
			status: p.status,
			created: p.created,
			...(p.decided ? { decided: p.decided } : {}),
		},
	});
}

function entryOf(p: ProposalPayload): ProposalEntry {
	return {
		path: `proposal:${p.id}`,
		file: `${p.created.slice(0, 10)}-${p.id}.md`,
		meta: {
			kind: p.id,
			status: p.status,
			added: p.created.slice(0, 10),
			source: "store",
			...(p.decided ? { decided: p.decided.slice(0, 10) } : {}),
		},
		title: p.title,
		body: p.body,
	};
}

// ── the historical API surface, re-backed ───────────────────────────────────

export interface WriteProposal {
	kind: string; // slug; sanitized to [a-z0-9-] for the id
	title: string;
	body: string;
	source?: string; // recorded in the proposal origin (default "init")
	added?: string; // default today (tests / regeneration)
}

/** Write a new pending proposal; returns the virtual handle
 * (`proposal:<id>`). status always starts pending — a proposal is a question
 * until the captain answers it. */
export function writeProposal(p: WriteProposal, cwd: string = process.cwd()): string {
	const kind = p.kind.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!kind) throw new Error("writeProposal: kind must be a non-empty slug (e.g. agents-scaffold)");
	const added = p.added ?? todayISO();
	const known = new Set(loadProposals().map((x) => x.id));
	let id = `${added}-${kind}`;
	for (let n = 2; known.has(id); n++) id = `${added}-${kind}-${n}`;
	appendProposalState({ id, title: p.title, body: p.body, status: "pending", created: `${added}T00:00:00.000Z` });
	return `proposal:${id}`;
}

/** Stamp a decision: appends a new block with the decided status (the fold
 * moves — nothing in place is ever edited). Throws on a non-decision status:
 * "pending" is undecided, not a decision. Accepts the virtual handle OR a
 * legacy file path (legacy files are read, then re-stamped into the store). */
export function stampDecision(handle: string, d: Decision, opts: { now?: string } = {}): void {
	if (d.status !== "approved" && d.status !== "rejected") {
		throw new Error(`stampDecision: status must be approved or rejected — "${d.status}" is not a decision (pending = undecided)`);
	}
	let payload: ProposalPayload | undefined;
	if (handle.startsWith("proposal:")) {
		const id = handle.slice("proposal:".length);
		payload = loadProposals().find((p) => p.id === id);
	} else if (existsSync(handle)) {
		const parsed = parseProposalText(readFileSync(handle, "utf8"));
		const id = handle.split("/").pop()!.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
		payload = { id, title: parsed.title || id, body: parsed.body, status: "pending", created: new Date().toISOString() };
	}
	if (!payload) throw new Error(`stampDecision: unknown proposal "${handle.slice(0, 60)}"`);
	appendProposalState({
		id: payload.id,
		title: payload.title,
		body: payload.body,
		status: d.status,
		created: payload.created,
		decided: `${opts.now ?? todayISO()}T00:00:00.000Z`,
		by: d.by,
		reason: d.reason,
	});
}

function dayDiff(from: string, to: string): number {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 86400000 : 0;
}

function staleOf(entries: ProposalEntry[], days: number, now: string): ProposalEntry[] {
	return entries.filter((e) => e.meta.status === "pending" && dayDiff(e.meta.added, now) > days);
}

/** All proposals in the store fold, chronological; optional status filter.
 * Legacy .md files under cwd/.majordome/proposals/ are migrated into the
 * store on first sight (once, idempotent by id) before the fold is read. */
export function listProposals(cwd: string = process.cwd(), opts: { status?: ProposalStatus } = {}): ProposalEntry[] {
	migrateLegacyProposals(cwd);
	const entries = loadProposals().map(entryOf);
	return entries.filter((e) => !opts.status || e.meta.status === opts.status);
}

/** Pending proposals older than `days` (default 7) — advisory only: the
 * caller reports them, it never decides. */
export function stalePending(days = 7, opts: { cwd?: string; now?: string } = {}): ProposalEntry[] {
	const now = opts.now ?? todayISO();
	migrateLegacyProposals(opts.cwd ?? process.cwd());
	return staleOf(loadProposals().map(entryOf), days, now);
}

export interface ProposalsScan {
	entries: ProposalEntry[]; // every proposal in the fold, any status
	pending: number; // count of status:pending
	stale: number; // pending older than `days` (default 7)
	legacy: boolean; // pre-proposals/ layout: .majordome/AGENTS.proposal.md exists
}

/** The one scan housekeeping (and any future surface) consumes: counts for
 * the advisory line, entries for callers that want detail, and the legacy
 * file flag from before proposals/ existed. */
export function scanProposals(cwd: string, opts: { now?: string; days?: number } = {}): ProposalsScan {
	migrateLegacyProposals(cwd);
	const entries = loadProposals().map(entryOf);
	const now = opts.now ?? todayISO();
	const days = opts.days ?? 7;
	return {
		entries,
		pending: entries.filter((e) => e.meta.status === "pending").length,
		stale: staleOf(entries, days, now).length,
		legacy: existsSync(join(cwd, ".majordome", "AGENTS.proposal.md")),
	};
}

/** The init boundary's one-liner, shared by BOTH init surfaces (index.ts
 * hasUI path and tools/init-cli.ts): an agentsOffer — a PURE composition
 * from ext/agentsmd.ts — becomes a pending proposal in the store (kind
 * agents-scaffold | agents-augment, source "init"). AGENTS.md itself is
 * written only on an explicit user yes, still at the boundary. Returns the
 * virtual handle. */
export function writeOfferProposal(offer: AgentsOffer, cwd: string = process.cwd()): string {
	return writeProposal(
		{
			kind: `agents-${offer.kind}`,
			title: offer.kind === "scaffold" ? "Scaffold AGENTS.md from the bundled template" : "Proposed AGENTS.md additions",
			body: offer.doc,
			source: "init",
		},
		cwd,
	);
}

// ── the one-time legacy migration ────────────────────────────────────────────

let migratedDirs = new Set<string>();

/** Migrate legacy .majordome/proposals/*.md files into the store — once per
 * dir per process, idempotent by proposal id across processes (known ids are
 * skipped). Returns what moved. Silent when the dir doesn't exist. */
export function migrateLegacyProposals(cwd: string): { migrated: string[]; skipped: string[] } {
	const dir = proposalsDir(cwd);
	const out = { migrated: [] as string[], skipped: [] as string[] };
	if (!existsSync(dir) || migratedDirs.has(dir)) return out;
	migratedDirs.add(dir);
	const known = new Set(loadProposals().map((p) => p.id));
	try {
		for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
			const id = f.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
			if (known.has(id)) { out.skipped.push(f); continue; }
			const parsed = parseProposalText(readFileSync(join(dir, f), "utf8"));
			const rawStatus = parsed.meta.status;
			const status: ProposalStatus = ["pending", "approved", "rejected", "superseded"].includes(rawStatus) ? rawStatus as ProposalStatus : "pending";
			const added = /^\d{4}-\d{2}-\d{2}$/.test(parsed.meta.added ?? "") ? parsed.meta.added : f.slice(0, 10);
			appendProposalState({
				id,
				title: parsed.title || id.replace(/-/g, " "),
				body: parsed.body,
				status,
				created: `${added}T00:00:00.000Z`,
			});
			out.migrated.push(f);
		}
	} catch {
		/* migration is best-effort — the file API surface keeps working */
	}
	return out;
}

// ── the sieve: forced-choice 4-level gates (no neutral middle) ──
// Central-tendency bias killed by design: 4 named poles per gate force the
// judge to commit to a side. Ambivalence is not lost — return_probabilities
// MEASURE it: a split distribution (low confidence) escalates the idea to the
// deeper establishment path instead of hiding behind a middle score.

export const VALUE_LEVELS = ["nice-to-have", "useful", "valuable", "must-have"] as const;
export const RISK_LEVELS = ["trivial", "contained", "serious", "severe"] as const;
export const EFFORT_LEVELS = ["xs", "s", "m", "l"] as const;
export type ValueLevel = (typeof VALUE_LEVELS)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type SieveOutcomeKind = "drop" | "park" | "propose" | "build-direct";

export interface SieveVerdict {
	item: string;
	value: ValueLevel;
	risk: RiskLevel;
	effort: EffortLevel;
	path: TriagePath;
	why: string;
	confidence?: number;
	outcome: SieveOutcomeKind;
	note?: string;
}

/** Pure: thresholds + family-lift rules → the verdict's outcome.
 * nice-to-have/useful parks (the ledger keeps ideas; the sieve explains);
 * severe risk parks + flags; xs + must-have builds direct (small stays small);
 * everything else proposes with its establishment path. */
export function sieveOutcome(v: { value: ValueLevel; risk: RiskLevel; effort: EffortLevel; path: TriagePath; familySize: number }): { outcome: SieveOutcomeKind; note?: string } {
	const valuable = v.value === "must-have" || v.value === "valuable";
	if (v.value === "nice-to-have" && v.familySize < 2) return { outcome: "park", note: "value gate: nice-to-have, standalone" };
	if (v.risk === "severe") return { outcome: "park", note: "risk gate: severe — decompose or shrink the blast radius first" };
	if (valuable && v.effort === "xs") return { outcome: "build-direct", note: "must-have and xs — skip the proposal ceremony" };
	if (!valuable && v.familySize < 2) return { outcome: "park", note: "value gate: useful at best, standalone" };
	return { outcome: "propose" };
}

/** The sieve of ONE idea: a single focused generate call — 4 forced-choice
 * questions (value ← risk depends_on value ← effort/path depend on both),
 * permutation-averaged probabilities on every gate. Per-IDEA, never batched:
 * the 26-row batch cross-contaminated whys; one idea's context stays clean. */
export async function sieveIdea(item: string, familySize = 1): Promise<SieveVerdict | null> {
	if (!loadKey()) return null;
	const q = {
		value: { type: "string", choices: VALUE_LEVELS.map((l, i) => ({ value: l, description: ["barely moves anything", "useful someday", "clearly moves the house forward", "blocking or high-leverage — the house suffers without it"][i] })), return_probabilities: true, instructions: "Value gate: is this idea nice-to-have or must-have? Commit — there is no middle." },
		risk: { type: "string", choices: RISK_LEVELS.map((l, i) => ({ value: l, description: ["no meaningful blast radius", "refactors are local and reviewable", "touches load-bearing paths — needs careful review", "wrong implementation breaks other systems"][i] })), return_probabilities: true, depends_on: ["value"], instructions: "Risk gate: implementation risk + blast radius if this were built." },
		effort: { type: "string", choices: EFFORT_LEVELS.map((l, i) => ({ value: l, description: ["an afternoon", "a day or two", "several days / multi-slice", "a project"][i] })), depends_on: ["value"], instructions: "Effort gate: honest cost to build it well." },
		path: { type: "string", choices: [{ value: "research", description: "deeper research first" }, { value: "inspect", description: "codebase inspection first" }, { value: "grill", description: "known-unknowns session with the user" }, { value: "none", description: "no proposal needed" }], depends_on: ["value", "risk", "effort"], instructions: "If a proposal is warranted: how to establish it — research = deeper research first; inspect = codebase inspection first; grill = known-unknowns session with the user; none = no proposal needed." },
		why: { type: "string", depends_on: ["value", "risk", "effort", "path"], instructions: "One line, max 14 words: the reason behind your value and risk calls." },
	};
	// upstream is transient under load (429/5xx) — the sieve retries with
	// backoff before failing open; the trail records every miss.
	let r = null;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			r = await generate(`[ledger idea, topic family size: ${familySize}]
${item}

Run the three gates (value, risk, effort) and name the establishment path. Commit on every gate — no middle exists.`, q, undefined, 90_000);
			if (r) break;
		} catch (e) { if (process.env.MAJORDOME_DEBUG) console.error("[sieve attempt]", String((e as Error).message ?? e).slice(0, 200)); }
		if (attempt < 3) await new Promise((res) => setTimeout(res, attempt === 1 ? 400 : 1600));
	}
	if (!r) {
		trail("sieveIdea", { ok: false, attempts: 3 });
		if (process.env.MAJORDOME_DEBUG) console.error("[sieve] generate returned null after retries");
		return null;
	}
	const res: any = r?.result;
	if (process.env.MAJORDOME_DEBUG) console.error("[sieve parse] r:", r === null ? "null" : typeof r, "· res keys:", res ? Object.keys(res).join(",") : String(res), "· value:", JSON.stringify(res?.value ?? null).slice(0, 120));
	if (!res?.value?.value) {
		trail("sieveIdea", { ok: false });
		return null;
	}
	// value is the primary gate and reliably answered; risk/effort get sane
	// priors when the model skips them (depends_on + 5 questions occasionally
	// drops one — observed flaky, not content-dependent).
	const value = res.value.value as ValueLevel;
	const risk = (res.risk?.value ?? "contained") as RiskLevel;
	const effort = (res.effort?.value ?? "m") as EffortLevel;
	const path = (typeof res.path === "string" ? res.path : res.path?.value ?? "none") as TriagePath;
	const why = String(res.why ?? "").slice(0, 110);
	const confidence = typeof res.value.confidence === "number" ? res.value.confidence : undefined;
	const { outcome, note } = sieveOutcome({ value, risk, effort, path, familySize });
	// split-verdict escalation: an ambivalent value gate forces the deeper path
	const escalated = confidence !== undefined && confidence < 0.6 && outcome === "propose" && path === "none";
	const finalPath: TriagePath = escalated ? "grill" : (outcome === "propose" && path === "none" ? "research" : path);
	const out: SieveVerdict = { item, value, risk, effort, path: finalPath, why, ...(confidence !== undefined ? { confidence } : {}), outcome, ...(note ? { note } : {}), ...(escalated ? { note: "split verdict — escalated to grill" } : {}) };
	trail("sieveIdea", { ok: true, item: item.slice(0, 60), value, risk, effort, outcome, path: finalPath, ...(confidence !== undefined ? { confidence } : {}) });
	return out;
}

/** The marker line: compact score string, the verdict at a glance. */
export function sieveMarker(v: SieveVerdict): string {
	const mark = String.fromCharCode(0x24df); // ⓟ
	const out = { park: "park", drop: "drop", propose: "propose", "build-direct": "build-direct" }[v.outcome];
	return `${mark} [V:${v.value} · R:${v.risk} · E:${v.effort} → ${v.outcome}${v.path !== "none" ? ` via ${v.path}` : ""}] ${v.item.slice(0, 60)} — ${v.why}${v.note ? ` (${v.note})` : ""} ${out === "" ? "" : ""}`.replace(/\s+$/, "");
}

// ── triage: the batched judgment over pending ledger rows ───────────────────

export type TriagePath = "research" | "inspect" | "grill" | "none";
export interface TriageRow { item: string; worthy: boolean; path: TriagePath; why: string; confidence?: number }

/** Pure: parse a generate() result into TriageRows against the asked rows.
 * Handles both plain and v0.6.6 probability ({value, confidence}) answers. */
export function parseTriage(res: Record<string, unknown> | null | undefined, rows: { item: string }[]): TriageRow[] | null {
	if (!res) return null;
	const out: TriageRow[] = [];
	for (let i = 0; i < rows.length; i++) {
		const a: any = res[`row_${i + 1}`];
		if (!a) return null;
		const worthy = typeof a.worthy === "boolean" ? a.worthy : a.worthy?.value;
		const path = typeof a.path === "string" ? a.path : a.path?.value;
		if (typeof worthy !== "boolean" || !["research", "inspect", "grill", "none"].includes(path)) return null;
		const conf = typeof a.worthy?.confidence === "number" ? a.worthy.confidence : undefined;
		out.push({
			item: rows[i].item,
			worthy,
			path: (worthy ? path : "none") as TriagePath,
			why: String(a.why ?? "").slice(0, 80),
			...(conf !== undefined ? { confidence: conf } : {}),
		});
	}
	return out;
}

const TRIAGE_CHUNK = 8; // 26 rows in one call blow the 30s transport timeout — 8 thinking questions fit comfortably

/** Judge rows in chunks (<=TRIAGE_CHUNK rows per generate call). Context lines
 * are per-chunk numbered to match parseTriage's row_N keys. Partial failure
 * keeps earlier chunks (fail-open) and trails the miss for diagnosis. */
async function judgeRowsInChunks(lines: string[], rows: { item: string }[]): Promise<TriageRow[] | null> {
	const out: TriageRow[] = [];
	let failed = 0;
	for (let c = 0; c < rows.length; c += TRIAGE_CHUNK) {
		const chunkRows = rows.slice(c, c + TRIAGE_CHUNK);
		const chunkCtx = lines.slice(c, c + TRIAGE_CHUNK).join("\n").slice(0, 3500);
		const questions: Record<string, unknown> = {};
		for (let i = 0; i < chunkRows.length; i++) {
			questions[`row_${i + 1}`] = {
				type: "object",
				properties: {
					worthy: { type: "boolean", return_probabilities: true, instructions: "Does this idea deserve a formal proposal (scoped, reviewable) BEFORE any build work — because it is complex/large, a group of related ideas, touches multiple systems, or needs captain approval beyond a one-liner? Small mechanical tasks are NOT worthy. A row whose family (related ideas) recently grew may now be worth a proposal even if it looks small alone." },
					path: { type: "string", enum: ["research", "inspect", "grill", "none"], instructions: "How to establish the proposal: research = deeper research first; inspect = codebase inspection first; grill = known-unknowns session with the user; none = no proposal needed." },
					why: { type: "string", instructions: "One line, max 12 words." },
				},
			};
		}
		const r = await generate(`[pending + parked ledger rows]\n${chunkCtx}\n\nDecide per row whether it deserves a formal proposal before build work, and how to establish it.`, questions);
		const parsed = parseTriage(r?.result, chunkRows);
		if (parsed) out.push(...parsed);
		else failed++;
	}
	if (failed) trail("triageChunk", { ok: false, failed, of: Math.ceil(rows.length / TRIAGE_CHUNK) });
	return out.length ? out : null;
}

/** Batched triage: ONE generate call over every pending row. Deterministic
 * family sizes (topicOf) pre-seed the group-of-ideas signal. Null on no key
 * or transport failure — triage is advisory and never blocks the ledger. */
export async function triagePending(rowsOverride?: { item: string }[], cwd = process.cwd()): Promise<TriageRow[] | null> {
	const rows = rowsOverride ?? loadStatusRows(cwd).filter((r) => r.status === "pending");
	if (!rows.length) return [];
	if (!loadKey()) return null;
	const fams = new Map<string, number>();
	rows.forEach((r) => { const f = topicOf(r.item); fams.set(f, (fams.get(f) ?? 0) + 1); });
	const context = rows.map((r, i) => `${i + 1}. [topic=${topicOf(r.item)} family=${fams.get(topicOf(r.item))}] ${r.item}`).join("\n").slice(0, 3500);
	const questions: Record<string, unknown> = {};
	for (let i = 0; i < rows.length; i++) {
		questions[`row_${i + 1}`] = {
			type: "object",
			properties: {
				worthy: { type: "boolean", return_probabilities: true, instructions: "Does this idea deserve a formal proposal (scoped, reviewable) BEFORE any build work — because it is complex/large, a group of related ideas, touches multiple systems, or needs captain approval beyond a one-liner? Small mechanical tasks are NOT worthy." },
				path: { type: "string", enum: ["research", "inspect", "grill", "none"], instructions: "How to establish the proposal: research = deeper research first; inspect = codebase inspection first; grill = known-unknowns session with the user; none = no proposal needed." },
				why: { type: "string", instructions: "One line, max 12 words." },
			},
		};
	}
	const r = await generate(`[pending ledger rows]\n${context}\n\nDecide per row whether it deserves a formal proposal before build work, and how to establish it.`, questions);
	return parseTriage(r?.result, rows);
}

export interface TriagePlan { toJudge: { item: string }[]; inherited: number }

/** Pure dedup rules for incremental triage (the captain's design):
 * worthy-tagged rows INHERIT (family growth is irrelevant — already worthy);
 * none-tagged rows re-judge ONLY when their family grew since tagging (group
 * formation is what changes worthiness); untagged rows judge. */

/** The ledger-triggered auto-triage: judge only what the plan requires,
 * merge + persist tags in meta (survives restarts), return ALL rows' tags
 * (pending + parked — both scan-lists). Null-tagged renders come straight
 * from the store: steady-state renders add zero judge calls. */

