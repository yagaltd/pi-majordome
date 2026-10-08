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
import { appendBlock, isProposalBlock, loadBlocks, type Block, type ProposalPayload, type ProposalStatus } from "./store.ts";
import { loadKey } from "./judges.ts";
import { loadStatusRows, topicOf } from "./status.ts";
import { generate } from "./judges.ts";

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

/** Batched triage: ONE generate call over every pending row. Deterministic
 * family sizes (topicOf) pre-seed the group-of-ideas signal. Null on no key
 * or transport failure — triage is advisory and never blocks the ledger. */
export async function triagePending(cwd = process.cwd()): Promise<TriageRow[] | null> {
	const rows = loadStatusRows(cwd).filter((r) => r.status === "pending");
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

/** Render triage rows as the marker section under the ledger table. */
export function triageMarkerLines(triage: TriageRow[]): string[] {
	return triage.filter((t) => t.worthy && t.path !== "none")
		.map((t) => `ⓟ ${t.path}: ${t.item.slice(0, 70)} — ${t.why}`);
}
