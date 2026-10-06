# Roles & Communication Charter

Status: revised 2026-10-06 (integration pass) · owner: butler · every rule is
enforced by structure or queued as a gate. Provenance is footnoted, never
imported: borrowed ideas land only after mapping onto our existing primitives.

## The model

**Pyramid with artifact handoffs:** captain → butler → {build subagents |
deck → workers}. Two loop types, never confused:

- **Spawn tree** — who can create whom. A tree by rule; structural cycles
  (A spawns B spawns A) are impossible: every spawner sits above its spawns.
- **Feedback loops** — work → gate → verdict → rework. Real, healthy, and
  always *vertical*: they pass through the gate, and they terminate only on
  verified completion (verdict + bounded retries). Out of the loop when the
  task is verified — not before.

## The cast (our words only)

| role | what it is | powers | hard limits |
|---|---|---|---|
| **Captain** (you) | intent + approvals | the dangerous-class yes (rm, git state, scope) | — |
| **Butler** (main pi session) | memory, STATUS.md, verification gate, spec author | spawns build subagents; merges; pushes | never merges without re-running the gates itself |
| **Deck** (orchestrator, the sub-butler) | worker roster, task briefs, inbox, one-pager composition | sequences tasks, composes reports | never spawns code-changes; never verifies; lists dangerous findings up |
| **Workers** | repo-scoped pi sessions, own repo's memory injected | do repo work; report up with artifacts | never spawn; never write the global brain; no lateral channels |
| **Build subagents** | cold-start ephemeral executors in worktrees | receive a spec, return a report + branch | claims are not evidence |
| **Judges** (panel) | grading engines at gates, not sessions | independent votes, majority rules | never discuss verdicts with the graded party |
| **Consolidation** | the only writer of the global brain | distills trails into memory blocks, derives concept cells (parked) | one home per fact |
| **Concept cells** (parked) | distilled, linked topic nodes after consolidation | findings become memory, still linking back to source details | never written by workers |

## Patterns, not substrates

- **Votes** = the panel: independent parallel graders, isolation required.
- **Deliberation** = a **needs-chain over tasks**: each downstream agent
  receives upstream outputs and reacts; a final synthesis agent composes the
  artifact. Bounded by chain length; transcript is the session record. No new
  substrate — pi-core-subagents `tasks`/`needs` already implement it.

## The rules

- **R1 — Spawn is a tree; work loops are vertical.** No lateral edges between
  workers, ever. Feedback loops pass through the gate only, bounded by verdict
  + retry budget.
- **R2 — Workers communicate through artifacts + the manager, never through
  sessions.** A's output is a path/ID; B's spec references it. Dependencies are
  ordering at the manager layer (needs-edges), not B pinging A.
- **R3 — Spawn rights = verify duty, one inalienable pair.** Butler spawns and
  personally re-runs the gates before merge. Deck orchestrates but spawns
  nothing. Workers request via inbox. A future role gains spawn rights only
  with the verify gate attached.
- **R4 — Down is a spec, up is an artifact.** Task briefs carry: problem with
  evidence, recon pointers, build spec, verify gates, constraints, report
  format. Reports carry: what changed, gate results, deviations, branch.
- **R5 — Judge gates sit at role boundaries.** Worker report → panel gate →
  inbox (wiring pending); subagent report → butler bench re-run → merge.
- **R6 — The dangerous class only moves up.** Listed by whoever finds it,
  decided only by the captain.
- **R7 — Deliberation is convened as a needs-chain**: manager frames the
  question, bounded chain, synthesis artifact out, recorded. Independent votes
  and deliberation are different patterns — votes need isolation, deliberation
  needs reaction. Never mix them in one run.
- **R8 — Standing instructions are the worker's local constitution** (policy:
  "always run benches before reporting; never touch CHANGELOG"), not a todo
  list. The done-trigger is separate: completion → judge gate → inbox, or back
  with the verdict (bounded retries).
- **R9 — Memory flows one way up, context one way down.** Facts: worker trail →
  consolidation → global brain. Context: butler injects on spawn (spec +
  status-join + recall). Workers never write the global brain directly.
- **R10 — Cold start is a feature.** Subagents get the spec, not the history;
  needed memory is distilled into the spec by the butler.

## Worker↔worker: the verdict

- **Dependency** (B needs A's artifact, both run in parallel) → needs-edge at
  the manager; B's spec cites A's artifact path. Direct pinging buys latency
  hiding at the cost of deadlock risk, context pollution, split cost meters,
  audit gaps.
- **Consult** → manager-routed task with A's artifact attached.
- **Deliberation** → needs-chain (R7).
- **Zero lateral channels.** The feedback loop you flagged is vertical
  (worker↔gate) and bounded — it was never the forbidden thing.

## Provenance (reference only — adapted, not imported)

- codync study: mention routing → R2's artifact addressing; standing
  instructions → R8's constitution (their persona/policy idea); rooms →
  **rejected** as substrate, deliberation mapped onto needs-chains.
- firstmate study: per-task worktrees → our build-subagent worktrees; ship
  modes → queued worker worktree mode; crew pyramid → our deck/workers.
- tometo study: panel grading → built (ext/panel.ts); role-model split →
  parked.

## Gaps this charter queues

1. STATUS.md as docs-watch built-in + ingest-docs source (ledger facts enter
   memory; ledger edits satisfy the nudge).
2. Worker-report panel gate (R5 worker side).
3. Standing instructions per worker (R8) — orch config slice.
4. Docs command naming consolidation: `docs gen <kind>` / `docs pull`
   (replaces `docs <kind>` vs `ingest-docs`).
5. Doc-flow trigger decision on record: manual (`ingest-docs`) until the
   event-driven sidecar is wired — documented as manual, not silent.
