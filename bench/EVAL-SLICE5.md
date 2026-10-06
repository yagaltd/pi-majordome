# Slice-Five Eval — pair cells, intent-specialist routing, community-as-unit

Date: 2026-09-28 · Same two-session index (A: code-parser, B: MorphEditor,
14 blocks) · Harness `bench/slice5.py`, caches in `bench/results/slice5/`.
Judges: TypeLLM (DAG intents, dim induction) + Jev (vectors, pair cells) per
the two-judge seam in DESIGN.md.

## What ran

1. **Jev pair cells** — 48 cross-session `same_topic?` judgments.
2. **Union dim vocabulary** — 24 A-induced + 44 B-induced = 40 dims; Jev
   vectors for all 14 blocks + 7 probes (714 noul judgments).
3. **TypeLLM DAG intent** per probe — `intent` → `search_terms` (depends_on).
4. **Specialist routing** — federated candidates; arm chosen by intent class
   (definition_recall → Jev cosine, incident_specific/continuation → lexical).

## Results (recall@1 over 7 probes, federated candidates)

| method | recall@1 |
|---|---|
| **specialist (intent → arm)** | **3/7** |
| community-as-unit | 3/7 |
| lexical (bm25_hybrid) | 2/7 |
| Jev cosine | 2/7 |
| naive RRF (both arms) | 2/7 |

Per-probe: specialist wins where its arm is strong (X-typellm-key: jev 1 vs
lex 2; verbatim-52: continuation → lex 1, and the router correctly classified
a mid-session probe as *continuation*) and loses where the arm assignment is
wrong: the three routing "definition" probes go to Jev, but their block
vector is diluted (Jev honestly scores the routing block
`benchmarks_evals`-heavy), so lexical would have ranked 2–3.

## Findings

1. **Specialist selection is the first method past the 2/7 ceiling** — on
   every arm and fusion tried since slice-1. Directional only (n=7), but the
   mechanism is now measured end-to-end: TypeLLM class → arm → federated
   pool → rank.
2. **Intent classes are clean** — definition_recall / incident_specific /
   continuation all landed correctly, including catching verbatim-52 as
   *continuation* (in production: no retrieval at all).
3. **Arm assignment needs confidence, not just class.** Class-level routing
   (recall→jev) misroutes mechanism-definition queries where the block's
   honest vector is diluted by adjacent content. Slice-5b: pick the arm by
   per-arm confidence (Jev cosine margin vs lexical score margin), class as
   prior.
4. **Pair cells: honest negative.** Max cross-session `same_topic?` = 0.36 —
   Jev correctly refuses to join code-parser and MorphEditor blocks; the
   hypothesized routing↔subagents link was a functional analogy, not a
   shared topic. Mechanism validated; the *positive* case needs same-product
   sessions (the two MorphEditor sessions from the inventory are the right
   fixture).
5. **Community-as-unit is inert without cross-session communities** — with
   zero joins it degenerates to per-session structure. Re-measure after a
   positive pair-cell fixture exists.

## Standing design (v4)

```
query → TypeLLM DAG: intent + rewrite terms
      → continuation: nothing
      → federated per-session top-k candidates
      → arm by confidence (class as prior): jev-cosine | lexical hybrid
      → winner block (community wrapper when communities exist)
      → inject ToC entry at tail
```

## Next

- 5b: confidence-based arm selection; same-product pair-cell positive case
  (MorphEditor Aug + Sep sessions)
- then: the router as a live pi extension (pi-vcc dependency, judge seam per
  DESIGN.md), replayed against this session
