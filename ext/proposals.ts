/**
 * PROPOSALS — .majordome/proposals/ lifecycle. This header IS the format
 * spec (one home; the selfcheck pins it by roundtrip).
 *
 * A proposal is a plain-markdown file: a small key:value metadata header (no
 * YAML dep), a blank line, then the body —
 *
 *   kind: agents-scaffold        what is proposed (e.g. agents-scaffold |
 *                                agents-augment; a lowercase slug)
 *   status: pending              pending | approved | rejected
 *   added: 2025-10-06            YYYY-MM-DD — the decision clock starts here
 *   source: init                 which surface composed it
 *
 *   # Title
 *
 *   body...
 *
 * After a decision, stampDecision adds three keys (reason optional):
 *   decided: 2025-10-08          YYYY-MM-DD of the stamp
 *   by: butler                   who decided
 *   reason: why
 *
 * STATE IS METADATA, NOT FOLDERS: the directory stays flat — no approved/,
 * no rejected/ — the status lives in the header key and the filename never
 * changes, so history is one `ls` away.
 *
 * DECISIONS ARE BUTLER-STAMPED, NEVER AUTO: housekeeping counts pending and
 * stale proposals as advisory findings; it cannot stamp a decision —
 * deciding is the captain's. stampDecision updates ONLY the metadata keys:
 * the body is byte-identical after a stamp. Future body edits are APPEND-
 * ONLY REVISIONS — append a `revised:` metadata key plus a revision section;
 * never overwrite what was proposed.
 *
 * Path: .majordome/proposals/YYYY-MM-DD-<kind>.md; a same-day same-kind
 * collision takes a -2, -3, ... suffix.
 *
 * Leaf module: fs/path only — the init write boundary (index.ts,
 * tools/init-cli.ts) and ext/housekeep.ts (advisory scan) import it without
 * cycles; ext/agentsmd.ts composes offers and stays write-free (type-only
 * import here). Fail-open: an unreadable proposals dir reads as empty —
 * scanning never throws into the caller.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentsOffer } from "./agentsmd.ts";

export type ProposalStatus = "pending" | "approved" | "rejected";
export type DecisionStatus = "approved" | "rejected"; // a decision is never "pending"
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["pending", "approved", "rejected"];

export interface ProposalMeta {
	kind: string;
	status: ProposalStatus;
	added: string; // YYYY-MM-DD
	source: string;
	decided?: string; // after stampDecision
	by?: string;
	reason?: string;
}

export interface ProposalEntry {
	path: string; // absolute
	file: string; // YYYY-MM-DD-<kind>[-N].md (never renamed)
	meta: ProposalMeta;
	title: string; // the body's first "# ..." line
	body: string;
}

export interface Decision {
	status: DecisionStatus;
	by: string;
	reason?: string;
}

export function todayISO(now = new Date()): string {
	return now.toISOString().slice(0, 10); // UTC calendar date — boring and stable
}

export function proposalsDir(cwd: string): string {
	return join(cwd, ".majordome", "proposals");
}

/** Header parse: key:value lines up to the first blank line, body after.
 * Returns the raw string map (validation is the caller's job — listProposals
 * enforces the schema; parseProposalText itself stays total). */
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

function toMeta(raw: Record<string, string>): ProposalMeta | null {
	const { kind, status, added, source } = raw;
	if (!kind || !source) return null;
	if (status !== "pending" && status !== "approved" && status !== "rejected") return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(added)) return null;
	const meta: ProposalMeta = { kind, status, added, source };
	if (raw.decided) meta.decided = raw.decided;
	if (raw.by) meta.by = raw.by;
	if (raw.reason) meta.reason = raw.reason;
	return meta;
}

function readEntry(path: string, file: string): ProposalEntry | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null; // unreadable → not a listing entry (fail-open)
	}
	const { meta: raw, title, body } = parseProposalText(text);
	const meta = toMeta(raw);
	return meta ? { path, file, meta, title, body } : null;
}

function scanEntries(cwd: string): ProposalEntry[] {
	const dir = proposalsDir(cwd);
	try {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.sort() // YYYY-MM-DD names → chronological
			.map((f) => readEntry(join(dir, f), f))
			.filter((e): e is ProposalEntry => !!e);
	} catch {
		return [];
	}
}

export interface WriteProposal {
	kind: string; // slug; sanitized to [a-z0-9-] for the filename
	title: string;
	body: string;
	source?: string; // default "init"
	added?: string; // default today (tests / regeneration)
}

/** Write a new pending proposal; returns the path written. status always
 * starts pending — a proposal is a question until the captain answers it. */
export function writeProposal(p: WriteProposal, cwd: string = process.cwd()): string {
	const kind = p.kind.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!kind) throw new Error("writeProposal: kind must be a non-empty slug (e.g. agents-scaffold)");
	const dir = proposalsDir(cwd);
	mkdirSync(dir, { recursive: true });
	const added = p.added ?? todayISO();
	const base = `${added}-${kind}`;
	let file = `${base}.md`;
	for (let n = 2; existsSync(join(dir, file)); n++) file = `${base}-${n}.md`; // same-day same-kind → -2, -3...
	const path = join(dir, file);
	writeFileSync(path, `kind: ${kind}\nstatus: pending\nadded: ${added}\nsource: ${p.source ?? "init"}\n\n# ${p.title}\n\n${p.body}\n`);
	return path;
}

/** Stamp a decision: updates ONLY the metadata keys (status in place;
 * decided/by/reason appended). The body — everything from the blank line on —
 * is carried over byte-identical. Throws on a non-decision status: "pending"
 * is undecided, not a decision. */
export function stampDecision(path: string, d: Decision, opts: { now?: string } = {}): void {
	if (d.status !== "approved" && d.status !== "rejected") {
		throw new Error(`stampDecision: status must be approved or rejected — "${d.status}" is not a decision (pending = undecided)`);
	}
	const text = readFileSync(path, "utf8");
	const sep = text.indexOf("\n\n");
	const head = sep === -1 ? text : text.slice(0, sep);
	const rest = sep === -1 ? "" : text.slice(sep); // "\n\nbody..." — untouched by construction
	const lines = head.split("\n");
	const set = (k: string, v: string) => {
		const i = lines.findIndex((l) => l.startsWith(`${k}:`));
		if (i >= 0) lines[i] = `${k}: ${v}`;
		else lines.push(`${k}: ${v}`);
	};
	set("status", d.status);
	set("decided", opts.now ?? todayISO());
	set("by", d.by);
	if (d.reason) set("reason", d.reason);
	writeFileSync(path, lines.join("\n") + rest);
}

function dayDiff(from: string, to: string): number {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 86400000 : 0;
}

function staleOf(entries: ProposalEntry[], days: number, now: string): ProposalEntry[] {
	return entries.filter((e) => e.meta.status === "pending" && dayDiff(e.meta.added, now) > days);
}

/** All proposals under cwd/.majordome/proposals/, chronological; optional
 * status filter. */
export function listProposals(cwd: string = process.cwd(), opts: { status?: ProposalStatus } = {}): ProposalEntry[] {
	return scanEntries(cwd).filter((e) => !opts.status || e.meta.status === opts.status);
}

/** Pending proposals older than `days` (default 7) — advisory only: the
 * caller reports them, it never decides. */
export function stalePending(days = 7, opts: { cwd?: string; now?: string } = {}): ProposalEntry[] {
	const now = opts.now ?? todayISO();
	return staleOf(scanEntries(opts.cwd ?? process.cwd()), days, now);
}

export interface ProposalsScan {
	entries: ProposalEntry[]; // every parsed proposal, any status
	pending: number; // count of status:pending
	stale: number; // pending older than `days` (default 7)
	legacy: boolean; // pre-proposals/ layout: .majordome/AGENTS.proposal.md exists
}

/** The one scan housekeeping (and any future surface) consumes: counts for
 * the advisory line, entries for callers that want detail, and the legacy
 * file flag from before proposals/ existed. */
export function scanProposals(cwd: string, opts: { now?: string; days?: number } = {}): ProposalsScan {
	const entries = scanEntries(cwd);
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
 * from ext/agentsmd.ts — becomes a pending proposal file (kind
 * agents-scaffold | agents-augment, source "init"). AGENTS.md itself is
 * written only on an explicit user yes, still at the boundary. Returns the
 * written path. */
export function writeOfferProposal(offer: AgentsOffer, cwd: string = process.cwd()): string {
	return writeProposal(
		{
			kind: `agents-${offer.kind}`, // scaffold → agents-scaffold, augment → agents-augment
			title: offer.kind === "scaffold" ? "Scaffold AGENTS.md from the bundled template" : "Proposed AGENTS.md additions",
			body: offer.doc,
			source: "init",
		},
		cwd,
	);
}
