/**
 * Worker → deck inbox (v2.0): the push half of the orchestrator.
 *
 * Workers (spawned with MJDX_WORKER=<name>) append ONE line on completion;
 * the deck session drains it at turn start and injects one-line notices.
 * File-based by design: no sockets, no context pollution — the line says
 * where the detail lives (log/session), the agent pulls only if asked.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { majordomeDir } from "./store.ts";
import type { SimplifyVerdict } from "./judges.ts";

export interface InboxLine {
	t: string;
	worker: string;
	note: string;
	log?: string;
	sessionFile?: string;
	/** SUGGEST-ONLY simplification hint (v2.9): the simplifyVerdict judge's
	 * rendered note, appended by the deck at drain time. Advice to the agent —
	 * the deck decides; never an auto send-back. */
	simplifyHint?: string;
}

export function inboxFile(): string {
	return process.env.MAJORDOME_INBOX?.trim() || join(majordomeDir(), "inbox.jsonl");
}

export function pushInbox(line: Omit<InboxLine, "t">): void {
	try {
		mkdirSync(majordomeDir(), { recursive: true });
		appendFileSync(inboxFile(), JSON.stringify({ t: new Date().toISOString(), ...line }) + "\n");
	} catch {
		// fail open — a lost notice must never break a worker
	}
}

/** Render the simplify verdict as the suggest-only note text ('simplify
 * hint: …'). Null when there is nothing to say: no verdict, simpler=false,
 * or empty hints — the completion line ships byte-identical to before. */
export function simplifyHintText(v: SimplifyVerdict | null): string | null {
	if (!v || !v.simpler || !v.hints.trim()) return null;
	return `simplify hint: ${v.kind ?? "simpler shape"} — ${v.hints.trim()}`;
}

/** Frequency guard (pure, bench-checkable): asked already this worker run →
 * no; no implementation blocks closed by the run → no; else yes (first
 * completion carrying implementation work gets the one judged hint). */
export function shouldAskSimplify(asked: boolean, implGists: string[]): boolean {
	return !asked && implGists.length > 0;
}

/** Return and clear all pending notices (drain = inject + delete, atomically enough). */
export function drainInbox(): InboxLine[] {
	const f = inboxFile();
	if (!existsSync(f)) return [];
	try {
		const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as InboxLine);
		rmSync(f);
		return lines;
	} catch {
		return [];
	}
}

/** One-line notice per pending worker completion, for injection. The
 * simplify hint (when present) rides the same line — still one line per
 * worker, still suggest-only. */
export function drainNotices(): string {
	const lines = drainInbox();
	if (!lines.length) return "";
	return "📬 majordome workers:\n" + lines.map((l) => {
		const base = `- worker ${l.worker}: ${(l.note || "session ended").slice(0, 110)}${l.log ? ` (log: ${l.log})` : ""}`;
		return l.simplifyHint ? `${base} · ${l.simplifyHint}` : base;
	}).join("\n");
}
