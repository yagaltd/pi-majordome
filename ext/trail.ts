/**
 * majordome judgment trail — v1.x governance seed.
 *
 * Append-only verdict metadata at every judge decision point. Never message
 * text — verdicts, judge identity, versions only. Fail-open: a failed trail
 * write can never break a judge. Consumed by: calibration (dogfood), audit,
 * and any future dataset compile.
 *
 * Override the location with MAJORDOME_TRAIL_FILE (selfcheck isolation).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const TRAIL_VERSION = 1;

export function trailFile(): string {
	return process.env.MAJORDOME_TRAIL_FILE?.trim() || join(majordomeDir(), "trails.jsonl");
}

export function trail(judge: string, fields: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(trailFile()), { recursive: true });
		appendFileSync(trailFile(), JSON.stringify({ t: new Date().toISOString(), j: judge, v: TRAIL_VERSION, ...fields }) + "\n");
	} catch {
		// fail open — never break a judge for a trail write
	}
}
