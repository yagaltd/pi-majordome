# Pi Durable study — Path A/B decision input (v2 orchestrator)

Date: 2026-10-03. Method: read the shipped API (`@earendil-works/pi-durable@1.0.1` on npm, README +
`.d.ts`), then a working crash/resume prototype (`durable-proto/proto.ts`, no TUI, no model) proving
the three things majordome's durable jobs need.

## What the API actually is

- **A standalone agent harness** (`Harness.open(storage, {models, registry})`) — NOT a
  pi-coding-agent extension runtime. A Path-B majordome is a rebuild on Harness + hooks
  (`experimental/durable` + `experimental/vacation` in the pi repo are the reference shapes,
  vacation ≈ 1,300 lines mostly TUI).
- **Tasks**: `defineTask({name, version, initial, phases})` — durable state machines; phases
  commit checkpoints via `runtime.commit`; wait via `{status:"waiting", on, policy:"failFast"|"allSettled"}`;
  `runtime.memo` = first-write-wins durable decisions. Ownership trees: aborting a task aborts
  what it owns, bottom-up. A subagent = conversation owned by the starting tool call.
- **Hooks** (chain, per registry order): rewrite model requests, block/rewrite tool calls,
  write compaction summaries — with **memos** so a re-run after crash finds the stored decision.
  → majordome's injection tail, contradicts gate, and pi-vcc compaction transfer map 1:1.
- **Compaction-as-task**: background, boundary-placed summaries, manual with instructions;
  older messages always stay in storage.
- **Storage**: Memory / SQLite (WAL) / JSONL (append-only, `{fsync:true}`) + conformance suite;
  one process owns a storage; custom backends small to write.
- **Crash semantics**: every step checkpoints before advancing; interrupted tool calls rerun if
  `replay:"safe"`; `requestId` = exactly-once submissions; `resume()` continues.
- **Multiplayer**: any client attaches (`viewState`/`subscribe`), joins late, steers
  (`whenBusy:"steer"`) — a Herdr-pane replacement surface.

## Prototype evidence (`durable-proto/`)

Crash at fold step 3 (`exit 137`) → reopen same JSONL storage → `resume()` → re-ran only the
uncommitted step 3, folded 4–6, memo `tree-stamp=tree(6)` first-write-wins, terminal
`{"status":"completed","result":"tree(6)"}`. Exactly the checkpoint/exactly-once semantics the
map-maintenance and reconcile jobs need. Working code, ~120 lines.

**Gotchas found (all worked around, all worth remembering):**
1. Runtime task state wraps fields under `task.state.checkpoint` (the `.d.ts` narrowing differs).
2. `runtime.memo` INSIDE `runtime.commit` nests commits and faults the phase — memo first, then
   commit terminal.
3. tsx's resolver mishandles chord's `exports` map — run with plain `node` (type-stripping,
   `"type":"module"`) instead.
4. `Harness.open` rejects a plain-object registry — use `createRegistry()`.
5. TypeBox at package root: ~23 MB peak RSS unbundled (~4 MB bundled).

## The decision

**Recommendation: Path A for v2.0, with a Path-B sidecar for jobs; full Path B deferred until the
API stabilizes (it is labeled experimental, "changes without notice").**

- **Path A (firstmate workers) carries v2.0**: majordome installs as-is in every worker pi process
  (zero seam rewrite), Herdr supervision works today, shared brain = same global index, and the
  bench exists to verify worker-indexing parity. Effort: dispatch protocol + worker lifecycle +
  shared-brain verification — the smallest path to the orchestrator's value.
- **Durable sidecar (hybrid, adopt now)**: the prototype proves map-maintenance/reconcile-style
  jobs run as durable tasks in a separate process reading the same JSONL index — without touching
  the pi-extension seam. Crash-safe jobs today, no migration debt.
- **Full Path B (rebuild on Harness + hooks)**: the clean endgame (injection as request-rewrite
  hooks, compaction-as-task as the pi-vcc transfer, multiplayer as the supervision surface) but it
  is an app rebuild, gated on API stability. Revisit at 1.x with a migration spike.

Rejected alternative considered: Dolt-style versioned index for audit — unnecessary; the
append-only record is replayable, and projections are deterministic functions of it.
