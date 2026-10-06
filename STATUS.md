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
| docs/dev/FUTURE-STYLE-PROFILE.md | built | 3368e7e | docs/dev/FUTURE-STYLE-PROFILE.md |
| orchestrator deck/workers/inbox | built | 3fe5f4a (push half 6a886b8) | ext/orch.ts · ext/inbox.ts · tools/dispatch.ts |
| doc-drift gate in doctor + STATUS.md ledger | built | 2d01537 (the housekeeping commit above) | ext/docdrift.ts · ext/doctor.ts check 11 · STATUS.md |
| housekeeping routine (status-join in recall + doctor/housekeeping commands, safe-fix vs needs-yes) | built | 9df6d18 + this commit | ext/status.ts · ext/housekeep.ts · tools/doctor-cli.ts · index.ts (statusJoinTail + command registry) · ext/selfcheck.ts |
| sidecar watch mode | parked | prototype only: 26fde67 durable-sidecar/sidecar.ts (pi-durable watch mode) — NOT wired into ext/ or tools/; README shipped-claim drift caught by doctor and reworded to planned | durable-sidecar/ (unwired prototype) |
| Concept Cells | parked | named cbd3b30 — gated on organic graph maturity | docs/OVERVIEW.md |
| per-task worktrees for orch workers | parked | firstmate pattern note only — never built | docs/dev/DESIGN.md layering section |
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
| docs/ROLES.md roles + communication charter (revised: integration pass — room dropped, loops corrected) | built | 1227a67 | origin study: codync rooms/team-MCP + firstmate pyramid; R1-R10 |
| STATUS.md as ingest-docs source (docs-watch half shipped in 881bb8e) | pending | ledger facts enter memory | ingest-docs sources config |
| guard upstream notes (origin study: jev-guard) | dropped | owner decision 2026-10-06: not for us, case closed | row retired |
| docs command naming consolidation (docs gen/pull) | pending | gap surfaced by ROLES charter §gaps #4 | replaces docs <kind> vs ingest-docs |
| AGENTS.md (this repo) + docs taxonomy (docs/dev/, bench/ eval plans) + code-parser parked-dependency bullet | built | 035231b | ROLES.md v2 five-rule charter same commit |
| init AGENTS.md scaffold/augment flow (absent → propose template, present → gap-report ask-first) | built | 881bb8e | captain approved 2026-10-06 | extends ext/agentsmd.ts |
| STATUS.md docs-watch built-in (nudge trigger) | built | 881bb8e | captain approved 2026-10-06 | ext/docsprofile.ts micro-slice |
| scheduled housekeeping run (cheap dreaming: scheduler → doctor-cli housekeeping --brief → inbox) | pending | cognition dreaming study 2026-10-06 — effort S, impact M; promote when house >5 repos or first missed-consolidation incident | tools/doctor-cli.ts brief mode + scheduler install |
| swarm measurement-discipline rule (one shared bench script per research swarm) | pending | cognition swarm study 2026-10-06 — effort XS, impact latent until first research swarm | ROLES.md patterns line |
| proposals lifecycle (.majordome/proposals/ — OKF metadata state, butler-stamped, advisory staleness) | built | fcc8519 + declined-rejected fix | ext/proposals.ts spec header; README §Proposals |
| sqlite storage engine — one DB per repo + one global (blocks/trails/proposals tables; FTS5 replaces vocab index) | pending | leviathan study 2026-10-06 + pi-durable openNodeSqliteStorage; triggers: writer contention / house >5 repos / index rewrite | store.ts contract swap; steal: indexed-token single-match, BM25×boosts, atomic swap, safe FTS5 expressions |
| orch add: eager init at link time (currently lazy — first worker start) | pending | captain request 2026-10-06 — mechanism exists, delta is timing | orch.ts add → headless initRepo; offers land as pending proposals |
| pre-push mechanical gate (.githooks/pre-push — selfcheck+docsbench block red pushes) | built | this commit | jev-guard shape, deterministic checks, no classifier; installed via core.hooksPath |
| office-parser orch add (worker registration) | built | global: orchestrator.json 2026-10-06 — 4th worker, path verified | lazy-init on first start |

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
