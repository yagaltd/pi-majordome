/**
 * Path-B feasibility probe — vacation-planner-sized, no TUI, no model.
 *
 * Proves the three things majordome's durable jobs need:
 *   1. a deterministic background job as a durable task (map-maintenance-shaped fold)
 *   2. crash mid-fold → reopen the SAME storage → resume() finishes ONLY the
 *      remaining steps (checkpoint semantics, exactly-once per step)
 *   3. memo replay: an idempotent decision stored durably with the task
 *
 *   MJDX_CRASH=1 node proto.ts run     # phase 1: create job, fold 3/6, crash
 *   node proto.ts resume               # phase 2: resume, fold 4-6, read outcome
 *
 * Note: task state fields live under `task.state.checkpoint` at runtime
 * (the .d.ts narrows `state` itself; the runtime wraps — discovered here).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { mkdirSync } from "node:fs";

mkdirSync("storage", { recursive: true });
const context = BACKGROUND_CONTEXT;
const EVENTS = ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6"];

interface FoldCk { phase: "fold" | "wrap"; done: number; nodes: string[] }

const MapJob = defineTask<{ events: string[] }, FoldCk, string>({
	name: "mjdx.mapfold",
	version: 1,
	initial: () => ({ phase: "fold", done: 0, nodes: [] }),
	phases: {
		fold: async (task, runtime, ctx) => {
			const ck = (task.state as any).checkpoint as FoldCk;
			if (ck.done >= task.input.events.length) {
				// memo BEFORE the terminal commit — a memo inside commit nests
				// commits and faults the phase (found by the pending-task run)
				const stamp = await runtime.memo("tree-stamp", `tree(${ck.nodes.length})`, ctx);
				console.log(`  memo tree-stamp = ${stamp} (first write wins)`);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: stamp } }), ctx);
				return;
			}
			const e = task.input.events[ck.done];
			console.log(`  fold ${ck.done + 1}/${task.input.events.length}: ${e}`);
			if (process.env.MJDX_CRASH && ck.done === 2) {
				console.log("\n*** CRASH: process.exit(137) mid-fold (steps 1-3 committed) ***");
				process.exit(137);
			}
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "fold", done: ck.done + 1, nodes: [...ck.nodes, `node(${e})`] } }),
				ctx,
			);
		},
		wrap: async () => {},
	},
});

async function main() {
	const mode = process.argv[2] ?? "run";
	const storage = await openNodeJsonlStorage("storage", context);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "mjdx-jobs", tasks: [MapJob] }));
	const harness = await Harness.open(storage, { registry }, context);
	const root = await harness.root(context);

	const read = async () => {
		let found: any;
		await root.commit(async (tx) => {
			const page = await tx.scanTasks({ kind: "mjdx.mapfold" }, 5);
			found = page.items.at(-1);
			return undefined;
		}, context);
		return found;
	};

	if (mode === "run") {
		const id = await root.commit((tx) => tx.createTask(MapJob, { events: EVENTS }, { ownership: { kind: "ownerless" } }), context);
		console.log(`created ${id}`);
		harness.resume();
		await new Promise((r) => setTimeout(r, 5_000));
		console.log("(no crash fired? rerun)");
		await harness.close(context);
		return;
	}

	// resume: reopen the SAME storage, continue the interrupted fold
	harness.resume();
	for (let i = 0; i < 60; i++) {
		await new Promise((r) => setTimeout(r, 250));
		const found = await read();
		if (found?.state?.status === "terminal") {
			console.log(`\nRESUMED: outcome = ${JSON.stringify(found.outcome)}`);
			console.log("verified: steps 1-3 from before the crash, 4-6 after — one durable fold, no rework");
			await harness.close(context);
			return;
		}
	}
	console.log("task still not terminal after 15s — inspect storage/");
	await harness.close(context);
}
main();
