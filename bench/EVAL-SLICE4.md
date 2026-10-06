added: 2026-10-06
source: slice eval program
status: executed
harness: bench/eval.py

# Slice-Four Eval — cross-session index, time-travel probes, communities

Date: 2026-09-28 · Sessions: A = code-parser reference (105 turns, 6 gold
blocks) · B = MorphEditor 2026-09-06 (763 turns, 8 coarse ranges, gisted).
Harness: `bench/cross_eval.py` (`--rewrite --federate`), key `bench/key_cross.json`.

## What was built

- **Two-session block index**: 14 blocks, each with gist + intent + hybrid
  token field. B's gists are coherent at range granularity even with coarse
  gold (readable ToC across a 763-turn product session).
- **Time-travel probes**: `asked_at` constraint — a live router sees only
  blocks *fully formed before* the question; the current block is excluded
  (it's in context → continuation, not retrieval).
- **Federated pooling**: per-session top-3, rank-interleaved — counters
  single-project vocabulary swamping a cross-session pool.
- **Community sweep**: connected components over hybrid-Jaccard edges
  (Leiden-lite; deterministic, no deps).

## Results

| probe | global bm25 | +rewrite | +federated |
|---|---|---|---|
| A-verbatim-94 (time-travel, 4 cands) | 4/4 | 4/4 | **1/4** |
| A-verbatim-52 @T=52 | — correctly classified as continuation → no retrieval — | | |
| A-para-routing | 4/14 | 4/14 | 3/14 |
| X-morph-calendar (cross) | 14/14 | 14/14 | **2/14** |
| X-routing (cross) | 4/14 | 4/14 | 3/14 |
| X-typellm-key (cross) | 3/14 | 3/14 | −1 (target outside pooled top-3) |
| X-morph-subagents (cross) | 12/14 | 12/14 | −1 (same) |

Communities: τ=0.25 → 7 components; τ=0.3 → 10. Structure at τ=0.3: **A
splits into 6 singletons — exactly its 6 gold topics; B stays one blob**
(same product all day). No cross-session joins at any lexical τ.

## Findings

1. **Time-travel + federated compose into success.** The verbatim routing
   probe — stuck at rank 3–4 for three slices — hits **rank 1** once the
   router (a) sees only past-formed blocks and (b) pools per session. The
   two mechanisms fix two different failures: anachronism and pool dilution.
2. **Continuation detection works**: the T=52 probe correctly resolves to
   "expected block is current → no retrieval". The intent gate is doing its
   job.
3. **At 763-turn scale, topics are not contiguous ranges.** The calendar
   topic spans four B ranges; "subagents" sprawls across three. Two of the
   cross "misses" are gold-label artifacts — the retrieval surfaced *parts*
   of the right scattered topic. Retrieval unit at this scale should be the
   **community/fragment set, not the range**.
4. **Lexical communities separate sessions perfectly but never join them**:
   A's six blocks are six singletons (topic-distinct), B is one product blob,
   and cross-session same-theme pairs (codemap routing ↔ Morph subagent
   dispatch) never reach Jaccard 0.25. **Cross-session linking requires the
   semantic pair-cell edges from the design doc** — lexical edges won't do it.
5. Federated pooling trades coverage for precision: targets outside a
   session's top-3 become unreachable (−1). Fallback: run unfederated when
   federated confidence is low, or widen top-k.

## Router spec v3 (converged)

```
query → intent (continue / switch / recall)
      → continue: nothing
      → switch (same session): hybrid BM25, past-only candidates,
        exclude current block
      → recall (any session): rewrite → federated per-session top-k →
        RRF merge → (slice-five) pair-cell semantic filter on top hits
      → inject winner ToC entry at tail
```

## Slice-five

1. **Semantic pair-cell edges** (`same_topic?` on high-similarity-pair
   candidates) to link cross-session fragments into communities.
2. **Community-as-retrieval-unit** ranking (score communities, then pick
   representative blocks inside the winner).
3. Federated confidence fallback + top-k widening.
4. Live end-to-end: the router as a pi extension, replayed on this session.
