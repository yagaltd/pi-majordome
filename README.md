# pi-majordome

Topic-scoped, cross-session memory for pi agents — with a lifecycle. Sessions
are indexed into gist'd blocks as you work; the right past context is recalled
into new sessions when the query calls for it; consolidation keeps memory
honest (valid · superseded · failed · speculative); and the orchestrator runs
a house of project workers from one deck. Cache-safe by construction: memory
injects tail-only, never wrecking the provider's prompt cache.

Every gate is measured: [Benchmarks](#benchmarks) — 10 pre-registered gates,
both mechanism and retrieval quality, at two scales.

## Install

```bash
pi install /path/to/pi-majordome     # or: pi --extension ./index.ts for dev
```

That's it — sessions self-bootstrap (session_start reloads the index; open
tails close on the next turn_end). Nothing per-session, ever.

**Optional — judge tiers** (all automatic, detected per session). Setup:

```bash
npx tsx ext/judges.ts setup     # interactive: paste your TypeLLM API key
npx tsx ext/judges.ts verify    # one typed call proving key + transport
```

`setup` writes the key to `~/.config/pi-majordome/typellm.key` (create the
file yourself if you prefer; `TYPELLM_API_KEY` also works as an env var, and
`MAJORDOME_KEY_FILE` overrides the path). Jev needs no setup — it rides pi's
classifier registry (`TYPESAFE_API_KEY` or `/login`). Gist fallback uses your
own chat model — zero extra keys.

**Optional — backfill history**: `npx tsx tools/backfill.ts` ingests past
sessions once; or let a repo's first worker start run `/majordome init` cold.

## Usage

### AGENTS.md adoption

Init detects your AGENTS.md and reports gaps in one line (greenfield vs
brownfield, Lessons section, testing rules, no-compat rule for greenfield) —
advisory only; AGENTS.md is indexed as knowledge and stays yours to write.

### The orchestrator (the daily command)

Run a house of project workers from one deck directory — or from any repo;
the brain is global, so coordination commands work from anywhere. You can
work in code-parser while updating mailbox-parser and office-parser in the
same session: recall is slug-scoped and every injected block is labeled with
its repo. Full guide: [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md).

```bash
/majordome orch add /abs/path/to/repo   # register a worker (once per repo)
/majordome                              # start all workers + per-worker report
```

Each worker completion passes a **simplifyVerdict** judge (once per run, suggest-only): a `simplify hint: …` lands in the report when a simpler shape exists — delete/merge/inline. Workers self-init cold ("majordome init complete: +N blocks…"), push completion
notices to the deck inbox, and everything lands in one global brain
(`~/.pi/majordome`) — never per-repo state. Planned, not yet built: a sidecar
in watch mode that keeps each repo's artifacts fresh (prototype only, unwired,
in `durable-sidecar/`; see [status.json](status.json)).

### Commands

```
/majordome                  run the house (start all workers + report)
/majordome orch             menu: start one/all, add /path, remove, status
/majordome status          ledger view (status.json) · @slug detail · --export md
/majordome user            preferences (user.json) · set <key> <value> · reset
/majordome map              reasoning/topic map (termaid for a pane view)
/majordome init             cold-start/backfill memory for this repo (then consolidates)
/majordome doctor           audit: orphans, parse health, dims coverage, index lag, lifecycle distribution
/majordome dash             dashboard: state, judges, projects, routing log (✓ injected ✗ suppressed)
/majordome list [tag]       table ToC: ID · TURNS · INTENT · GIST (ids short: code-parser:118)
/majordome show <id>        block record: gist, dims, status, transcript pointer
/majordome forget <id|tag|all>          purge from the index; session JSONLs untouched
/majordome export <id|tag|all> [dir]    markdown ADR per block
/majordome reindex [all]    rebuild from session files (backfills gists + dims)
/majordome docs <kind>      doc generation (readme | changelog | adr | <custom>)
/majordome stats | log      score-gap calibration · decision log
/majordome judge off|soft|strict    ambiguity-judge mode (soft = default)
/majordome on | off         kill switch
/majordome help             this list, in-chat
```

### How memory behaves

- **Recall**: blocks are judged into topic dims at close; your query is
  distilled into search terms and judged into the same dims space — cosine for
  semantics, BM25 for exact terms, federated per-project top-3 for coverage.
  Hits inject tail-only (`[majordome recall · repo turns N–M · date] gist…
  Read your request as: …`). Strong recall on definition work adds "resume
  rather than redoing it".
- **Provenance & lessons**: blocks from ingested/shared sources carry
  `from_untrusted` and their recall lines say `· unverified source`. Mistakes
  and lessons are a first-class index class (`lesson` blocks): boosted on
  lesson/failure queries, merged by consolidation ("same mistake twice" is the
  pair-judge).
- **@slug scoping**: prefix a query with `@repo-slug` to hard-scope recall to
  that repo (`@office-parser what did we decide about the export loop?`) —
  overrides priors, kills cross-repo noise; lifecycle and intent scopes still
  apply. Also addresses orchestrator workers (`orch @slug`). Natural repo
  mentions in prose already anchor retrieval — `@slug` is the explicit,
  deterministic form. See docs/ORCHESTRATION.md.
- **Lifecycle (v2.4)**: consolidation assigns `valid / superseded / failed /
  speculative` via pair judges (contradiction → superseded; tried-and-failed →
  failed). Default recall excludes dead blocks; "what did we try that failed?"
  surfaces failed records; temporal queries ("what did we use before X?")
  surface superseded ones. `/majordome doctor` reports the distribution.
- **Contradiction check**: a strong hit that REVERSES a recalled decision
  tells the agent to confirm before acting.
- **Personal tier**: `~/.pi/majordome/user.json` — structured preferences
  (`answer_shape`, key/value pairs via `/majordome user set <key> <value>`,
  rendered by `/majordome user`) plus `user.md` prose rules; both inject as
  standing context, user.json lines first.
- **Judge modes**: the per-turn ambiguity judge is deliberately context-blind;
  soft mode (default) advises, strict orders clarify-first. Messages pointing
  at inspectable artifacts (URL, path, repo, error output) are never flagged.
- **Interface**: Majordome never talks to the user — the agent stays the
  interface; tone lives in your `AGENTS.md`.

### Recall feedback (the self-improving loop)

Injected blocks are tracked: `stats` shows a recall precision proxy
(referenced-within-3-turns) and the false-positive specimen corpus
(`bench/false_positives.json`, bucketed wrong-repo / stale / polysemy /
weak-match). Specimens become bench probes — fixes stay fixed.

### Output shape (v2.6)

A pre-turn judge reads your message (+ your user.json/user.md preferences) and, when a
non-default shape serves better, injects one suggest-only line to the agent:
`[majordome shape] diagram-first — lead with the graph; prose short. Keep every
fact.` The ladder: `terse · diagram-first · table · walkthrough · artifact`
(the Karpathy ladder as a routing table). Fail-open to default = zero lines,
zero behavior change. Never invokes tools; never orders the agent. Measured by
`tools/shapebench.ts`: 100% gold-shape accuracy live, fact retention ≥ default
(median 112%), **−24% mean output tokens** shaped vs default — with caveman
text as the baked-in negative control the metrics must catch.

### Docs generation

```
/majordome docs                          kinds + usage
/majordome docs readme [tag|all] [show]  digest since README cursor → agent updates README
/majordome docs adr [tag|all]            per-block ADRs (same as export)
/majordome docs <custom> …               your template from ~/.pi/majordome/templates/
```

**Adoption is brownfield-safe**: init seeds per-repo doc cursors from the
real file/git dates of your existing README/CHANGELOG/docs — nudges only fire
for drift *after* adoption, never for history that predates majordome. A
**docs profile** decides which docs are watched per repo: code markers →
README + CHANGELOG + docs/ (coding default); no code markers → docs/ only
(generic). Override anything with `.majordome/docs.json`:
`{"watch": ["README", "CHANGELOG", "docs/", "NOTES"]}`.

**Nudges are value-driven (v2)**: a per-turn `docsVerdict` judge decides
whether the turn's work adds doc-worthy value — and which kind
(readme/changelog/adr). Verdict-driven when judges are configured; the
arithmetic 3-block fallback applies only offline. Cursors are per-repo
(`slug:doc`) — a docs touch in one repo never advances another's.

Digests are doc-worthy blocks **since that doc's cursor** — the exact
undocumented work, traceable to a block. Generated docs are stamped
`generated_by: majordome`; `verified:` is human-only.

## Systems (October 2026)

The consolidation-era build, one line each (full context in
[docs/OVERVIEW.md](docs/OVERVIEW.md) + the changelog):

- **Decision-block store** — the ledger is a fold of `blocks.jsonl`
  (kind=decision, append-only, latest-wins); `STATUS.md` is a generated
  export, never hand-edited. `/majordome status [--export md]`.
- **Ledger views** — boxed table with topic grouping (families collapse in
  pending/parked; built/dropped stay packed), full width; `ledger house`
  (all repos) · `ledger @slug` (one worker repo).
- **Proposals pipeline** — idea → ledger row → on-demand triage → proposal →
  captain decision → build. `proposal list · show · decide · add`;
  `triage <idea>` judges one idea (batched judging was reverted: per-row
  focus beats throughput for captain-facing calls). Legacy `.md` proposals
  migrate once, idempotent.
- **Verbatim recall surface** — `verbatim:` lines cite `trail:N` originals
  (append-only = stable citations) alongside the labeled block lines.
- **Compaction hook** — pi `compaction_end` triggers consolidation refresh +
  housekeeping report (report-only; fixes still need your yes).
- **Correction canary + soft wall** — deterministic pushback tokens; ≥2
  correction turns in 3 → the next response opens with a check-in.
  Corrections SCORE agent quality (they are the precision proxy's ground
  truth) — they never rewrite `user.md`; shape-preference pushbacks move
  through proposals.
- **Judge credit + tool credit** — degraded judges surface once in the UI
  and clear on recovery; `stats` shows judge fail-open rates and tool-time
  windows (pi ≥ 1.1.0 `durationMs`).
- **Karpathy rung ladder (shape route)** — prose is rung 1; diagrams reserved
  for genuinely structural content; v0.6.6 probabilities add a mechanical
  confidence <0.6 → default downgrade.
- **docs naming + bulk door** — bare `docs gen` surveys the watched docs
  (cursor age, pending blocks) and builds all stale ones in one pass
  (single digest, single agent instruction); `docs gen <kind>` per-doc;
  `docs pull` ingests; legacy bare forms are unlisted aliases.
- **cross-repo docs attribution** — `dominantRepo` stamps implementation
  blocks with the WORK's repo (path votes, git-root canonicalized) and the
  docsVerdict judges against that repo: majordome features built from any
  session are majordome-docs-worthy by construction — the nudge fires for
  the repo the work belongs to, not the session's.

- **docs naming** — `docs gen <kind>` composes, `docs pull` ingests; the
  legacy bare forms are unlisted aliases.

## Benchmarks

`lifecyclebench` (see [bench/README.md](bench/README.md)) gates every change to
the memory lifecycle and recall pipeline with pre-registered bars. Current
results on master — verified by running `npx tsx tools/lifecyclebench.ts`:

| gate | bar | small tier (18 blocks) | scale tier (759 blocks) |
|---|---|---|---|
| state accuracy / class | ≥90% | **100%** (valid · superseded · failed · speculative) | 100% |
| false demotions | 0 | **0** | 0 |
| supersession pair recall | ≥80% | **100%** (4/4) | 100% |
| default-recall leak | ≤10% | **0%** | 0% |
| IR Recall@5 / @10 | ≥0.80 / ≥0.70 | **0.972** | R@10 **1.000** |
| IR MRR | ≥0.60 | **0.894** | 0.873 |
| IR nDCG@10 | ≥0.70 | **0.925** | 0.910 |
| temporal (old refs surfaced) | 100% | **4/4** | — |
| aggregation (both refs top-5) | 100% | **3/3** | — |
| abstention (false hits) | 0 | **0** (4 absent-topic probes) | — |

Live judge-graded gates use **panel grading** (majority of available engines,
`ext/panel.ts`) — one drifting judge can't flip a gate; single-grader runs are
marked variance-prone. Gate (f) verified stable at 100% across consecutive
live runs (was: 112→89→95% flake on identical code). Runtime ≈2.6s for both
tiers. The bench found and fixed a real recall bug
(score-0 winners — now the evidence floor in `route()`). Machine-readable:
`bench/results/lifecyclebench-last.json`.

## Development

### Layout

```
index.ts                  extension entry (chat commands, session hooks, injection)
status.json               deliverable status ledger — {updated, rows: item·status·evidence·substrate}; STATUS.md is a generated export
ext/store.ts              JSONL store: blocks, meta, vocab, lifecycle sidecar
ext/core.ts               retrieval primitives (BM25 binary-tf, cosine, federation)
ext/router.ts             intent → arm routing, scopeByLifecycle, evidence floor
ext/consolidate.ts        v2.4 lifecycle pass (pair judges → block.status)
ext/judges.ts             TypeLLM/Jev judge seam (fail-open) + setup/verify CLI
ext/{init,orch,inbox,doctor,trail,codex,docs,ingest_docs,onepager,map,selfcheck}.ts
tools/                    backfill, lifecyclebench v2, fixture generator, probes
bench/                    offline study harness (eval.py …) + lifecycle fixtures
docs/                     product docs · docs/dev/ (research, design) · bench/ (eval plans)
```

### Offline tier (study harness, no API key)

The retrieval design was validated slice-by-slice with a hand-labeled
reference session — commands preserved verbatim:

```bash
python3 bench/eval.py --session ~/.pi/agent/sessions/<project>/<session>.jsonl
python3 bench/eval.py --session <session.jsonl> --classify   # + TypeLLM tier
```

`bench/key.json` is the ground truth (6 blocks, 5 probes); results land in
`bench/results/report.json`. Design trace: bench/EVAL-SLICE{1..5}.md (with their harnesses),
docs/dev/JUDGE-COMPARISON.md. Headline from the study: DAG intent → specialist
arm reaches 3/7 recall@1 over the cross-session suite, past every single arm
and naive fusion (2/7).

### Checks

```bash
npx tsx ext/selfcheck.ts [--parity]   # assertions (+ bench replay parity)
npx tsx tools/lifecyclebench.ts       # the 10-gate harness, both tiers
```

### Known behaviors

- **min-size guard**: a topic switch needs 4+ turns since the last boundary —
  closes may lag; nothing is lost, the next boundary picks it up.
- **dims can fail open empty** (degenerate-vector guard) — blocks still index
  with gist + lex retrieval; dims backfill on `reindex`.
- **`[object Object]` sightings are NOT lost messages**: user text is always
  persisted intact — the string appears only in model-facing request
  transforms. `grep '"role":"user"' <session>.jsonl` is the truth on disk.
- `reindex all` sweeps every session on disk — expect judge calls per block.
- **Judge configs** (per session, automatic): TypeLLM key enables the DAG
  path (intent + search-term rewrite); Jev rides pi's classifier registry;
  gist fallback uses your chat model at block close. `MAJORDOME_MIN_SCORE`
  (default 0.6) tunes the injection noise gate.

### Proposals

Agents that lack permission to act leave a **proposal** instead:
`.majordome/proposals/YYYY-MM-DD-<kind>.md` — plain markdown, `key: value`
header (`kind`, `status: pending|approved|rejected`, `added`, `source`;
decision adds `decided`, `by`, `reason`). Flat folder, state in metadata, the
file never moves; body edits are append-only (`revised:`). Decisions are
stamped by the butler and mirrored into status.json; housekeeping lists pending
and stale (>7d) proposals — it never decides. An explicit UI decline is a
decision: recorded rejected, not pending. Spec: `ext/proposals.ts` header.

## Status

- **Shipped (v2.x)**: lifecycle states + consolidation (v2.4, bench-gated),
  orchestrator (deck / workers / inbox), evidence floor
  in recall, personal tier (`user.json` + `user.md` prose), visibility scopes (repo · user ·
  shared), doctor audits, lifecyclebench v2 (IR metrics + LongMemEval
  abilities + scale tier).
- **Next (consolidation era)**: organic supersession pairs from the dogfood
  stretch feed v2.4 consolidation; recall-scope maturation; sidecar watch
  mode (planned — prototype unwired in `durable-sidecar/`, not yet built);
  see docs/OVERVIEW.md.

### Governance

- **Judge-cost telemetry** — every judge call trails (including fail-opens);
  `/majordome stats` aggregates the trail: calls, ok/fail-open split, calls per
  turn (last 100), est. tokens where the engine reports usage. Doctor notes
  judge creep (>3 calls/turn avg). Gap rule: an untrailed judge site fails
  selfcheck.
- **Judgment trail** — every judge verdict appends to
  `~/.pi/majordome/trails.jsonl` (never message text); consumed by
  calibration and future audits. Override: `MAJORDOME_TRAIL_FILE`. Fail-open.
- **Push codex** — `~/.pi/majordome/codex.md`, the invariants file
  (search-before-write, append-only record, never index raw messages, soft
  judges, fail-open, `verified:` is human-only). Shipped on first run; edit
  to make it yours — never overwritten.
- **Doc stamps** — `generated_by` + `generated_at` + `stale_after` (+30d).
