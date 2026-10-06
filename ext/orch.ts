/**
 * /majordome orch — the orchestrator menu (v2.0).
 *
 * One command: /majordome orch prints the menu into the chat; replies act:
 *   /majordome orch 1        start worker 1 (config mode: headless default)
 *   /majordome orch @slug    start by slug — worker name or cwd basename
 *                            (case-insensitive; "orch slug" works too)
 *   /majordome orch a        start all
 *   /majordome orch add /abs/path [name]   register a repo (persisted)
 *   /majordome orch remove 2 remove worker 2
 *   /majordome orch status   per-worker counts
 *
 * Same core as tools/dispatch.ts (the optional manual CLI) — one action set,
 * two surfaces. Cold repos init on first start; warm ones are noted.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { majordomeDir, loadBlocks } from "./store.ts";
import { sessionSlug } from "./core.ts";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { initRepo } from "./init.ts";

type Worker = { name: string; cwd: string };
type OrchConf = { workers: Worker[]; mode: "headless" | "pane" };

/** Worker addressing (v2.6): "N" (1-based) | "slug" | "@slug" — slug = worker
 * name or the cwd basename, case-insensitive. All three resolve to one worker. */
export function resolveWorkerRef(ref: string, workers: Worker[]): Worker | null {
	const trim = ref.trim();
	if (/^\d+$/.test(trim)) return workers[Number(trim) - 1] ?? null;
	const key = trim.replace(/^@/, "").toLowerCase();
	return (
		workers.find((w) => w.name.toLowerCase() === key) ??
		workers.find((w) => (w.cwd.split("/").filter(Boolean).pop() ?? "").toLowerCase() === key) ??
		null
	);
}

const workerSlug = (w: Worker): string => w.cwd.split("/").filter(Boolean).pop() ?? w.name;
const knownSlugs = (workers: Worker[]): string =>
	workers.map((w) => (workerSlug(w).toLowerCase() === w.name.toLowerCase() ? w.name : `${w.name}|${workerSlug(w)}`)).join(", ") || "(none registered)";

const confFile = () => join(majordomeDir(), "orchestrator.json");
const load = (): OrchConf => {
	try {
		return JSON.parse(readFileSync(confFile(), "utf8"));
	} catch {
		return { workers: [], mode: "headless" };
	}
};
const save = (c: OrchConf) => {
	mkdirSync(majordomeDir(), { recursive: true });
	writeFileSync(confFile(), JSON.stringify(c, null, 2));
};

const slugBlocks = (cwd: string): number => {
	const base = cwd.split("/").filter(Boolean).pop()!.toLowerCase();
	return loadBlocks().filter((b) => (sessionSlug(b.sessionFile) ?? "").toLowerCase().includes(base)).length;
};
const whichPi = () => {
	for (const c of ["/home/aurel/.npm-global/bin/pi", "/usr/local/bin/pi"]) if (existsSync(c)) return c;
	return "pi";
};

async function ensureAndStart(w: Worker, mode: "headless" | "pane"): Promise<string> {
	const n = slugBlocks(w.cwd);
	let note = `memory warm (${n} blocks)`;
	if (n === 0) note = `cold start → ${await initRepo({ cwd: w.cwd })}`;
	if (mode === "pane") {
		spawn("herdr", ["agent", "start", "--cwd", w.cwd, "pi"], { cwd: w.cwd, stdio: "ignore" }).unref();
		return `${w.name}: pane started (${note}) — steerable via herdr`;
	}
		const logDir = join(w.cwd, ".majordome", "workers");
		mkdirSync(logDir, { recursive: true });
		const log = join(logDir, `${w.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
		const fd = openSync(log, "w");
		const p = spawn(process.execPath, [whichPi(), "-p", "Summarize the current state of this project in 5 bullets."], {
			cwd: w.cwd,
			env: { ...process.env, MJDX_WORKER: w.name },
			stdio: ["ignore", fd, fd],
		});
		p.unref();
		closeSync(fd);
		return `${w.name}: headless started (pid ${p.pid}) (${note}) — output \u2192 ${log}`;
}

/** Roster for views (status @slug etc.) — read-only reuse of the conf loader. */
export function listWorkers(): { name: string; cwd: string }[] {
	return load().workers;
}

export async function orch(arg?: string): Promise<string> {
	const conf = load();
	const L = (s: string) => s;
	if (!arg) {
		// no-arg = the daily command: start all in the configured mode, then report
		const out: string[] = [];
		for (const w of conf.workers) out.push(await ensureAndStart(w, conf.mode));
		if (!out.length) return "orchestrator: no workers — /majordome orch add /abs/path";
		return out.join("\n");
	}
	if (arg === "pane" || arg === "headless") {
		const out: string[] = [];
		for (const w of conf.workers) out.push(await ensureAndStart(w, arg as "headless" | "pane"));
		return `${arg}:\n` + out.join("\n");
	}
	if (arg === "menu") {
		const lines = [L(`orchestrator — mode: ${conf.mode}`)];
		conf.workers.forEach((w, i) => {
			const n = slugBlocks(w.cwd);
			lines.push(` ${i + 1}. ${w.name.padEnd(16)} ${n} blocks [${n > 0 ? "warm" : "cold"}]`);
		});
		lines.push(" a. start all · add /abs/path [name] · remove <n> · status");
		lines.push(`reply: /majordome orch <n | @slug | a | add … | remove … | status>`);
		return lines.join("\n");
	}
	const trim = arg.trim();
	if (trim === "status") {
		return ["orchestrator status:", ...conf.workers.map((w) => `  ${w.name.padEnd(16)} ${slugBlocks(w.cwd)} blocks · ${w.cwd}`)].join("\n");
	}
	if (trim === "a" || trim === "all") {
		const out: string[] = [];
		for (const w of conf.workers) out.push(await ensureAndStart(w, conf.mode));
		return out.join("\n");
	}
	if (trim.startsWith("add ")) {
		const parts = trim.slice(4).trim().split(/\s+/);
		// shell habits: expand ~ and relative paths — chat commands arrive unexpanded
		let cwd = parts[0];
		if (cwd.startsWith("~")) cwd = join(homedir(), cwd.slice(1));
		cwd = resolve(cwd);
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return `add failed: ${parts[0]} does not exist (resolved: ${cwd})`;
		const w: Worker = { name: parts[1] ?? cwd.split("/").filter(Boolean).pop()!, cwd };
		if (conf.workers.some((x) => x.cwd === cwd)) return `already registered: ${cwd}`;
		conf.workers.push(w);
		save(conf);
		const n = slugBlocks(cwd);
		return `registered ${w.name} → ${cwd} (${n} blocks ${n > 0 ? "[warm]" : "[cold — will init on first start]"})\n/majordome orch to start it`;
	}
	const rm = trim.match(/^remove (\d+)$/);
	if (rm) {
		const i = Number(rm[1]) - 1;
		if (!conf.workers[i]) return `no worker #${rm[1]}`;
		const [gone] = conf.workers.splice(i, 1);
		save(conf);
		return `removed ${gone.name} (${gone.cwd})`;
	}
	// worker addressing: "N", "slug", or "@slug" — one worker, three spellings
	const w = resolveWorkerRef(trim, conf.workers);
	if (w) return await ensureAndStart(w, conf.mode);
	if (/^\d+$/.test(trim)) return `no worker #${trim}`;
	if (/^@?[a-z0-9][a-z0-9-]*$/i.test(trim)) return `no worker matching "${trim}" — known slugs: ${knownSlugs(conf.workers)}`;
	return `unknown: "${trim}" — /majordome orch for the menu`;
}
