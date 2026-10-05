# One-pager — build day 2026-10-05

generated_by: majordome · verified: (human — you) · scope: pi-majordome + code-parser

## Shipped today (all pushed, all bench-gated)

| # | deliverable | where | proof |
|---|---|---|---|
| 1 | v2.4 memory lifecycle (valid/superseded/failed/speculative) + bench-before-build | pi-majordome | 4 gates: 100% state acc, 0 demotions, 100% pair recall, 0% leak (was 41%) |
| 2 | lifecyclebench v2 — IR metrics (Recall@k/MRR/nDCG) + LongMemEval categories (temporal/aggregation/abstention) + scale tier 759 blocks | tools/lifecyclebench.ts | 13/13 gates, both tiers, ~2.6s |
| 3 | @cc code-contracts (spolu spec) | code-parser d65f908 | IR v6, gated scan, 128 tests |
| 4 | @slug hard-scope recall + orch slug aliases | pi-majordome | 0 cross-slug leaks; probe-teeth proven |
| 5 | docs/ORCHESTRATION.md + README rewrite + TypeLLM key setup docs | docs + README | install/usage/benchmarks/dev sections |
| 6 | magic-docs v2 — docsVerdict judge, value-driven nudges, per-slug cursors | ext/ | docsbench a–c |
| 7 | docs adoption — brownfield cursor seeding (real file/git dates) + docs profiles + `.majordome/docs.json` | ext/docsprofile.ts | docsbench d–f |
| 8 | outputShape routing — Karpathy ladder as pre-turn routing | ext/ + shapebench | live: 100% gold accuracy, 112% fact retention, **−24% output tokens**; caveman negative control caught |
| 9 | judge-cost telemetry — trail coverage completed (**fixed: trail was silently empty in production**), stats judge-cost section, gap rule | ext/trail.ts + stats/doctor | selfcheck gap rule: untrailed judge = FAIL |
| 10 | quality governance trio — from_untrusted provenance · lessons as index class · simplifyVerdict worker gate | ext/ | selfcheck 183/183; all harnesses green |
| 11 | FUTURE-STYLE-PROFILE.md — style vector plan (extraction→hint→score, held-out bench sets the sample minimum) + standalone two-tier path (Jev decisions / TypeLLM DAG+multimodal brand-book) | docs/ | plan of record |

## Environment decisions
- **pi v1.0.3**: zero impact on our seams. **Pi Durable**: separate experimental framework — future port path only.
- **jev-guard**: pi extension + global CLI (PATH fix was: pi store never links bins; `npm i -g jev-guard`). Key setup is yours (`jev-guard key "…"`). Composes with majordome: it guards tool calls/instructions; our `from_untrusted` guards the recall-amplification channel.
- **user.md live** (`~/.pi/majordome/user.md`): STE-80% + diagram-first. Shape routing reads it as judge context.

## Skills disposition (the ponytail/bro evaluation)
- **/bro** — superseded by `terse` shape when judges are on. Keep as manual override; retire after ~2 weeks dogfood shows shape hints hitting.
- **ponytail** — its ambient form is now `simplifyVerdict` (per-worker-completion, suggest-only). Skill stays until worker-gate dogfood proves it; then retire or keep as explicit deep-review mode.
- **caveman** — never a style; it is shapebench's baked-in negative control (retention 0.17 vs 1.00, FRE 52.5 vs 63.3 — the metrics must catch it to mean anything).

## Open / queued
1. grader-variance policy for live judge gates (shapebench gate-f drift flake: 112→89→95% on identical code — documented, not waived)
2. consolidation's first organic run — dogfood sessions feed supersession pairs (two stale-authority specimens already on record)
3. AGENTS.md adoption + lessons-doc review — paused (docs-profile pattern ready when you are)
4. office-parser `orch add` (housekeeping)
5. supermemory hot/warm/cold read (parked, dogfood window)

## The daily loop
`/majordome` runs the house · `/majordome one-pager` regenerates this live · `/majordome doctor` audits · `@slug` scopes recall · shape/style hints arrive as advice — you decide.
