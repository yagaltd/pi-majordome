# pi-majordome — design ledger

Converged architecture for "infinite chat": topic-scoped, cross-session memory
for pi agents, cache-aware by construction. This document is the trace of the
design brainstorm; slice-one evidence lives in `EVAL-SLICE1.md`.

## The problem

A user chats with one agent across research, coding, project 1/2/3, jumping back
to old topics like with a human. Context windows fill; compaction summarizes
lossy; lost-in-the-middle degrades retrieval from a stuffed window. Existing
tools: pi-vcc (per-session tool-result masking, pull-only recall), operator-memory
(markdown docs, capture-not-retrieval), /tree (retry branches, not topics).

## Design laws (established during the brainstorm)

1. **Prefix caching geometry.** Provider caches are prefix-caches: change a byte
   at position N and everything after is a miss. Tail injection is free (the tail
   is uncached anyway); mid-slot mutation is expensive but *rare mutations are
   cheap*. A topic switch destroys the value of the cached prefix regardless —
   so switch-points are the natural place to pay a re-read. **Place
   invalidation, don't avoid it.**
2. **The session file is ground truth and is never rewritten.** The index is a
   side-car (`blocks.jsonl`); pi's `context` event transforms the prompt
   per-request and restores canonical state; `turn_end` chains `context_edit` /
   `compaction` and can continue a turn. Frontend-only, per session JSONL v3
   (entries have `parentId` — the tree already exists; we index it, not ride
   `/tree`).
3. **One judgment backend: TypeLLM.** Batched questions collapse what used to be
   tiers: one block-close request = dims + intent + gist. Jaccard stays for the
   free prefilter. (Named probability-vectors + cosine are validated by
   jevbeddings: 83.67% vs BM25 80.10% on BANKING77 — but slice-one shows the
   feature set matters more than the mechanism; see EVAL-SLICE1.)
4. **Three index levels, messages unindexed.** (Nested-call records do not
   touch the index: majordome reads user + assistant text, always present in
   full; bounded `nestedCalls` affect only detail recall — vcc's layer.) Turn (mechanical: token set,
   codemap effort verdict reused) → block (semantic: one TypeLLM call at
   block-close) → session (derived: dominant community; provenance only).
5. **Leiden forms the group layer mechanically.** Edges = Jaccard + sampled pair
   cells (`same_topic?`) on boundary-ambiguous pairs; labels derived after
   clustering. O(n²) pair cells never run globally — only within top-k hits.
6. **Salience: keep the job, drop the subsystem.** Between-block lifecycle is
   TypeLLM routing; within-block masking order is vcc's age cutoff (~80% of the
   job); rustlm's mechanical layer-1 formula (recency/reference/overlap) slots
   in later only if replay shows need.
7. **Fail-open, visible, governable.** No confident match → inject nothing.
   Status-line glyph for the active topic; `/memory` inspect/purge. Probability
   thresholds on every injection.

## Architecture

```
turn ends → Jaccard boundary check (free)
         → block closes → 1 batched TypeLLM call: dims + intent + gist
         → block joins Leiden community (Jaccard + sampled pair-cell edges)
         → community named (TypeLLM, on material growth)

new query → 1 TypeLLM call: intent (continue / switch / recall)
          → continue: nothing injected (cache-safe, zero cost)
          → switch/recall: Jaccard+vector over block centroids → pair cells
            on top-k → inject winner's ToC entry at tail
          → long session fills window: vcc cutoff masks old tool results
          → same topic wins N turns: promote block to stable mid-slot
```

## Layering (adjacent systems)

- `infinite-chat` (this repo): index + route + inject.
- `my-chats/` orchestrator (future): a generic session using the index as
  memory; firstmate (~/Documents/vibe/firstmate) supplies the patterns —
  agent-distro form (AGENTS.md + skills + scripts, no app), visible-pane
  dispatch, zero-token supervision, restart-proof disk state.
- firstmate itself: task-parallelism and worktrees, not memory — complementary,
  not a base.
- operator-memory: knowledge capture (what survives), not context routing
  (what's in-window now) — its docs can be indexed as blocks.

## Related work (all the user's)

- `~/Documents/vibe/jev/use-jev-as-vector.txt` — named vectors, pair cells
- `~/Documents/vibe/jev/jevbeddings` — BANKING77 study validating Jev+cosine
- `~/Documents/github/rustlm` — Jaccard+Leiden, salience KV eviction (owns the
  cache because it *is* the engine; KV −55%, perplexity improved). Its Layer-3
  (JSONL block archive → retrieve → inject) is the portable half.
- `~/Documents/vibe/operator-memory` — markdown memory school
- `pi-codemap` — the judgment-battery, side-car, tail-injection, status-glyph
  patterns this project reuses

## Decisions (post-slice-4, recorded 2026-09-28)

1. **pi-vcc stays a dependency, not integrated.** Different layers, compose
   by construction: vcc transforms requests (cache-stable masking of old
   tool results); majordome indexes the session file (ground truth) and
   injects ToC entries at the tail — context-role entries vcc never masks.
   Majordome fails open without vcc (pi compaction partially covers).
2. **Two judges, one seam (configurable).** TypeLLM: strings, choices, DAG
   chains, multimodal state (router pipeline = one chained DAG call: intent
   -> rewrite/target-hint). Jev (typesafe.ai): calibrated numbers — dims,
   pair-cell edges, confidence. Number-typed leaves inside a TypeLLM DAG
   route to Jev or are taken as strings and binned. Evidence:
   docs/JUDGE-COMPARISON.md. 100%-TypeLLM deployments are a config flip:
   non-thinking numbers proved stable (0.95x4, 0.6s) once the degenerate-
   vector guard is in — the client retries nulls AND all-0.0/all-1.0
   vectors (the observed flake: valid floats, zero discrimination; retried
   clean 4/4). Thinking stays per-field for hard reasoning fields; off for
   dim batteries (adds variance + 15x latency, A/B in JUDGE-COMPARISON).
3. **Specialists, not averages.** Intent class selects the ranking arm
   (definition/recall -> Jev vector; incident/token-specific -> lexical
   hybrid). Naive RRF of both scored 1/5 vs 2/5 for either specialist;
   CognitiveOS's weighted RRF is the merge mechanism once intent picks arms.
4. **Jev transport in the product** = pi's classifier registry
   (ctx.modelRegistry.classify(), TYPESAFE_API_KEY or /login) — same as
   pi-codemap. No /typesafe enable needed by end users; that bridge is
   study-session-only.
