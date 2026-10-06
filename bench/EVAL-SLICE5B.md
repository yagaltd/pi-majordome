added: 2026-10-06
source: slice eval program
status: executed
harness: bench/slice5b.py

# Slice-5b — pair-cell positive case, confidence arms (rejected), AUG probes

Date: 2026-09-28 · Three-session index: A (code-parser, 6 blocks) + SEP
(MorphEditor 09-06, 8 blocks) + AUG (MorphEditor 08-23, 1208 turns → 8 coarse
blocks) = 22 blocks. Harness `bench/slice5b.py`; caches `bench/results/slice5{,b}/`.

## Result 1 — the pair-cell positive case LANDED

112 new Jev `same_topic?` judgments (AUG↔SEP, AUG↔A). Top cross-session:

| P(same_topic) | pair |
|---|---|
| **0.95** | SEP "divergent research + product tension" ↔ AUG "research + deno + subagent discipline" |
| **0.89** | SEP "calendar fix + sidebar markdown" ↔ AUG "@-calendar chatbar / date picker" |

The recurring topics **were found across sessions** — the exact capability
slice-4 lacked. The code-parser↔MorphEditor pairs stayed low (slice-5's
honest negative stands): the judge links shared topics, not shared tooling.

Community granularity is the open tuning: strong edges (lexical ≥0.30 ∪
Jev ≥0.50) plus within-session transitivity still merge B+AUG into one
component — topic-level partition needs real Leiden with resolution, not
connected components. Presence proven; partition quality = extension work.

## Result 2 — confidence-by-margin: REJECTED

Picking the arm by per-arm margin (lexical score margin vs Jev cosine gap)
scored **1/7** vs slice-5's class-based 3/7. Margins measure self-
consistency on each arm's own scale, not correctness — a wrong top-1 can
carry a large margin. The class prior stays the selector. Hypothesis for
the extension (unproven, n=7): **scope-aware prior** — cross-session recall
leans Jev-vector, same-session leans lexical.

## Result 3 — AUG probes: 3/3 inside the injection set

The three new probes (diff-in-editor, subagent fake-work, sync toast) all
retrieved their expected AUG block at rank 3 of the federated top-9 —
in-set, behind another session's pool entries, which is the correct
interleave behavior for a three-session index.

## Where the offline study ends

Five slices + a judge comparison produced, all measured:

- hybrid BM25 over user-turns + tail + gist (the lexical arm)
- Jev-judged named vectors (the semantic arm; TypeLLM excluded from numbers)
- TypeLLM DAG intent → continuation gate + rewrite + arm prior (specialists,
  not averages: 3/7 vs 2/7)
- time-travel candidates + federated per-session pooling
- pair-cell cross-session topic linking (0.95 / 0.89 positive, honest
  negatives elsewhere)
- known open tunings: Leiden resolution, scope-aware arm prior, federated
  fallback

Next: the router as a live pi extension (`pi-majordome` proper), replayed
against the session that started this.

## Reproduce

```sh
python3 bench/slice5.py                 # slice-5 caches (vectors, pairs, intents)
python3 bench/slice5b.py                # AUG index + pair cells + confidence test
```
