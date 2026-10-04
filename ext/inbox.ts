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

export interface InboxLine {
	t: string;
	worker: string;
	note: string;
	log?: string;
	sessionFile?: string;
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

/** One-line notice per pending worker completion, for injection. */
export function drainNotices(): string {
	const lines = drainInbox();
	if (!lines.length) return "";
	return "📬 majordome workers:\n" + lines.map((l) => `- worker ${l.worker}: ${(l.note || "session ended").slice(0, 110)}${l.log ? ` (log: ${l.log})` : ""}`).join("\n");
}
