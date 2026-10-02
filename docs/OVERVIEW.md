# pi-majordome — overview: benchmark summary + architecture

Condensed from `docs/EVAL-SLICE{1,2,3,4,5,5B}.md` + `docs/JUDGE-COMPARISON.md`.
Fixture: session A (code-parser, 101 turns, 6 gold blocks) + sessions SEP/AUG
(MorphEditor, 763/1208 turns) = 22 indexed blocks across 3 sessions.

## Index quality

| metric | value | slice |
|---|---|---|
| boundary F1, centroid Jaccard (±1 turn) | 0.462 | 1 |
| clustering accuracy, centroid | 0.755–0.757 | 1–2 |
| clustering accuracy, **EMA boundaries** | **0.903** | 2 |
| block gists + intents (manual audit) | accurate, readable ToC | 1–5 |

## Retrieval — the journey (5 gold probes, session A)

| method | recall@1 | slice |
|---|---|---|
| Jaccard, whole-block union | 0/5 | 1 |
| BM25, whole-block union | 0/5 | 1 |
| **hybrid BM25** (user turns + tail-3 + gist) | **2/5** | 2 |
| Jev-cosine, hand dims (v1/v2) | 1/5, 0/5 | 1–2 |
| Jev-cosine, induced dims | 0/5 | 3 |
| naive RRF (lex, jev) | 1/5 | 3 |
| **specialist (intent → arm)**, cross-suite | **3/7** | 5 |

Stuck-probe timeline (verbatim-94): 4 → 3 → 3 → **1** (time-travel +
federated, slice-4).

## Cross-session (7 probes, 3 sessions)

| capability | result | slice |
|---|---|---|
| federated per-session pooling | calendar 14/14 → 2/14 | 4 |
| time-travel candidates | routing probe → rank 1 (with federation) | 4 |
| continuation detection | T=52 correctly "current topic → no retrieval" | 4–5 |
| pair cells, unrelated sessions | honest negative (max 0.36) | 4–5 |
| **pair cells, same product** | **0.95 / 0.89 cross-session topic links** | 5b |
| community-as-unit | inert until cross-joins exist; Leiden resolution open | 5 |

## Judges

| finding | evidence |
|---|---|
| TypeLLM non-thinking numbers: rare non-deterministic flake (all-0.0) | 2 in ~150 calls; retried clean 4/4 |
| guard: retry nulls **and** degenerate all-0.0/all-1.0 vectors | 5/5 self-checks |
| thinking on dims: adds variance + 15× latency, no precision | A/B: none 0.95×4 vs 0.7–0.95 spread |
| Jev numbers: 94/94 deterministic-clean, catches inflation | judge comparison |
| seam: TypeLLM strings/DAG/multimodal · Jev calibrated numbers · 100%-TypeLLM = guarded config flip | DESIGN.md decisions |

## Architecture

```mermaid
flowchart LR
  subgraph Stores
    JSONL[("session.jsonl<br/>ground truth · never rewritten")]
    IDX[("side-car index<br/>blocks.jsonl + communities")]
  end

  subgraph Indexer["index path · turn_end hook"]
    TURNS["parse turns<br/>skip wrappers · dedupe retries"]
    BOUND{"boundary?<br/>Jaccard / EMA drift"}
    CLOSE["block close<br/>1 batched call"]
  end

  subgraph Judges["judge seam"]
    TLLM["TypeLLM /v1/generate<br/>DAG: intent · gist · rewrite<br/>multimodal · thinking per-field"]
    JEV["Jev /v1/systemone<br/>dims battery · pair cells<br/>calibrated numbers"]
  end

  subgraph Router["query path · before request"]
    Q(["user query"]) --> INTENT{"TypeLLM DAG<br/>continue / switch / recall<br/>+ rewrite terms"}
    INTENT -->|continue| NOOP["inject nothing<br/>cache-safe · zero cost"]
    INTENT -->|switch / recall| TT["time-travel filter<br/>past blocks only · exclude current"]
    TT --> FED["federated<br/>per-session top-k"]
    FED --> ARM{"arm by intent class<br/>(specialists, not averages)"}
    ARM -->|definition / recall| JV["Jev cosine"]
    ARM -->|incident / token-specific| LEX["hybrid BM25"]
    JV --> WIN["winner block"]
    LEX --> WIN
    WIN --> INJ["inject ToC entry at tail<br/>gist + decisions + pointers"]
  end

  JSONL --> TURNS --> BOUND
  BOUND -->|yes| CLOSE
  CLOSE --> TLLM & JEV
  CLOSE --> IDX
  IDX --> TT
  INJ --> PROVIDER(["provider request<br/>tail = cache-free zone"])
  VCC["pi-vcc<br/>masks old tool results<br/>in-block recall = vcc_recall"] -.-> PROVIDER
  WIN -.->|detail on demand| VCC
```

Design laws: place invalidation (tail free, switches are natural resets) ·
session file never rewritten · one judge per data type (TypeLLM strings/DAG,
Jev numbers) · three index levels, messages unindexed · specialists not
averages · fail-open + visible + purgeable.

## Roadmap

### v1.x — traceability & export (independent of git)

Source of truth stays the pi session JSONL (append-only, full fidelity:
every user/assistant message, tool call + result, compaction records,
extension custom entries). majordome adds the classified layer on top.

- **Block -> ADR export**: pure function over the index (frontmatter:
  session id, turn range, intent, dims; body: gist + decisions).
  Exported `.md` files can round-trip back in as ingest.
- **Nested-call note**: majordome's index is unaffected by pi's bounded
  `nestedCalls` records — it indexes user + assistant text, which always
  appear in full. Verbatim replay of deeply nested tool *results* is a
  detail-recall limitation (vcc layer), not an index gap.

### v2 — orchestrator (firstmate-style) + memory consolidation

- **Orchestrator**: one chat dispatching per-project worker pi sessions,
  referencing `~/Documents/vibe/firstmate` (visible panes, worktree
  isolation, zero-token supervision, restart-proof state); majordome is the
  shared brain — every spawned session indexed the same way.
- **Memory consolidation & external documents** (Instinct/supermemory
  inspired: git-tracked markdown memory, daily consolidation, one-pager):
  md+frontmatter ingest adapter (frontmatter -> metadata/dims, body ->
  block text) so retrieval spans chats AND curated docs (ADRs, specs,
  operator-memory-style notes); per-project rolling "one-pager" from top
  community gists; consolidation/forgetting policy.
  References for the study phase (do not read until v2):
  - `~/Documents/vibe/supermemory`
  - `~/Documents/vibe/memorybench`
  - `/home/aurel/Documents/current/CognitiveOS/v3` (ingest_formats,
    retrieval_bench prior art)
