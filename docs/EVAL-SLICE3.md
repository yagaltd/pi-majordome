# Slice-Three Eval — RRF fusion, query rewrites, dim induction

Date: 2026-09-28 · Same session/key · Implements the slice-two hypotheses:
reciprocal-rank fusion, recall-intent query rewriting, auto-induced dim
vocabulary. Vector re-verified under a null-guarded client (no silent zeros).

## Changes under test

1. **RRF fusion** — reciprocal-rank fusion (k=60) over the four lexical orders
   (jac/bm25 × union/hybrid).
2. **Query rewrites** — one TypeLLM call per probe: strip meta framing
   ("make a summary of…"), emit 5–12 content terms; rescore lexically.
3. **Dim induction** — each block names 4–6 discriminating snake_case
   features; union becomes a 24-dim vocabulary; blocks and queries scored on
   it (replaces hand-designed dims).

## Results (recall over 5 gold-block probes)

| method | recall@1 | recall@2 |
|---|---|---|
| bm25 hybrid (slice-two baseline) | **2/5** | 3/5 |
| rrf lexical (4 orders) | 1–2/5 | **4/5** |
| bm25 hybrid + rewrite | **2/5** | 2–4/5 |
| rrf over rewritten orders | 1/5 | 2–3/5 |
| cosine, induced 24 dims | **0/5** | **0/5** |
| cosine, hand v1 / v2 dims (slice-2) | 1/5 / 0/5 | 2/5 / 3/5 |

## Findings

1. **Rewrites work exactly as designed.** "make a short summary of what
   codemap does for routing…" → `codemap, routing, models, reasoning effort`
   — meta framing stripped, rank 3→2, and never hurt a probe. Adopt for all
   recall/switch intents.
2. **RRF is a stabilizer, not an unlock**: holds @2 at 4/5 and protects
   against single-method flakiness (observed rank shuffles between classify
   runs), but does not crack the routing probes' rank-1.
3. **The vector tier is dead — conclusively, and it's not the vocabulary.**
   Induction produced genuinely good names (`reasoning_effort`,
   `routing_mechanism`, `model_tiering`, `codemap_benchmarking`,
   `repo_inspection`), yet cosine scored 0/5 across the board: the judge
   inflates queries (para-routing scored 0.95 on *nine* dims — anything
   tangentially related gets "about"). Three feature designs — hand-picked
   topics, hand-picked artifacts, induced — all fail the same way. **Judgment
   probabilities about a block do not form a retrieval vector; block
   "aboutness" spreads, token evidence stays sharp.**
4. The remaining rank-2/3 ceiling on routing probes is structural: the
   contaminator is the *current-topic* block (the brainstorm discusses routing
   more densely than the routing block does). The live-routing rule —
   **exclude the current topic block from candidates** — remains the fix, to
   be validated on multi-session data (slice-four).

## Product router spec (converged after three slices)

```
query → TypeLLM intent call (continue / switch / recall)
      → if switch/recall: rewrite to content terms
      → hybrid BM25 (user turns + tail-3 + gist) primary, RRF with jac_hybrid
      → exclude current topic block from candidates
      → inject top block's ToC entry (gist + induced dims + pointers) at tail
      → dims/gists as ToC metadata and filters, never as ranking vectors
```

## Slice-four

1. Multi-session index (2–3 session dirs), Leiden communities across
   sessions on Jaccard + pair-cell edges.
2. Validate current-block exclusion on live-shaped probes.
3. Boundary quality at block level with Leiden merging of EMA over-segments.

## Reproduce

```sh
python3 bench/eval.py --session <s.jsonl> --recency 0.05                  # RRF
python3 bench/eval.py --session <s.jsonl> --rewrite --recency 0.05        # + rewrites
python3 bench/eval.py --session <s.jsonl> --classify --induce --rewrite --recency 0.05
```
