# Roles & Communication Charter

Status: built 2026-10-06 · owner: butler · origin: the codync study (@mention rooms,
team MCP, standing instructions) + the firstmate pyramid · every rule here is
enforced by structure or queued as a gate (gates, not promises).

## The model in one line

Pyramid with artifact handoffs: **captain → butler → {build subagents | deck →
workers}**. Everything returns as an artifact + verdict. Nothing returns as a
conversation.

## The cast

| role | what it is | powers | hard limits |
|---|---|---|---|
| **Captain** (you) | intent + approvals | the dangerous-class yes (rm, git state, scope changes) | — |
| **Butler** (main pi session) | global brain + judgment seat: memory, STATUS.md, verification gate, spec author | spawns build subagents; merges; pushes | never merges without re-running the gates itself |
| **Deck** (orchestrator, the sub-butler) | distribution: worker roster, task briefs, inbox, one-pager composition | sequences tasks, composes reports | never spawns code-changes; never verifies; lists dangerous findings up |
| **Workers** | repo-scoped pi sessions with their repo's own majordome memory injected | do repo work; report up with artifacts | never spawn; never write the global brain directly; no lateral channels |
| **Build subagents** | cold-start ephemeral executors in worktrees | receive a spec, return a report + branch | no house memory by design; their claims are not evidence |
| **Judges** (panel) | grading engines at gates, not sessions | grade reports vs task contracts | never discuss verdicts with the graded party; majority rules |
| **Room** (future) | manager-convened deliberation | bounded rounds (≤3), reacting agents, transcript to record | convened only by the manager; never a standing channel |
| **Concept cells** (parked) | distilled, linked topic nodes — output of consolidation | make findings addressable memory | written by consolidation only; always link back to source blocks |

## Communication rules

- **R1 — The fan-out is a tree.** No lateral edges, ever.
- **R2 — Workers communicate through artifacts + the manager, never through
  sessions.** A's output is a path/ID; B's spec references it. Dependencies are
  ordering at the manager layer (needs-edges), not B pinging A.
- **R3 — Spawn rights = verify duty, one inalienable pair.** Butler spawns and
  personally re-runs the gates before merge. Deck orchestrates but spawns
  nothing. Workers request via inbox. Any future role that gains spawn rights
  inherits the verify gate or does not get the rights.
- **R4 — Down is a spec, up is an artifact.** Every task brief carries: problem
  with evidence, recon pointers, build spec with pre-registered decisions, verify
  gates, constraints, report format. Every report carries: what changed, gate
  results, deviations, branch. No prose-only reports.
- **R5 — Judge gates sit at role boundaries.** Worker report → panel gate →
  inbox (wiring pending); subagent report → butler bench re-run → merge.
- **R6 — The dangerous class only moves up.** rm / git-state / beyond-scope:
  listed by whoever finds it, decided only by the captain.
- **R7 — Rooms are convened, never standing.** Manager opens with a question and
  a round budget; transcript lands in the record; the verdict artifact leaves;
  the room closes. Independent votes (panel) and deliberation (room) are
  different tools — votes need isolation, deliberation needs reaction. Never mix.
- **R8 — Standing instructions are the worker's local constitution, not a todo
  list.** Policy like "always run benches before reporting; never touch
  CHANGELOG". The done-trigger is separate: completion → judge gate → inbox, or
  back to the worker with the verdict (bounded retries).
- **R9 — Memory flows one way up, context one way down.** Facts: worker trail →
  consolidation → global brain (consolidation is the only writer; one home per
  fact). Context: butler injects on spawn (spec + status-join + recall).
- **R10 — Cold start is a feature.** Subagents get the spec, not the history.
  If a task needs memory, the butler distills the needed block into the spec.

## Worker↔worker: the deep answer

Every legitimate peer case collapses into the pyramid:

- **Dependency** ("B needs A's artifact, both run in parallel") → needs-edge at
  the manager: the manager sequences, B's spec cites A's artifact path. Direct
  pinging buys latency hiding but costs deadlock risk, context pollution, two
  cost meters, and an audit gap.
- **Consult** ("ask Reviewer to check this") → manager-mediated: A reports
  "needs review", the manager routes it as a task to B with A's artifact
  attached. One budget owner, one audit point, cycle-free.
- **Deliberation / brainstorming** → a convened room (R7): bounded, recorded,
  artifact out. Research, brainstorming, and campaign work are pyramidal —
  leaves report to the manager, the manager synthesizes — exactly as you
  diagnosed.
- **Verdict: zero use cases justify lateral channels.** codync needs
  cycle-checking *because* its bots are peers by design; our workers are scoped
  and our topology is a tree, so cycles are impossible by construction. The
  value of peer communication is fully captured by artifacts + ordering +
  convened rooms — at none of the cost.

## Rooms vs workspaces vs concept cells

- **Workspace** = where work happens: repo + pane + trail.
- **Room** = a deliberation protocol run inside a workspace, by the manager,
  bounded rounds, recorded.
- **Research pyramid** = the manager distributes leaf tasks, workers return
  artifacts, the manager synthesizes (pi-core-subagents `tasks`/`needs` today;
  deck orch for repo work).
- **Concept cells** = the distilled residue *after* consolidation: linked topic
  nodes in the graph overlay, each linking back to its source blocks — findings
  become memory without losing the address of the details. Your reading is the
  design: the cell is the result of workspace findings, kept as memory, still
  pointing inside the workspace.

## Gaps this charter surfaces (queued, not silent)

1. **STATUS.md is not a docs-watch built-in** — ledger edits do not satisfy the
   docs nudge (micro-slice in `ext/docsprofile.ts`).
2. **Worker-report panel gate** (R5's worker side) — judges exist, wiring
   pending.
3. **Standing instructions per worker** (R8) — orch config slice.
4. **Room convener** (R7) — parked until real deliberation demand appears.
5. **ingest-docs sources** should include STATUS.md so ledger facts enter
   memory (config: `~/.config/pi-majordome/docs-sources.json`).
