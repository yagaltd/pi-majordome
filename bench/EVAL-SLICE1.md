# Slice-One Eval — session replay through the topic-memory indexer

Date: 2026-09-28 · Session: code-parser `01a0e6ec` (101 user turns, 4 compactions,
1 retried turn) · Key: `bench/key.json` (6 hand-labeled blocks, 5 probes)

## What it measures

1. **Boundary detection** — Jaccard token-set drift between turns (`centroid` vs
   `chained`), threshold swept, scored against hand-labeled boundaries (±1 turn).
2. **Clustering accuracy** — share of turns whose predicted block majority-label
   matches the gold label.
3. **Retrieval** — 5 probes (2 verbatim, 3 paraphrased) queried against GOLD
   blocks; rank of the expected block under Jaccard / BM25 / TypeLLM named-vector
   cosine. Gold segmentation isolates retrieval quality from boundary quality.

## Results

### Boundaries (centroid best)

| strategy | best F1 | τ | blocks found | clustering accuracy |
|---|---|---|---|---|
| centroid | **0.462** | 0.04 | 7 | 0.755 |
| chained | 0.364 | 0.04 | 5 | 0.637 |

Gold = 6 blocks. Boundary detection finds the coarse shape but drifts inside long
blocks (the 45-turn code-parser stretch gets split/merged imperfectly).

### Retrieval (ranks; 1 = expected block on top)

| probe | expect | jaccard | bm25 | cosine |
|---|---|---|---|---|
| verbatim-94 (routing summary) | routing | 4 | 3 | 6 |
| verbatim-52 (repo is a mess) | pi-codemap | 2 | 2 | **1** |
| para-routing (virtual model) | routing | 2 | **1** | 6 |
| para-typellm-key (key storage) | typellm | 3 | 2 | 2 |
| para-crash (mid-sweep crash) | code-parser | 6 | 2 | 5 |

Recall@1: jaccard 0/5 · bm25 0/5 · cosine 1/5. Recall@2: bm25 4/5 · cosine 2/5 ·
jaccard 1/5.

### What worked

- **The block-close call's gists and intents are excellent.** All six one-line
  summaries are accurate and human-readable — the ToC layer earns its keep as a
  summary, independent of retrieval.
- BM25 over block text reaches the right neighborhood (rank ≤ 2 on 4/5).

### What failed — and why (the actual finding)

The 7 session-topic dims do not discriminate. Block vectors show:

- the `routing` work block scores `pi_codemap=1.0, typellm=0.95, benchmarks=0.95`
  — its own `routing` dim is not in its top-3;
- `routing=0.95` appears on **three** different blocks, because routing was
  *discussed* in the consolidation, docs, and brainstorm segments too;
- five of six blocks score ≈1.0 on `pi_codemap` — the session was 95% about one
  project, so project-membership dims saturate.

Diagnosis: **topic dims encode what was talked about; blocks separate by what was
done and which artifacts were touched.** BANKING77 transferred worse than hoped:
its intents are short and mutually exclusive; multi-hour coding sessions are not.

## Slice-two hypotheses (in priority order)

1. **Hybrid scoring: BM25 over gist + tail turns, not whole-block unions.**
   The gist is dense and clean; unions-of-45-turns dilute Jaccard (see
   para-crash rank 6). Cheapest fix, no new dims.
2. **Artifact/activity dims** — files touched (`watcher.rs`, `models.json`,
   `README.md`), verbs (implement/audit/document). Coding sessions partition by
   artifact, not by topic noun.
3. **Recency tiebreak** in ranking (recent blocks win ties) — human recall is
   recency-biased.
4. Boundary drift inside long blocks: consider token-set EMA (decay) instead of
   hard centroid, or a TypeLLM boundary check on low-confidence drift only.

## Reproduce

```sh
python3 bench/eval.py \
  --session ~/.pi/agent/sessions/<dir>/<file>.jsonl \
  --classify          # adds TypeLLM tier (~11 calls)
```
