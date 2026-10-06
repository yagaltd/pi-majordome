## 2026-10-05 — v2 branch: judge-cost telemetry (trail aggregate)
- AGENTS.md adoption: init/doctor gap report (greenfield vs brownfield via shared hasCodeManifest, Lessons/testing/no-compat gaps) — advisory only.
- recall-feedback telemetry: revived the ✓ injected decision-log entry (dead since de2c1c1 — injections were never logged), precision proxy (shortId or ≥6-word gist phrase referenced within 3 turns), 8-specimen false-positive corpus (wrong-repo 6 · polysemy 1 · weak-match 1) + stats section. The self-improving loop: specimens become bench probes.
- from_untrusted: provenance flag on ingested/shared blocks + `· unverified source` recall marker (zero new judge calls; sessions trusted-class by scope).
- lessons as index class: block-close lesson/error classification + lesson-intent query boost + one-pager generated Lessons section + consolidation pairing (no lessons.md — memory is JSONL+index).
- simplifyVerdict: once-per-worker-completion simplification judge (delete/merge/inline hints), suggest-only inbox note, fail-open + trail. Also fixes latent missing pushInbox import (worker inbox pushes ReferenceError) and a selfcheck test-order bug.
- judge-cost telemetry: complete trail coverage across all judge call sites (fixed latent trailFile bug — majordomeDir unimported, trail was silently empty in production) + trail aggregation + stats judge-cost section + meta.turns + doctor creep note + selfcheck gap rule. NOTE: shapebench live gate (f) flaked to 95.0% at the bar — proven grader-side model drift (fails identically on unmodified HEAD; 112%→89%→95% across runs, zero code change); follow-up: grader-variance policy for live judge-graded gates.

- judge-cost telemetry: the judgment trail is the single source of truth — `/majordome stats` gains a `judge cost (trail aggregate)` section (`judge calls: N total · N today · avg X/turn (last 100 turns) · ~T tok reported` + `by judge:` split with ok/fail-open %), aggregated by new `aggregate()`/`judgeStatsLines()` in ext/trail.ts; zero parallel counters, zero new API calls.
- trail coverage completion (gap-rule, selfcheck-enforced): every judge call site now trails — routingIntent Jev continuation/error paths, contradicts Jev error, docsVerdict dead-transport paths (TypeLLM + Jev), lifecycleVerdict Jev paths, blockMeta agent-path failures, and dimVector (never trailed; one line per invocation with attempts). Static + runtime hermetic probes in selfcheck fail on an untrailed judge.
- estTokens on new trail lines where the transport reports usage: live TypeLLM returns `{input_tokens, thinking_tokens}` (no total) — tokensOf() handles bare numbers, OpenAI totals, and part sums; verified live (rewriteQuery → `estTokens:77`). Jev/agent paths count calls only.
- turn denominator: cumulative turn counter in meta (`index.json.turns`, preserved across dims/cursor-only saves), stamped at turn_end; new trail lines carry `turn` via setTrailTurn so the last-100-turns window is exact.
- doctor: ONE line, only when notable — `judge creep` when calls/turn > 3 over the last 100 turns; silent otherwise.
- fixed: trailFile() referenced an unimported majordomeDir — with MAJORDOME_TRAIL_FILE unset (production), every trail write failed open silently and the real trail stayed empty; the trail now actually lands at ~/.pi/majordome/trails.jsonl.
- hermetic fix: the selfcheck Jev-only section trailed into the real store; now sandboxed.
- gates: selfcheck 145/145 · selfcheck-governance ✓ · shapebench hermetic PASS · docsbench PASS (a–f) · lifecyclebench 13-gates PASS both tiers. Live-tier shapebench fact-retention (89% vs 95%) fails identically on unmodified HEAD (server-side model drift, not this change — proven by running HEAD code in isolation).

## 2026-10-03 — v2 branch: dispatch (firstmate orchestrator, surface-agnostic)
- outputShape routing: pre-turn shape judge (terse/diagram-first/table/walkthrough/artifact; user.md preference context; suggest-only tail hint; fail-open default; trail-recorded) + ext/metrics.ts + shapebench (metric validation, caveman negative control; live: 100% gold accuracy, fact retention ≥ default, −24% mean output tokens).
- docs adoption: brownfield cursor seeding at init (git log → mtime, absent-keys-only, idempotent) + per-repo docs profiles (code-marker detection → coding/generic watch sets, .majordome/docs.json override, custom watch names like NOTES) — profile-filtered nudges, docsbench gates d/e/f.
- magic-docs v2: docsVerdict judge (value-driven nudge by kind; arithmetic fallback offline; trail-recorded) + per-slug doc cursors (slug:doc, legacy-migrated) + docsbench gates + subagent scratch sessions excluded from sweeps.
- @slug: hard-scope recall by repo slug (`@office-parser …` — overrides priors, lifecycle+intent scopes still apply) + orch slug aliases (`orch @slug`); cross-slug bench gates (0-leak) — 13/13 green.

- tools/dispatch.ts: headless (pi -p) + pane (herdr agent) modes, cold-start guard, status
- verified live: one dispatcher, two worker repos, sessions saved into the shared brain

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
