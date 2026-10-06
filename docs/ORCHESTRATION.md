# Multi-repo orchestration

How to run majordome as a coordinator across many repos — switching freely,
working in one repo while updating others, without routing confusion.

## The three planes

Everything stays un-messy because three concerns never share a channel:

| plane | where it runs | how it is addressed |
|---|---|---|
| **command** — status, start, add/remove workers, reports | any session (the brain is global: `~/.pi/majordome`) | explicit commands (`/majordome orch …`) |
| **work** — code edits, decisions, docs | per-repo worker sessions (their own cwd + AGENTS.md) | their own session, their own repo |
| **memory** — recall | every session, automatically | slug-scoped, labeled, lifecycle-filtered |

Coordination commands are **cwd-independent**: you can run `/majordome orch
add /abs/path` and `/majordome` from an empty deck directory, from
code-parser, from anywhere — one house, one ledger. The empty-deck style is a
*purity* recommendation (a session that only commands keeps roles clean), not
a requirement. Light coordination from a working repo session is normal use.

## Workers

```
/majordome orch add /abs/path/to/repo    # register (once per repo)
/majordome                               # start all + per-worker report
/majordome orch 3                        # start worker #3
/majordome orch status                   # what is running, where
```

- Workers **self-init** on first start ("majordome init complete: +N blocks…").
- Completed workers push a notice to the **deck inbox**; `/majordome one-pager`
  composes the cross-repo status doc.
- A **sidecar** in watch mode keeping each registered repo's artifacts fresh is
  planned, not yet built (prototype only, unwired, in `durable-sidecar/`; see
  STATUS.md).
- The brain is global; per-repo state is only the worker's own checkout. All
  blocks carry their repo slug (`code-parser:118`, `mailbox-parser:9`).

## @slug — addressing a repo explicitly

Append `@slug` to a query to hard-scope recall to that repo's blocks:

```
@office-parser what did we decide about the export loop?
@majordome which recall gates are pre-registered?
```

- **Hard scope**: only the named repo's blocks are eligible — scope priors,
  cross-repo bleed and noise specimens are gone. Multiple `@a @b` = union.
- Lifecycle and intent scopes still apply on top (`@code-parser what did we
  try that failed?` scopes to code-parser *and* surfaces failed records).
- Unknown slugs are ignored (treated as plain text) — the feature can never
  misfire on prose that happens to contain `@`.
- In the orchestrator, slugs address workers too: `/majordome orch @office-parser`
  ≡ `/majordome orch 3`. Unknown slug → a clear not-found listing known slugs.

Without `@slug`, nothing changes: natural repo mentions in your query already
act as strong retrieval anchors (the intent judge + scope priors rank the
named repo first), and current-session blocks keep their prior boost.

## What routes automatically — and what never does

- **Recall routing is automatic.** Every query is judged (intent + search
  terms), scoped (lifecycle + priors), and matched (dims cosine + BM25). Repo
  names in prose, `@slug` for determinism.
- **Dispatch is deliberately manual.** Starting or steering a worker is an
  explicit command, never inferred from a judged query — actions need
  authorization, not confidence. A misread "office-parser update?" can recall
  office-parser memory; it will never *start* office-parser.

This split is the anti-mess invariant: memory may route on inference; the
command plane never does.

## Switching repos in conversation

Because recall is slug-scoped and labeled (`[majordome recall · <slug>
turns N–M · date] …`), you can interleave repos in one session — ask about
mailbox-parser, then code-parser — and every injected block says which repo
it came from. Add `@slug` when you want zero ambiguity; omit it and let the
routers rank.
