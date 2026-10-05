# Bench

Ladder-test harnesses for majordome's memory pipeline. The live harness is
**lifecyclebench** (v2) — the other files in this directory (`slice*.py`,
`cross_eval.py`, `key*.json`, `v1/`, `v2/`, …) are historical study artifacts
from the retrieval design phase and are kept for provenance only.

## What lifecyclebench measures

A **pre-registered gate harness** for the memory lifecycle (block states:
`valid / superseded / failed / speculative`) and the recall pipeline. The bars
are written in the grader's file header *before* implementation runs — code
must meet numbers, not vibes.

Fixtures are synthetic sessions with **planted ground truth**
(`lifecycle_fixtures/fixtures_manifest.json`): supersession chains,
tried-and-failed records, never-contradicted valid controls, speculative
hedges — plus real historical pairs (markmap→termaid, dashboard→dash) as an
ungraded sanity section.

### Gate categories

| category | gates |
|---|---|
| mechanism (v1) | state accuracy ≥90%/class · false demotions = 0 · supersession pair recall ≥80% · leak ≤10% |
| IR metrics (v2) | Recall@5 ≥0.80 · MRR ≥0.60 · nDCG@10 ≥0.70 |
| LongMemEval abilities (v2) | temporal (old refs surfaced) · aggregation (both refs top-5) · abstention (0 false hits — backed by the recall evidence floor) |
| scale tier (v2) | same mechanism gates at `--scale N` distractor corpus + Recall@10 ≥0.70, leak ≤10% |

## How to run

```sh
npx tsx tools/lifecyclebench.ts
```

One invocation runs **both tiers**: the small mechanism corpus (18 blocks) and
the scale tier (60 filler sessions ≈ 759 blocks of deterministic distractors).
Fully hermetic — `HOME`, `MAJORDOME_DIR` and the key file are sandboxed, and a
hard guard exits 2 if the run could touch the real store at `~/.pi/majordome`.

Regenerate fixtures: `npx tsx tools/gen_lifecycle_fixtures.ts <target-dir> [--scale N]`

## Results (current, on master)

See the **Benchmarks** table in the root [README](../README.md#benchmarks).
Machine-readable output of the last run: `results/lifecyclebench-last.json`.
