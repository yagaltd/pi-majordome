# AGENTS.md — pi-majordome

Constraints, not a checklist. When two rules conflict, choose the option with
the lowest long-term cost for this repository and note it in the commit.
Adapted from the code-parser standard (proven); majordome-specific rules where
the domain differs.

## Design Principles

- **Separation of concerns**: domain logic, persistence, presentation, and
  routing stay separated. One concern per file; the name says which.
- **Encapsulation**: expose public contracts only; modules talk through
  exported functions.
- **Cohesion / low coupling**: one behavior change touches as few modules as
  possible.
- **DRY**: search before writing logic; one home per rule, constant, format, or
  schema fact. Do not abstract coincidental similarity.
- **KISS / YAGNI**: simplest working shape; functions over classes; no
  speculative hooks or flags. Abstraction only after a pattern repeats twice.
- **Depend on contracts**: core logic takes and returns plain values; no
  framework or UI types in core.
- Fail fast, optimize for deletion, prefer boring tech.

## Hard Invariants

1. **One owning module per domain** — recall, consolidation, docs, orch,
   judges, status each have one home (`ext/`). Everyone else calls it.
2. **Never duplicate logic** — second use: move to a shared place, update
   callers with tests green, then add the new use. Behavior changes are
   separate commits.
3. **No business logic in rendering or UI layers** — views and command output
   wire values; they never compute rules.

## Structure & Placement

- Repo root: `README.md` (product truth) · `CHANGELOG.md` (append-only
  history) · `STATUS.md` (deliverable ledger — butler-owned; reports propose,
  the butler disposes).
- `docs/` — **product documentation only** (OVERVIEW, ORCHESTRATION, ROLES,
  ONE-PAGER).
- `docs/dev/` — **research and design**: studies, design ledgers, future
  profiles. Never product claims.
- `bench/` — **all evaluation**: harnesses, eval-plan docs, fixtures, keys,
  results. Eval plans live with their runners, indexed by `bench/README.md`.
- `ext/` — extension modules. `tools/` — CLIs and bench runners. Checks live
  in `ext/selfcheck.ts`; repos under test stay hermetic (never the real
  `~/.pi/majordome`).
- New files go next to similar code. Never a new top-level directory without
  proposing it first.

## How to Work

- **Refactor first, then change** — behavior-preserving refactor (tests green)
  to make room, then the change; never both in one unverifiable diff.
- **Parked dependencies invalidate dependents** — when a planned mechanism
  parks or drops, every documented behavior that relied on it is re-decided and
  re-documented in the same change: wire it, or document the fallback as the
  trigger (manual is a trigger when it is documented as one).
- **Gates, not promises** — every claim is enforceable by a selfcheck/bench
  check where possible; a prompt alone is not enough.
- **Plan non-trivial work** — >~80–100 lines or >1–2 files: short plan of
  modules/files first.
- **Verify before push, gates before commit** — never chain a gate and a push
  in one command; a red gate stops the chain.

## The House

- `docs/ROLES.md` is the communication charter: spawn flows down, artifacts
  flow up, no lateral channels; spawn = verify; specs down, artifacts up;
  gates end every loop; the dangerous class only the captain approves.
- `STATUS.md` rows are flipped only by the butler at land/drop. Worker and
  subagent reports may propose a row change; they never write one.
- Memory has one writer (consolidation); the ledger has one writer (the
  butler); docs carry `generated_by` stamps; `verified:` is human-only.

## Language Notes

- TypeScript / CodeNNL for `ext/` and `tools/`; keep modules small (~300–400
  lines soft limit); split at real responsibility boundaries only.
