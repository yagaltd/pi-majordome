/**
 * mjdx-sidecar (v2.0) — the first durable sidecar job: keep derived artifacts
 * (one-pager, map.json) fresh for registered projects, crash-safely.
 *
 * One process owns the storage (pi-durable rule). Per project dir it composes
 * from the global index and writes <dir>/.majordome/{one-pager.md,map.json};
 * a checkpoint per project means a crash finishes only the remaining dirs,
 * and an index-mtime memo skips dirs whose inputs did not change.
 *
 *   node sidecar.ts once          # one refresh pass (all registered projects)
 *   node sidecar.ts watch         # refresh pass every 30s
 *
 * Config: durable-sidecar/sidecars.json → { "projects": ["<abs dir>", ...] }
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeOnePager } from "../ext/onepager.ts";
import { compileMap } from "../ext/map.ts";
import { loadBlocks } from "../ext/store.ts";

const HERE = new URL(".", import.meta.url).pathname;
const context = BACKGROUND_CONTEXT;
mkdirSync("storage", { recursive: true });

interface Ck { phase: "refresh" | "wrap"; done: string[]; skipped: number }

const projects = (): string[] => {
	try {
		return JSON.parse(readFileSync(join(HERE, "sidecars.json"), "utf8")).projects ?? [];
	} catch (e) {
		console.error('config read failed:', (e as Error).message);
		return [];
	}
};
const indexStamp = () => {
	const d = process.env.MAJORDOME_DIR?.trim() || join(process.env.HOME!, ".pi", "majordome");
	return statSync(d).mtimeMs + ":" + statSync(join(d, "blocks.jsonl")).mtimeMs;
};

const Refresh = defineTask<{ dirs: string[]; stamp: string }, Ck, string>({
	name: "mjdx.refresh",
	version: 1,
	initial: () => ({ phase: "refresh", done: [], skipped: 0 }),
	phases: {
		refresh: async (task, runtime, ctx) => {
			const ck = (task.state as any).checkpoint as Ck;
			const dirs = task.input.dirs;
			if (ck.done.length >= dirs.length) {
				const stamp = await runtime.memo(`refresh:${task.input.stamp}`, `ok(${ck.done.length})`, ctx);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: `processed ${ck.done.length}, skipped ${ck.skipped} (${stamp})` } }), ctx);
				return;
			}
			const dir = dirs[ck.done.length];
			// skip via filesystem truth (memos are task-scoped, not cross-run):
			// if the composed one-pager is newer than the index, nothing changed
			const out = join(dir, ".majordome", "one-pager.md");
			let note = "refreshed";
			try {
				if (statSync(out).mtimeMs > Number(task.input.stamp.split(":")[0])) note = "skipped (unchanged)";
			} catch {
				/* first run */
			}
			if (note === "refreshed") {
				const blocks = loadBlocks().filter((x) => !x.session.startsWith("lineage:"));
				mkdirSync(join(dir, ".majordome"), { recursive: true });
				writeFileSync(join(dir, ".majordome", "one-pager.md"), composeOnePager(blocks).md);
				writeFileSync(join(dir, ".majordome", "map.json"), JSON.stringify(compileMap(blocks, dir.split("/").pop() ?? "work").json, null, 2));
			} else ck.skipped++;
			console.log(`  ${dir.split("/").pop()}: ${note}`);
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "refresh", done: [...ck.done, dir], skipped: ck.skipped } }), ctx);
		},
		wrap: async () => {},
	},
});

async function refreshPass() {
	const dirs = projects();
	if (!dirs.length) return console.log("sidecars.json: no projects registered");
	const storage = await openNodeJsonlStorage("storage", context);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "mjdx-sidecar", tasks: [Refresh] }));
	const harness = await Harness.open(storage, { registry }, context);
	const root = await harness.root(context);
	const id = await root.commit((tx) => tx.createTask(Refresh, { dirs, stamp: String(indexStamp()) }, { ownership: { kind: "ownerless" } }), context);
	console.log(`refresh ${id} → ${dirs.length} project(s)`);
	harness.resume();
	for (let i = 0; i < 120; i++) {
		await new Promise((r) => setTimeout(r, 500));
		let done = false;
		await root.commit(async (tx) => {
			const page = await tx.scanTasks({ kind: "mjdx.refresh" }, 5);
			done = page.items.at(-1)?.state?.status === "terminal";
			return undefined;
		}, context);
		if (done) break;
	}
	let out = "";
	await root.commit(async (tx) => {
		const page = await tx.scanTasks({ kind: "mjdx.refresh" }, 5);
		out = page.items.at(-1)?.state?.outcome?.result ?? "(pending)";
		return undefined;
	}, context);
	console.log(`pass complete: ${out}`);
	await harness.close(context);
}

const mode = process.argv[2] ?? "once";
if (mode === "once") await refreshPass();
else {
	console.log("watch: every 30s (ctrl-c to stop)");
	while (true) {
		await refreshPass().catch((e) => console.error("pass failed:", (e as Error).message));
		await new Promise((r) => setTimeout(r, 30_000));
	}
}
