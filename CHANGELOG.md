## 2026-10-03 — v2 branch: orchestrator (Path A) + durable sidecar

- durable study: Path A recommended for v2.0, sidecar pattern adopted, full Path B deferred (docs/durable-study.md)
- parity: 4-writer concurrent appends validated (200/200, atomic single-line JSONL)
- mjdx-sidecar: durable map-maintenance job (per-project checkpoint, unchanged-skip, watch mode)

## 2026-10-03 — v2 branch: /majordome init (cold-start) + lineage triage

- init: past sessions → judged index (resumable, dry-run, mtime provenance); code-parser run: +32 blocks
- lineage tier: other-repo sessions parked map-only, explicit --lineage opt-in, purgeable
- rejected: dims-arm lexical floor (no aggregate gain; polysemy collision documented in-code)

## 2026-10-03 — v2 branch: points 0–4 (bench-first)

- v2.0 resume bench: 8 versioned probes, immutable baseline (recall-only hit@3 1/6, gate 2/2)
- v2.1 one-pager command — A/B 4/6 vs baseline (composed GIST sections, provenance, stamps)
- v2.2 docs ingest adapter — frontmatter md → index blocks, idempotent, doc: sessions
- v2.3 reasoning map — lazy compile to Mermaid mindmap + turn-pointer json (termaid in pane)
- v2.4 Self-Index key evolution — gated judge phrases into tokensHybrid; coverage-bound at 38 blocks
- fixed: /majordome docs ReferenceError on master (lost ext/docs.ts import)

## 2026-10-03 — governance seeds (v1.x close-out)

- Added: judgment trail — append-only verdict metadata at every judge decision point
  (blockMeta, induceDims, rewriteQuery, routingIntent, contradicts; agent-divert and
  Jev paths included). Metadata only, never message text; fail-open writes;
  `MAJORDOME_TRAIL_FILE` override for isolation.
- Added: push codex — shipped invariant file at `~/.config/pi-majordome/codex.md`
  (first-run default, never overwritten; human-editable).
- Added: doc stamps — `/majordome docs` output instructs generated_by/generated_at/
  stale_after frontmatter; `verified` is human-only and never agent-added.
- Checks: `ext/selfcheck-governance.ts` (10 checks) alongside the main selfcheck suite.

# Changelog

Generated from the session-built history of pi-majordome. Every line traces to
a commit; from v0.1.0 on, `/majordome`'s docs nudge keeps this current.

## 0.1.0 — v1 complete

- slice-one eval: session replay through the topic-memory indexer
- slice-two: hybrid retrieval wins, EMA doubles cluster accuracy, vector tier demoted
- slice-three: rewrites adopted, RRF stabilizes, vector tier conclusively dead
- slice-four: cross-session index, time-travel + federated pooling, communities
- judge comparison: TypeLLM number judgments unreliable, Jev clean; vector tier revived as specialist
- design decisions post-slice-4: vcc stays, two-judge seam (TypeLLM strings/DAG/multimodal, Jev numbers), specialists-not-averages, product Jev via pi classifier registry
- slice-five: intent-specialist routing breaks the ceiling (3/7 vs 2/7)
- slice-5b: pair-cell positive case lands (0.95/0.89 cross-session links); confidence-by-margin rejected
- judge addendum: TypeLLM non-thinking numbers are non-deterministic (all-zero battery now scores routing=0.95); thinking-mode A/B pending exact request param
- thinking_effort A/B: non-thinking is dead-stable on dim batteries (0.95x4, 0.6s); thinking adds variance+15x latency - keep per-field for hard DAG fields only, off for dims
- degenerate-vector guard: retry all-0.0/all-1.0 dim vectors (the observed flake mode) - 5/5 self-check; DESIGN: 100%-TypeLLM now a guarded config flip, seam default unchanged
- docs: OVERVIEW - benchmark summary tables + architecture mermaid
- roadmap: v1.x traceability/ADR export + nested-call note; v2 orchestrator + memory consolidation with study references (supermemory, memorybench, CognitiveOS v3)
- command surface: /majordome (not generic /memory) - v1 spec table in OVERVIEW
- v1 build: extension live — turn_end EMA indexer, two-judge seam, intent-specialist router, tail injection, /majordome; selfcheck 23/23 + parity 0.882; live smoke: definition_recall → dims 0.707, correct cross-session winner (recalled its own design session)
- onboarding: judges.ts setup|verify CLI (majordome-only users), honest no-key status, README setup section; verify passes live
- hardening round 1: install via ~/.pi/agent/extensions symlink; mined live bench (17 real probes, 6 classes) — gate fix (strict continuation + recent context) recovers confident-gold recall to 4/4 @1, continuation 3/3; measured noise gate (dims<0.6, lex==0) in live handler
- UX round: short ids (code-parser:118) + resolveId, box dashboard with ✓/✗ routing log, table list, file-scoped time-travel (same-slug cross-file bug), log-once per turn, show record with nonzero dims; verified live in TUI
- judge configs: Jev-only routing (intent via classifier choice), agent-model gist fallback (reg.complete, zero extra keys), MAJORDOME_MIN_SCORE gate env, /majordome stats + log commands; config matrix in README; selfcheck 26/26
- v2 plan: CLM integration study (one-pager A/B, ICL-steered injection, SCR/mid-slot revisit, Harbor/ContextBench eval) + explicit multimodal-extraction line
- turn judge: need_clarification (+why) in both judge configs, judge line surfaces ambiguity to the AGENT even when memory is suppressed, recall line surfaces read-your-request-as terms; selfcheck 27/27
- wire shouldJudgeLine debounce (authored by the smoke agent mid-test — kept, it prevents clarification ping-pong) + README turn-judge section
- strong-hit post-checks: resume-not-redo hint + single-pair contradiction judge (both configs, fail-open, once per query); pi-clm installed + co-load verified; README composition section
- shortTag unified into core (injection lines now short); v2 notes: one-pager composed-vcc-style over gist atoms + doubles as scope prior, Self-Index key evolution parked with livebench-miss diagnosis set, snifftest verdict (separate layer/skill)
- README: personality note (AGENTS.md = agent voice; majordome templates = code/config, never AGENTS.md)
- indexer: per-core error capture to errors.log (crash-resume drill exposed silent second-block loss — instrumenting)
- README: known behaviors from crash-resume drill (min-size lag, dims fail-open, chatty-session gate calibration, reindex-all cost)
- judge reflow from live feedback: soft mode default (informs the agent, agent decides — it has context+tools the judge lacks), strict optional, /majordome judge off|soft|strict + MAJORDOME_JUDGE, rubric: inspectable artifacts (URL/path/repo) are never ambiguous
