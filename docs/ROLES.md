# The House Charter — roles & rules

Status: v2 2026-10-06 · five rules, one matrix · naming: majordome /
concierge / worker / subagent / judges. Provenance footnoted at the end —
borrowed ideas land only after mapping onto our primitives.

## The picture

```text
            captain (you)
            intent + the dangerous yes
                  │
             MAJORDOME
   brain + STATUS ledger + final gates + spawn
            │                   │
     concierge(s)          subagents
   one per domain        ephemeral, cold start
   decompose + sequence  worktree, spec in /
   first-line gate       report out
            │
         workers
   coding · creative · reviewer
   repo- or task-scoped, own memory

   spawn flows DOWN · artifacts flow UP · no lateral channels
   work loops are VERTICAL: report → gate → pass up / bounded retry
```

## The five rules

1. **The tree.** Spawn flows down (majordome → concierges → workers;
   subagents from majordome or concierge), artifacts flow up. No
   worker-to-worker channels, ever — a dependency is an artifact path cited in
   a spec, sequenced by the manager.
2. **Spawn = verify.** Whoever spawns owns the first-line gate. Only the
   majordome merges and pushes. A role gets spawn rights only with the gate
   attached.
3. **Specs down, artifacts up.** Every brief carries: problem with evidence,
   recon pointers, build, verify gates, constraints. Every report carries:
   what changed, gate results, deviations, branch. No prose-only.
4. **Gates end every loop.** Reports pass a gate (panel judges for worker
   reports; butler bench re-run for merges) or return with the verdict,
   bounded retries. Out of the loop only when verified.
5. **Dangerous goes up.** rm, git state, scope changes: listed by whoever
   finds them, decided only by the captain.

Memory footnote: facts flow up only through consolidation (the one writer);
context flows down only distilled into specs. Subagents start cold — that is
the design.

## Powers matrix

| power | captain | majordome | concierge | worker | subagent |
|---|---|---|---|---|---|
| approve dangerous | **yes** | propose | propose | propose | — |
| spawn workers/subagents | — | **yes** | **yes** | — | — |
| first-line gate | — | final (merge) | **first-line** | — | — |
| merge/push | — | **yes** | — | — | — |
| write STATUS.md rows | — | **yes** | propose | propose | propose |
| write memory | — | via consolidation | — | own repo trail | — |
| lateral channel | — | — | — | **no** | — |

## Patterns, not substrates

- **Votes** = the panel (independent graders, isolation).
- **Deliberation** = a needs-chain: downstream agents receive upstream
  outputs and react; a synthesis agent composes the artifact. Bounded chain,
  recorded, one artifact out. No new substrate.

## Judge note

Judges are engines, not workers — independence is the point. "Reviewer" is a
worker task; the panel is the gate.

## Provenance (reference only)

- codync study: mention routing → artifact addressing; standing instructions →
  worker constitution (queued); rooms → rejected, mapped to needs-chains.
- firstmate study: worktrees → subagent worktrees; ship modes → queued worker
  worktree mode; second mates → concierges; pyramid → this charter.
- tometo study: panel grading → built; role-model split → parked.

## Queued by this charter

STATUS watch built-in + ingest source · worker-report panel gate · standing
instructions per worker · docs naming consolidation (`docs gen`/`docs pull`) ·
init AGENTS.md scaffold/augment flow (ask-first) · doc-flow trigger stays
manual until the event-driven sidecar is wired.
