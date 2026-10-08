## 2026-10-05 — v2 branch: judge-cost telemetry (trail aggregate)
- correction canary + soft wall (deterministic, zero judge calls): pushbackHit tokens per fresh turn → frustration trail lines; ≥2 correction turns in a 3-turn window → the next response OPENS with a check-in (once per episode — never an auto-housekeeping); corrections surface in /majordome stats as the correction canary. Design: user corrections SCORE (agent quality + recall canary, never user.md); agent-output contradictions stay limited by recall+contradicts; user.md distillation reserved for shape-preference pushbacks via proposals only.
- triage automated (captain design): ledger/ledger-house trigger triageAuto before rendering — incremental (untagged rows judge; worthy rows inherit even as families grow; none-tagged rows re-judge only when their family grew — group formation is the worthiness trigger), tags persist in meta.triage (survive restarts; saveMeta preserves like docsProfile), scope widened to parked, steady-state renders cost zero judge calls; /majordome triage stays as the explicit refresh; docs-gen const-a reassignment fixed (latent runtime crash on docs gen).
- proposals pipeline complete (both slices): (1) triage — one batched generate call over pending rows tags proposal-worthiness + establishment path (research/inspect/grill/none) with return_probabilities confidence; /majordome triage caches session markers, ledger view renders ⓟ lines. (2) store-backed swap — ext/proposals.ts keeps its full file-era API signature-for-signature but backs onto kind=proposal blocks (fold = latest per id, loadBlocks lenient parse widened to keep proposal kind); proposal CLI (list/show/decide/add); legacy .md files migrate once on first list (idempotent); the orch-start-ux file proposal migrated live.
- ledger topic grouping (view lens, store stays flat): topicOf deterministic families (workflow/judgment/recall/orchestration/docs/storage/core); scan-list statuses (pending/parked) collapse families of ≥2 into one family bullet + indented sub-bullets, singletons flat; built/dropped stay packed; status stays per-item.
- pi v1.1.0 adapters: agent_settled.aborted → deck push (cancelled worker runs now tell the orchestrator; the completion push rode turn_end which cancelled runs never fire); tool_execution_end.durationMs → trail toolTime telemetry (nested + sub-50ms skipped) with a tool-credit window in /majordome stats; ORCHESTRATION.md notes OSC 7501 worker-state visibility. Judge-mode enrichment dropped (typellm covers it all — captain order).
- verbatim recall surface live: verbatimSurface (deterministic token-substring match over trails.jsonl, absolute trail:N citations, docsNudge flood excluded, <20-char lines ignored, cap 3) wired as a third labeled channel in the decomposed injection — the manual trails-grep pattern dies; freshness row re-scoped (per-turn posthook already live in turn_end; pointer-registry + dirty-drain stays pending paired with sqlite).
- judge-credit warning live: judgeHealth (pure, trail-tail aggregation — degraded = failRate ≥0.3 over ≥3 calls or any zero-ok auth exhaustion; absent engines are a state not a warning) surfaces once via setStatus on turn_end, clears on recovery (judges healthy again); /majordome stats gains the live judge-credit window; readTrailTail hermetic-fixture pinned; classifyWired getter exposes jev wired-state.
- v0.6.6 adapters (slice b): shape judge gains return_probabilities + permutations (order-debiased) and a mechanical confidence <0.6 → default downgrade (rung-1 fallback, trail notes downgraded+confidence — replaces the free-judgment gap); panel fact graders gain return_probabilities with votesOf reading both plain and {value,confidence} answer shapes; shapeOf accepts .value objects.
- grill discipline XS: decompose prompt orders readings by likelihood (first = default), grillOptionsLine names the silence-default explicitly (default = 1: …), ROLES charter gains the Router rule (route ambiguous; grill only material decisions; ≤1-2 questions with defaults; never ask what is readable). Split rows: XS built, funnel row stays gated.
- cross-repo attribution COMPLETE: repoOf() git-root canonicalization (subdir bug dead), write seam stamps repo + inferRepo (evidence paths naming exactly one other repo win — direct-mode), decisionInRepo reads repo fields, legacy sweep stamps 73 decisions + strips 2 mislabeled non-decision stamps (first live run caught path-garbage on index blocks — restored from backup, re-scoped). tools/migrate-repo-stamps.ts idempotent, backup blocks.jsonl.bak-sweep.
- orch add eager init at link time: cold repos initRepo() immediately on add (ledger exists at link; status/ledger @slug instantly useful), start path keeps n===0 branch as idempotent safety net, init failure degrades to deferred note.
- fold repair: compaction-hook built block had used a shortened item name, so the original long pending row never flipped (latest-wins matches exact item strings). Superseded with the exact string — pending 18, row built. Discipline noted in-block: superseding blocks must copy the exact original item string.
- docs naming consolidation (ROLES charter §gaps #4) built: /majordome docs gen <kind> + docs pull; legacy bare docs <kind> and ingest-docs remain as unlisted aliases; help + description updated; pending row superseded to built.
- ledger table pending rows: one bullet per item, one line per row (continuation segments 2-space aligned under the bullet); parked/built/dropped keep the packed flow.
- ledger table full-width sizing: formatLedgerTable detects stdout.columns (OR-chain — Number(undefined) is NaN, not nullish; NaN poisoned repeat() into empty borders), COLUMNS env, or 113 legacy default; width override param; clamped 40–240; behavioral fixture pins override + fallback borders.
- typecheck gate on the unbound-identifier class (TS2304/2305) added to pre-push — closes the hole that shipped loadHouseRows undefined to a live session; two more latent unbound names fixed (filterBlocks in index.ts list path, BlockStatus in selfcheck fixture); check-only tsconfig.json added.
- /majordome ledger views: bare = this repo, @slug = one worker repo (resolveWorkerRef, mirrors status), house = loadHouseRows global unfiltered fold. Solves the empty-in-code-parser surprise: decision blocks are repo-stamped; only pi-majordome carries them.
- compaction_end hook live: vcc compaction now triggers consolidation refresh (indexSession, append-only) + housekeeping REPORT (apply:false — advisory only, fixes still need your yes). Pending row flipped to built with selfcheck pin.
- shape route rebalanced per Karpathy rung ladder: user.md standing rule flipped (prose = rung 1 default; diagrams reserved for genuinely structural content, lead-with-prose) + shape judge diagram-first trigger narrowed to multi-system/state-machine/decision-graph content with when-unsure-choose-default. Root cause of diagram-always: the old diagram-first standing rule inverted the ladder.
- DECISION-BLOCK STORE landed: blocks.jsonl = the only ledger source (62 legacy rows migrated verbatim, fold verified 21 pending/12 parked/23 built/6 dropped, 0 contradicted); /majordome status folds the decision stream on the fly (latest wins, contradicted flag); STATUS.md = generated export with do-not-edit banner; the store row flipped to built as a superseding decision block — the first ledger mutation in the new form.
- JSON surfaces merged: status.json (61→62 rows, HEAD delta folded, decision-block row restored) + user.json + /majordome user (set/reset/render, answer_shape drives the shape judge) + one-pager REMOVED per captain (ext/onepager.ts kept — durable-sidecar prototype dependency) + pi-clm REMOVED per captain (settings + node_modules; was the live-context mirror provider — context editing now manual-only) + decomposedInjection cross-label dedupe (duplicate recall lines fixed).
- query decomposition v1: decomposeQuery (typellm structured, ≤3 sub-questions, per-boundary cohesion, confidence grill gate ≥0.9 proceed / <0.9 options) + parallel per-sub-query recall with dedupe/merge and labeled sections; entity registry: deterministic per-turn extraction (URLs/repo paths/file paths → entities.jsonl) + exact-match recall boost + doctor advisory. Real-repo smoke: 2-tagged sub-questions, confidence 0.95.
- optchat/rustlm/CognitiveOS study (subagent, read-only): spectrum mapped (judge-driven vs LLM-compactor vs pure-algorithm vs hybrid); queued — rustlm hygiene trio (S), jaccard+leiden communities (M, attacks router.ts:137), ambient view+zoom (parked), graphIndex tree (parked, gated); freshness row gains dirty-mark drain. All file-based, no sqlite needed.
- fix: /majordome list + dash crash (undefined session .replace) — root cause: a partial appendBlock write (duplicate lesson block without session) + unguarded shortTag. Fixed at three layers: shortTag guard, appendBlock write-seam default, store dedupe (141 blocks, one stamped).
- /majordome status house view + @slug: formatHouseStatus + listWorkers/resolveWorkerRef reuse — any repo's ledger from any session (cold workers honestly "no ledger"); orch-start UX proposal filed under .majordome/proposals/ (first dogfood proposal in this repo).
- /majordome status: ledger view command (formatStatus in ext/status.ts) — pending items in full, parked inline, built/dropped counts; data stays in STATUS.md, the command is a view. Registered in help.
- mechanical pre-push gate: .githooks/pre-push (core.hooksPath) reruns selfcheck+docsbench and blocks red pushes — jev-guard's block-at-choke-point shape with deterministic checks (no classifier, no false-positive drift); born from the captain escalation on agent bypasses.
- captain escalation caught two agent failures: negatives claimed from empty output (store.jsonl wrong path; truncated post-init capture) and a table composed from session memory instead of the ledger. Fixes: AGENTS.md §how-to-work gains the negatives-need-positive-proof rule; selfcheck pins init ordering (initRepo before any offer — an applied offer implies state). Proven real: init in pi-majordome applied the Lessons block (AGENTS.md:89) while leaving no .majordome — re-run init on current master to create state.
- house registered office-parser as 4th orch worker (path verified, global: orchestrator.json); STATUS gate now accepts global-state evidence for built rows that are not repo commits.
- agentsmd cwd guard (undefined cwd → process.cwd()) — fixes fs.existsSync deprecation warning in headless doctor paths; sqlite storage study queued (STATUS) with leviathan FTS5 patterns + pi-durable option, gated on contention/scale.
- agents gap-report: Lessons-section gap is now conditional — suppressed wherever .majordome exists (lessons live in the index there; captain decision 2026-10-05: agents forget static files). Fixed decision-vs-mechanism drift where the loopbuilder gap check kept re-proposing a rejected idea; selfcheck pin added.
- proposals lifecycle: .majordome/proposals/YYYY-MM-DD-<kind>.md (OKF metadata state, flat folder, decisions stamped in metadata by the butler + mirrored to STATUS.md, append-only revisions; housekeeping lists pending/stale >7d/legacy, never decides) — replaces .majordome/AGENTS.proposal.md; declined-with-UI is stamped rejected (a no is a decision, not pending).
- OKF metadata sweep: research artifacts (docs/dev/ ×4, bench/EVAL-* ×6) now carry plain key:value headers (added/source/status[/harness], git-derived dates, no fences); product docs exempt by rule (structure = metadata); AGENTS.md stays header-free (prompt surface) — rule written into AGENTS.md §structure.
- init AGENTS.md flow: absent → scaffold proposal from embedded template (write only on yes; headless → review copy at .majordome/AGENTS.proposal.md); present → augment gap-report ask-first incl. parked-dependencies bullet; doctor advisory via shared agentsReport; agentsmd.ts provably write-free (all writes behind explicit consent at the UI/CLI boundary). STATUS.md joins the docs-watch built-ins — ledger edits now satisfy the nudge.
- housekeeping routine: status-join in recall (STATUS.md row → related-status line in memory injection, deterministic token join, bounded 2) + doctor CLI entry (tools/doctor-cli.ts — bare-tsx silence dead) + /majordome housekeeping [dry-run] — safe class auto-fixes docs/README/STATUS via path allowlist, dangerous class (rm/git/code) listed never executed.
- housekeeping: STATUS.md status ledger (28 rows: built/parked/dropped/pending, one home for "is X done?") + doctor doc-drift gate (README/mechanism claims audited against ext/+tools/ evidence; roadmap wording exempt) — sidecar present-tense drift caught in README + ORCHESTRATION.md and corrected to planned/prototype.
- panel grading: majority-of-available-engines for live judge-graded gates (ext/panel.ts; per-fact yes/no across TypeLLM/Jev/re-ask, tie resolves presence-ward, single-grader marked variance-prone, trail-recorded per grader) — shapebench gate (f) stable at 100% across consecutive live runs (closes the documented grader-drift flake).
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
