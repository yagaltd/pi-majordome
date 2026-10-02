# Judge comparison — TypeLLM vs Jev on the slice-3 failure modes

Date: 2026-09-28 · Same session, dims, and probes as slice-3 · Trigger: the
user challenged whether slice-3's "vector tier is dead" verdict was about the
*approach* or about the *judge*. It was the judge.

Endpoint: `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`,
noul battery (17 questions) + block/probe vector re-score (77 questions).
Raw: `bench/results/jev_compare.json`, `bench/results/jev_vectors.json`.

## Test 1 — the all-zero meta query (verbatim-94)

TypeLLM scored this query **0.0 on all 7 dims** (reproducibly). Jev:

| dim | TypeLLM | Jev |
|---|---|---|
| routing | 0.00 | **0.93** |
| pi_codemap | 0.00 | **0.78** |
| everything else | 0.00 | 0.04–0.10 |

Meta framing ("make a summary of…") does not faze Jev; TypeLLM's number
judgments zeroed out.

## Test 2 — the inflated query (para-routing, induced dims)

TypeLLM scored **0.95 on 9 of 9 sampled dims**. Jev:

| dim | TypeLLM | Jev |
|---|---|---|
| routing_mechanism | 0.95 | **0.95** |
| model_tiering | 0.00 | **0.92** |
| reasoning_effort | 0.95 | 0.51 |
| architecture_overview | 0.95 | 0.53 |
| feature_comparison | 0.95 | 0.45 |
| classifier_integration | 0.95 | 0.35 |
| documentation_gap | 0.95 | 0.23 |
| api_integration | 0.95 | **0.10** |
| provider_fallback | 0.95 | **0.08** |

Inflation gone: 3 dims above 0.5 instead of 9. Note TypeLLM's `model_tiering`
0.0 — its failures are not only null-flakiness; the numbers themselves are
unreliable. Positive control (routing block excerpt → routing): Jev 0.96.

## Test 3 — does the Jev vector tier revive retrieval?

Jev-judged 7-dim vectors (blocks + probes), cosine ranking:

| probe | bm25_hybrid | Jev cosine |
|---|---|---|
| verbatim-94 | **3** | 4 |
| verbatim-52 | 1 | **1** (cos 0.996) |
| para-routing | **2** | 4 |
| para-typellm-key | 3 | **1** (cos 0.824) |
| para-crash | **1** | 5 |
| **recall@1** | **2/5** | **2/5** |

Ties lexical — with a **complementary miss pattern**: Jev owns semantic
"aboutness" probes, lexical owns token-evidence probes (crash/94). Also
notable: Jev honestly scores the "routing" block as `benchmarks_evals=0.91`
— that phase *was* mostly eval-building; the gold label is the fuzzy part.

## Test 4 — naive fusion fails

RRF(bm25_hybrid, jev_cosine): **1/5** — worse than either specialist.
Averaging pulls confident-right and confident-wrong into the middle
(crash: 1+5→2, typellm-key: 3+1→2). Complementary signals require
**intent-driven specialist selection**, not blind fusion.

## Conclusions

1. Slice-3's verdict is amended: **the approach survives; the judge didn't.**
   Jev-judged probability vectors are viable (2/5 @1 on five probes, small n)
   and complementary to lexical.
2. TypeLLM remains the router/jist/rewrite engine (string questions are fine);
   **number-typed judgments route to Jev**.
3. Design law added: *specialists, not averages* — intent class picks the
   ranking signal (definition/recall → Jev vector; incident/token-specific →
   lexical). An oracle specialist would score 3/5 on these probes; blind
   fusion 1/5.
4. n=5 — all differences here are directional, not significant. Confirm on
   the multi-session index (slice-five) before wiring.

## Scope note (user Q1)

The router's contract is block selection (a pointer to resume), not exact
word recall. Exact recall inside a block stays vcc_recall's job (pull-based,
per-session). Both coexist: route → block pointer → in-block lexical recall.

## CognitiveOS v3 prior art (user Q3)

`~/Documents/current/CognitiveOS/v3/crates/retrieval_bench/` — original home
of the jaccard/leiden/keyword logic:

- **Weighted RRF** (`real_harness.rs`): lexical_weight/semantic_weight fusion
  (ran 1:1), semantic arm = usearch ANN (`index/src/backends/fs_ann_index.rs`,
  `sharded_ann.rs`).
- **PPR-augmented-RRF** strategy + `graph_correlation.rs`: community
  structure vs RRF mAP@10 — the graph-as-retrieval-signal idea, predating
  this study's communities-as-unit.
- `jaccard_tokens` duplicated in domain_docs/domain_human.
- **Caveat (user's own): never properly benchmarked — treat as design
  signals, not evidence.** Steals for slice-five: weighted RRF (lexical vs
  Jev-vector arms), PPR-style graph boost over communities, per-domain
  jaccard modules.

## Addendum (2026-09-28, post-hoc): non-determinism + thinking mode

Re-running the *identical* verbatim-94 battery that produced the all-zero
vector in slice-3 now returns `routing=0.95, rest 0.0` — correct
discrimination, same query, same dims, same params. So non-thinking TypeLLM
number judgments are **non-deterministic**, not systematically wrong.
For a router this is arguably worse than a stable bias: a judgment that
cannot be reproduced cannot be thresholded.

All study calls ran without a thinking request (client sends
`{context, questions}` only; response `thinking` came back empty).
Thinking-mode A/B is pending the exact request parameter — candidate flag
names rejected with HTTP 400: `thinking`, `thinking_effort`,
`thinking:{effort}`, `effort`, `reasoning`, `thinking_mode`,
`model_options.thinking_effort`. If thinking stabilizes *and* sharpens the
numbers, the Jev seam can be re-benchmarked; until then numbers route to
Jev, whose battery was deterministic-clean across all 17 + 77 judgments.
