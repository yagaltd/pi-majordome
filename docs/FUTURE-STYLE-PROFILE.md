# FUTURE: Style Profile & Writing Enforcement

Status: planned, not scheduled. Extraction→hint→score slices, then extract-if-proven
standalone. This doc is the design of record; nothing here is wired yet.

## Goal

User-provided writing samples → judged **style vector** → before-writing hints +
after-writing scoring. Applies to coding and non-coding repos (a writing repo's
profile is the same mechanism with different rules: "english grade 8" is judge
context + the Flesch/ASL formulas already in `ext/metrics.ts`).

House contract applies throughout: judge → suggest → human decides. Never
blocks a write. Never a maintained markdown file (the lessons decision: memory
is JSONL+index; prose is derived).

## Extension slices (majordome)

1. **Extraction** — init or `/majordome style` judges N of the user's existing
   prose samples (README prose, docs/, or an explicit sample dir — no new
   writing required) into a style vector: dims-style floats (tone formal↔casual,
   density, sentence-length target, vocabulary level) + keyword preferences +
   hard rules. Uses the existing judge seam (TypeLLM→Jev fail-open; zero new
   keys). TypeLLM's `depends_on` DAG can batch sequential extraction steps into
   one call (established primitive, 2026-10-04).
2. **Storage** — user tier `~/.pi/majordome/style.json` (global), per-repo
   override `.majordome/style.json` (docs-profile precedence pattern). Versioned
   schema, lenient parse, clobber-proof save.
3. **Before writing** — shape routing integration (preferred: style context into
   the existing shapeVerdict call; costmeter police the delta) or a styleHint
   tail line. Suggest-only.
4. **After writing** — deterministic metrics (Flesch/ASL/term consistency) +
   judge ToneMatch vs the vector. Pre-registered thresholds; suggestions only.
5. **Bench** (`tools/styleprofile-bench.ts`, docsbench pattern): hermetic gates
   on canned vectors + wiring + no-line-when-absent; live gate = held-out
   prediction: extract the vector from k samples, score sample k+1 — the vector
   must predict the author's held-out writing better than a generic baseline.
   **Sample-count question answered empirically by this gate**, starting prior:
   ≥3 samples / ~500 words minimum, 5+ / ~1500+ words across registers for a
   stable vector.

## Standalone evolution (extract-if-proven)

Two-tier split mirrors our existing judges — decisions cheap and frequent,
extraction rich and rare:

- **Jev decision-only API**: runtime tone-match / rule-compliance verdicts for
  any harness. Cheap, typed, fast.
- **TypeLLM API**: extraction (style vectors), `depends_on` DAG batching, and
  **multimodal brand-book ingestion** — logo, palette, typography from images →
  a visual-identity vector. Multimodal is the TypeLLM-only capability and the
  main standalone differentiator (brand identity enforcement, not just prose).

Extract into a standalone product (jev-guard shape: own CLI, hooks, key UX)
only after the majordome extension proves itself in dogfood — the same
proven-out-then-adopted bar pi applies to its own features.

## Non-goals

- No blocking/auto-rewrite of the user's or agent's text
- No new API keys or services (fallback covers both engines)
- No hand-maintained style documents
