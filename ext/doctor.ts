/**
 * /majordome doctor — audit the memory installation and report what needs
 * attention. Never auto-repairs (the trail is append-only; fixes are actions
 * the user chooses), never crashes on bad state (that is the state it audits).
 *
 * Checks: orphaned blocks (session file gone from disk), index/meta/trails/
 * init/orchestrator parse health, dims coverage, vocab size, session-cursor
 * lag (indexed lastTurn vs the newest session file for each slug).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBlocks, loadLifecycle, loadMeta, loadVocab, majordomeDir, effectiveStatus } from "./store.ts";

const dir = majordomeDir();

function sessionsDir(): string {
	return join(homedir(), ".pi", "agent", "sessions");
}

export async function doctor(): Promise<string> {
	const L: string[] = [];
	let warns = 0;
	const bad = (m: string) => { L.push(`✗ ${m}`); warns++; };
	const ok = (m: string) => L.push(`✓ ${m}`);

	// 1. core files parse
	try { loadBlocks(); ok(`index: ${loadBlocks().length} blocks parse`); } catch (e) { bad(`index unreadable: ${(e as Error).message}`); }
	try { loadMeta(); loadVocab(); ok(`meta + vocab ok (vocab ${loadVocab().length})`); } catch (e) { bad(`meta/vocab unreadable: ${(e as Error).message}`); }
	for (const f of ["trails.jsonl", "init.json", "orchestrator.json"]) {
		const p = join(dir, f);
		if (!existsSync(p)) { L.push(`· ${f}: absent (optional)`); continue; }
		try {
			if (f === "init.json" || f === "orchestrator.json") JSON.parse(readFileSync(p, "utf8")); // single object
			else readFileSync(p, "utf8").split("\n").filter(Boolean).forEach((l) => JSON.parse(l)); // JSONL
			ok(`${f} parses`);
		} catch { bad(`${f} has unparseable content`); }
	}

	// 2. orphaned blocks — session file no longer on disk
	const blocks = loadBlocks();
	const orphans = [...new Set(blocks.filter((b) => !existsSync(b.sessionFile)).map((b) => b.sessionFile))];
	if (orphans.length) bad(`${orphans.length} session file(s) referenced but missing: ${orphans.slice(0, 3).join(", ")}${orphans.length > 3 ? "…" : ""} — their blocks stay (trail is append-only); re-init rebuilds if you restore the files`);
	else ok("no orphaned blocks (every block's session file exists)");

	// 3. dims coverage
	const noDims = blocks.filter((b) => !b.dims || Object.keys(b.dims).length === 0).length;
	if (blocks.length && noDims / blocks.length > 0.3) bad(`dims coverage low: ${noDims}/${blocks.length} blocks have no dims (dims arm blind on them) — re-init --with-dims or accept bm25-only`);
	else if (blocks.length) ok(`dims coverage ok (${blocks.length - noDims}/${blocks.length})`);

	// 4. session-cursor lag per slug (indexed lastTurn vs file size)
	const sd = sessionsDir();
	if (existsSync(sd)) {
		let laggy = 0;
		const checked = new Set<string>();
		for (const d of readdirSync(sd)) {
			const sub = join(sd, d);
			try {
				for (const f of readdirSync(sub).filter((x) => x.endsWith(".jsonl"))) {
					const full = join(sub, f);
					const size = statSync(full).size;
					if (size < 20_000) continue; // tiny sessions: nothing to lag
					const have = blocks.filter((b) => b.sessionFile === full);
					const last = have.reduce((m, b) => Math.max(m, b.lastTurn), 0);
					const lineCount = readFileSync(full, "utf8").split("\n").filter(Boolean).length;
					// ~2 jsonl lines per turn average; if the file is 6x the indexed turns, lag
					if (have.length && lineCount > Math.max(24, last * 6)) { laggy++; checked.add(d); }
				}
			} catch { /* unreadable dir */ }
		}
		if (laggy) bad(`${laggy} session(s) lag the index heavily (long active sessions — the known closing-lag); /majordome init <slug> backfills`);
		else ok("no heavy index lag detected");
	} else bad("sessions dir not found");

	// 5. user.md (optional personal tier)
	const umd = join(dir, "user.md");
	if (!existsSync(umd)) L.push("· user.md: absent (optional — your cross-project preferences; create it and majordome injects it)");
	else ok("user.md present (personal tier)");

	// 6. lifecycle distribution (v2.4): counts per status + dead weight
	const art = loadLifecycle();
	const dist = { valid: 0, superseded: 0, failed: 0, speculative: 0 } as Record<string, number>;
	for (const b of blocks) dist[effectiveStatus(b, art)]++;
	const dead = dist.superseded + dist.failed;
	const deadPct = blocks.length ? Math.round((dead / blocks.length) * 100) : 0;
	L.push(`· lifecycle: valid ${dist.valid} · superseded ${dist.superseded} · failed ${dist.failed} · speculative ${dist.speculative} — dead weight ${deadPct}% (${dead}/${blocks.length})${art.supersessions.length ? ` · ${art.supersessions.length} supersession link(s)` : ""}`);

	// 7. orchestrator worker paths
	try {
		const oc = JSON.parse(readFileSync(join(dir, "orchestrator.json"), "utf8"));
		const missing = (oc.workers ?? []).filter((w: any) => !existsSync(w.cwd));
		if (missing.length) bad(`orchestrator worker cwd missing: ${missing.map((w: any) => w.name).join(", ")}`);
		else if (oc.workers?.length) ok(`orchestrator: ${oc.workers.length} workers, all cwd exist`);
	} catch { L.push("· orchestrator.json: absent (optional)"); }

	L.push(warns ? `\n${warns} issue(s) found — fixes are actions you choose (see hints above).` : "\nall clear.");
	return L.join("\n");
}
