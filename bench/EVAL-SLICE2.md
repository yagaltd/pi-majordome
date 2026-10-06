added: 2026-10-06
source: slice eval program
status: executed
harness: bench/eval.py

# Slice-Two Eval — hybrid retrieval, EMA boundaries, artifact dims, recency

Date: 2026-09-28 · Same session and key as slice-one · Adds: hybrid token
field (user turns + last-3 turns + gist), `ema` boundary strategy, recency
tiebreak, v2 artifact/activity dims, and a **null-guard fix** in the TypeLLM
client (silent zero-filling was poisoning vectors — see findings).

## Changes under test

1. **Hybrid retrieval field** — rank against `user-turn tokens ∪ last-3-turn
   tokens ∪ gist tokens` instead of the whole-block union (dense intent
   statements + recent context, no 45-turn dilution).
2. **EMA boundaries** — decaying running token set (decay 0.85, keep 0.3)
   instead of a hard centroid.
3. **v2 dims** — artifact/activity hybrid (`watcher_bench_infra`,
   `edit_override_decider`, `classifier_key_setup`, `model_routing_evals`,
   `docs_pii_audit`, `context_memory_design`), replacing session-topic dims.
4. **Recency tiebreak** — `score += 0.05 * (block_pos / n)`.

## Results (recall over the 5 gold-block probes)

| method | slice-1 | slice-2 |
|---|---|---|
| jaccard union | 0/5 @1 | 0/5 @1 |
| bm25 union | 0/5 @1, 4/5 @2 | 0/5 @1, **4/5 @2** |
| **jaccard hybrid** | — | 1/5 @1 |
| **bm25 hybrid** | — | **2/5 @1**, 3/5 @2 |
| bm25 hybrid + recency | — | 2/5 @1 (no change) |
| cosine v1 dims | 1/5 @1 | 1/5 @1 (clean re-run) |
| cosine v2 dims | — | 0/5 @1, 3/5 @2 |
| clustering accuracy (centroid) | 0.755 | 0.757 |
| clustering accuracy (**ema**) | — | **0.903** |

Probe detail for bm25_hybrid: para-crash **6→1**, verbatim-52 **→1**; the two
routing probes hold at rank 2–3 and para-typellm-key at 3.

## Findings

1. **Hybrid BM25 wins and is free.** recall@1 0/5 → 2/5 with no new model
   calls. The mechanism is visible per-probe: user-turn text carries the
   block's core vocabulary ("crashed", "watcher", "different versions"),
   which whole-block unions dilute.
2. **EMA doubles clustering accuracy (0.757 → 0.903)** by over-splitting
   (14 blocks vs 6 gold). For the product that's the right trade: blocks are
   ToC entries, over-segments merge later via Leiden; mis-clustered *turns*
   are the unrecoverable error.
3. **The vector tier did not survive honest measurement.** v2 dims score
   *worse* than v1 (0/5 vs 1/5 @1), and the diagnosis deepened: the verbatim
   routing probe returns an all-0.0 query vector — reproducibly, not as an
   API failure. The model judges *meta-phrased* queries ("make a summary of
   what codemap does for routing…") as about no content dimension at all.
   Meta-phrasing is exactly recall intent — **the vector path fails precisely
   on the product's main query class.**
4. **Dims are filters, not rankers.** Gists + intents remain excellent (ToC);
   dims remain useful as coarse intent/features; ranking belongs to lexical
   hybrid over gist + tail.
5. Recency at 0.05 changed nothing (ties aren't the failure mode here).

## Design consequences

- Router = **hybrid BM25 (gist + user turns + tail) primary**; vectors
  demoted to optional filter/signal; TypeLLM's per-query call is spent on
  intent classification (continue / switch / recall), not on query vectors.
- Live-routing rule surfaced by the misses: **exclude the current topic block
  from candidates** — it's already in context, and it is the contaminator
  (the brainstorm block discusses routing better than the routing block
  discusses itself). With exclusion, the routing probes move 3→2, still not
  top — consistent with rank-fusion being the next step.
- Null-guard stays: number-typed questions return nulls intermittently; never
  zero-fill silently.

## Slice-three hypotheses

1. **RRF fusion** of bm25_hybrid + gist-vector + pair-cell signals (fusion
   may rescue what any single signal misses).
2. **Dim induction from community keywords** — auto-derive dims per community
   instead of hand-designing them (removes the design failure mode).
3. **Recall-intent query rewrites**: one TypeLLM call rewrites a meta query
   into content terms before any lexical/vector scoring (directly attacks
   finding 3).
4. Multi-session index: repeat the pipeline over 2–3 session dirs, community
   graph across sessions (Leiden on Jaccard + pair-cell edges).

## Reproduce

```sh
python3 bench/eval.py --session <session.jsonl> --recency 0.05            # offline tier
python3 bench/eval.py --session <session.jsonl> --strategy ema            # EMA boundaries
python3 bench/eval.py --session <session.jsonl> --classify --dimset v2    # vector tier
```
