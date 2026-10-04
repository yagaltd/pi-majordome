/**
 * mjdx dispatch (v2.0) — the firstmate orchestrator, surface-agnostic.
 *
 * One command deck (any repo, empty is fine) manages worker pi sessions in
 * other repos. Workers all carry majordome → one shared global brain; the
 * dispatcher's only jobs are lifecycle + cold-start + visibility.
 *
 * Modes (presentation adapters over the same core):
 *   headless — `pi -p "<prompt>"` in the worker cwd; runs to completion,
 *              session saved, majordome indexes it. For batch/report work.
 *   pane     — `herdr agent start` — visible, steerable, watched in a pane.
 *              For interactive work. (Later: a web frontend speaks the same
 *              lifecycle via Durable's viewState/subscribe — no Herdr needed.)
 *
 *   node tools/dispatch.ts start [--mode pane|headless] [--prompt "..."]
 *   node tools/dispatch.ts status
 *   node tools/dispatch.ts steer <name> <text>   # pane mode only
 *
 * Config: ~/.pi/majordome/orchestrator.json
 *   { "workers": [{ "name": "code-parser", "cwd": "/abs/path" }, ...],
 *     "mode": "headless" }
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { initRepo } from "../ext/init.ts";
import { loadBlocks } from "../ext/store.ts";

const config = (): { workers: { name: string; cwd: string }[]; mode: "headless" | "pane" } => {
	const f = join(homedir(), ".pi", "majordome", "orchestrator.json");
	if (!existsSync(f)) return { workers: [], mode: "headless" };
	return JSON.parse(readFileSync(f, "utf8"));
};

const slugBlockCount = (cwd: string): number => {
	const base = cwd.split("/").filter(Boolean).pop()!.toLowerCase();
	return loadBlocks().filter((b) => sessionSlugOf(b.sessionFile).toLowerCase().includes(base)).length;
};
function sessionSlugOf(f: string): string {
	const m = f.match(/sessions\/([^/]+)\//);
	return m ? m[1] : f;
}

async function ensureMemory(cwd: string): Promise<string> {
	const n = slugBlockCount(cwd);
	if (n > 0) return `memory warm (${n} blocks)`;
	const m = await initRepo({ cwd });
	return `cold start: ${m}`;
}

async function main() {
	const args = process.argv.slice(2);
	const cmd = args[0];
	const flag = (name: string): string | undefined => {
		const i = args.indexOf(name);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const cfg = config();

	if (cmd === "status") {
		console.log(`mode: ${cfg.mode}`);
		for (const w of cfg.workers) {
			const n = slugBlockCount(w.cwd);
			console.log(`  ${w.name.padEnd(16)} ${w.cwd}  ·  ${n} blocks`);
		}
		return;
	}

	if (cmd === "start") {
		const mode = (flag("--mode") ?? cfg.mode) as "headless" | "pane";
		const prompt = flag("--prompt") ?? "Summarize the current state of this project in 5 bullets.";
		for (const w of cfg.workers) {
			if (!existsSync(w.cwd)) {
				console.log(`${w.name}: cwd missing, skipped`);
				continue;
			}
			console.log(`${w.name}: ${await ensureMemory(w.cwd)}`);
		}
		for (const w of cfg.workers) {
			if (!existsSync(w.cwd)) continue;
			if (mode === "pane") {
				const p = spawn("herdr", ["agent", "start", "--cwd", w.cwd, "pi"], { stdio: "inherit" });
				console.log(`${w.name}: pane starting (herdr agent)`);
				void p;
			} else {
				const p = spawn(process.execPath, [whichPi(), "-p", prompt!], {
					cwd: w.cwd,
					stdio: "ignore",
				});
				p.unref();
				console.log(`${w.name}: headless pi started (pid ${p.pid}) — session will be indexed on save`);
			}
		}
		return;
	}

	if (cmd === "steer") {
		const name = flag("--name") ?? args[1];
		const text = args.slice(args.indexOf(name) + 1).join(" ");
		const w = cfg.workers.find((x) => x.name === name);
		if (!w) return console.log(`no worker named ${name}`);
		const p = spawn("herdr", ["agent", "prompt", "--cwd", w.cwd, text], { stdio: "inherit" });
		p.on("exit", (c) => console.log(`steer exit ${c}`));
		return;
	}

	console.log("usage: dispatch start [--mode pane|headless] [--prompt ...] | status | steer <name> <text>");
}
/** locate the pi binary without assuming PATH order */
function whichPi(): string {
	for (const c of ["/home/aurel/.npm-global/bin/pi", "/usr/local/bin/pi"]) if (existsSync(c)) return c;
	return "pi";
}
main();
