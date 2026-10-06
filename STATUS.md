# STATUS — deliverable ledger

Every discussed deliverable gets exactly one row. built rows cite a commit.
Update on land or drop — never leave a row stale past the session that changed it.

| item | status | evidence | substrate |
|---|---|---|---|
| init/doctor AGENTS.md gap report | built | 18e3d51 | ext/agentsmd.ts · wired in ext/init.ts + ext/doctor.ts |
| self-improving recall loop (precision proxy + false-positive specimens) | built | 441e751 (docs beb8f8d) | ext/recall.ts · /majordome stats section |
| panel grading (majority-of-available-engines) | built | 7f5e91b (docs 332b226) | ext/panel.ts · live judge-graded gates |
| quality trio: from_untrusted / lessons / simplifyVerdict | built | 6ba17a0 + 2b2cb76 + 11ee775 (docs 8b5057b) | ext/store.ts · ext/router.ts · ext/inbox.ts · ext/consolidate.ts |
| docs profiles + brownfield init seeding | built | 0aa034d (merge 94221f6) | ext/docsprofile.ts |
| judge-cost telemetry + trailFile fix | built | 3c664e5 (docs 3bc55f1) | ext/trail.ts · stats + doctor creep note |
| diagram-first single-line labels | built | cbd3b30 | ext/judges.ts shape enum · ext/router.ts shapeHintLine |
| doctor audit (orphans, parse health, dims, lag, lifecycle, worker cwds) | built | 1c4047b | ext/doctor.ts |
| docs/ONE-PAGER.md build-day ledger | built | e413c2f | docs/ONE-PAGER.md |
| docs/FUTURE-STYLE-PROFILE.md | built | 3368e7e | docs/FUTURE-STYLE-PROFILE.md |
| orchestrator deck/workers/inbox | built | 3fe5f4a (push half 6a886b8) | ext/orch.ts · ext/inbox.ts · tools/dispatch.ts |
| doc-drift gate in doctor + STATUS.md ledger | built | 2d01537 (the housekeeping commit above) | ext/docdrift.ts · ext/doctor.ts check 11 · STATUS.md |
| sidecar watch mode | parked | prototype only: 26fde67 durable-sidecar/sidecar.ts (pi-durable watch mode) — NOT wired into ext/ or tools/; README shipped-claim drift caught by doctor and reworded to planned | durable-sidecar/ (unwired prototype) |
| Concept Cells | parked | named cbd3b30 — gated on organic graph maturity | docs/OVERVIEW.md |
| per-task worktrees for orch workers | parked | firstmate pattern note only — never built | docs/DESIGN.md layering section |
| zero-token event-driven supervision | parked | design note: build fs.watch event-driven from day one, inbox as wake surface | docs/DESIGN.md · docs/OVERVIEW.md |
| AGENTS.md seeding-via-docs | parked | paused — docs-profile pattern ready when needed (one-pager open queue #3) | docs/ONE-PAGER.md |
| style-vector slices | parked | 3368e7e — design of record, "nothing here is wired yet" | docs/FUTURE-STYLE-PROFILE.md |
| judgment-mechanism + bench-contract doc | parked | not started — no doc on disk | (to write) |
| standalone product (jev-decision-only API / TypeLLM brand book) | parked | extract-if-proven standalone path, FUTURE-STYLE-PROFILE | docs/FUTURE-STYLE-PROFILE.md |
| tometo steals (role-model split config, method-rules gap lines, playbook library) | parked | discussed only — no code, no doc | conversation notes |
| supermemory read (hot/warm/cold) | parked | research, dogfood window (one-pager open queue #5) | docs/ONE-PAGER.md |
| delegate tool | dropped | duplicate of pi-core-subagents — never committed (absent from history) | decision record |
| jev-guard | dropped | uninstalled (not in ~/.pi/agent/extensions); from_untrusted guards the recall channel independently | docs/ONE-PAGER.md env decisions |
| max-of-two re-grade | dropped | replaced by panel grading — its lean (absence must be evidenced by omission) preserved in the panel rationale | ext/panel.ts header |
| mailbox-parser add-failed mystery | dropped | CORRECTED: repo exists (/home/aurel/Documents/github/mailbox-parser) and is a registered worker; the add-failure was ~ path expansion, fixed 44a536c | 44a536c |
| guard upstream notes (origin study: jev-guard) | dropped | owner decision 2026-10-06: not for us, case closed | row retired |
| office-parser orch add | pending | one command: /majordome orch add /home/aurel/Documents/github/office-parser (repo exists, unregistered) | ~/.pi/majordome/orchestrator.json |

## Corrections to the 2026-10-05 session audit (verified before seeding)

- **sidecar watch mode**: the audit said "NO code" — wrong in the strict sense.
  A prototype exists (`durable-sidecar/sidecar.ts`, 26fde67, watch mode on
  pi-durable). The real drift: it is unwired — nothing in the shipped extension
  keeps artifacts fresh, and README.md line 61 claimed it in the present tense.
  Status stays parked; README reworded to planned; doctor's doc-drift gate
  (check 11) now catches exactly this class of lie.
- **quality trio commit**: the audit cited e413c2f — that is the ONE-PAGER
  ledger commit. The trio's docs commit is 8b5057b; implementations are
  6ba17a0 (from_untrusted), 2b2cb76 (lessons), 11ee775 (simplifyVerdict).
- **mailbox-parser**: the audit said "repo absent" — the repo exists at
  /home/aurel/Documents/github/mailbox-parser and is a registered worker in
  orchestrator.json. What dropped was the mystery: the add-failure root cause
  (~ path expansion) was fixed in 44a536c.
