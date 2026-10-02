# pi-majordome

Topic-scoped, cross-session memory for pi agents — "infinite chat": keep
chatting across projects and weeks; the right past context loads when the
query calls for it, without wrecking the provider's prompt cache.

Status: **slice-three eval done — router spec converged.** Read
[docs/DESIGN.md](docs/DESIGN.md) and docs/EVAL-SLICE{1,2,3}.md. Headline:
ranking = hybrid BM25 (user turns + tail + gist) fused RRF with jaccard,
after a TypeLLM rewrite that strips meta framing from recall queries;
EMA boundaries double clustering accuracy (0.757 -> 0.903); the
judgment-probability vector tier is dead across three feature designs
(hand topics, hand artifacts, induced) — dims are ToC metadata and
filters, never ranking vectors.

## Quick start

```sh
# offline tier (no key): boundaries + clustering + Jaccard/BM25 retrieval
python3 bench/eval.py \
  --session ~/.pi/agent/sessions/<project-dir>/<session>.jsonl

# add the TypeLLM tier (~11 calls; key from ~/.config/pi-codemap/typellm.key
# or TYPELLM_API_KEY)
python3 bench/eval.py --session <session.jsonl> --classify
```

The hand-labeled answer key for the reference session is `bench/key.json`
(6 blocks, 5 probes). Results land in `bench/results/report.json`.

## Layout

```
bench/eval.py             parser + boundary sweep + clustering + retrieval probes
bench/typellm_client.py   /v1/generate client (dims + intent + gist, one batched call)
bench/key.json            ground truth for the reference session
bench/results/            reports (v1-clean, v2, ema)
docs/EVAL-SLICE2.md       slice-two: hybrid retrieval, EMA, v2 dims
docs/EVAL-SLICE3.md       slice-three: RRF, rewrites, dim induction, router spec
docs/DESIGN.md            design ledger (brainstorm trace, design laws)
docs/EVAL-SLICE1.md       slice-one methodology, results, diagnosis
```
