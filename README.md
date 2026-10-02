# pi-majordome

Topic-scoped, cross-session memory for pi agents — "infinite chat": keep
chatting across projects and weeks; the right past context loads when the
query calls for it, without wrecking the provider's prompt cache.

Status: **offline study complete (slices 1-5b) — next: the live pi extension.**
Read [docs/DESIGN.md](docs/DESIGN.md) and docs/EVAL-SLICE{1..5}.md +
docs/JUDGE-COMPARISON.md. Headline: TypeLLM DAG intent -> specialist arm
(Jev-vector vs lexical) reaches 3/7 recall@1 over the cross-session suite —
past every single arm and naive fusion (2/7); continuation detection fires
mid-suite; pair cells honestly refuse to join unrelated sessions (max
same_topic 0.36). Router spec v4 in docs/EVAL-SLICE5.md; next: confidence
arm-selection, same-product pair-cell fixture, then the live pi extension.

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
bench/cross_eval.py       slice-four: two-session index, time-travel, federated pooling
bench/key_cross.json      cross-session ground truth (A gold + B ranges + 7 probes)
docs/EVAL-SLICE4.md       slice-four: cross-session recall, communities
bench/slice5.py           slice-five: pair cells, DAG intents, specialist arms
docs/EVAL-SLICE5.md       slice-five: specialist routing, router spec v4
docs/EVAL-SLICE5B.md      5b: pair-cell positive case, confidence arms rejected
bench/slice5b.py          5b: AUG index, chunked pair batteries
docs/DESIGN.md            design ledger (brainstorm trace, design laws)
docs/EVAL-SLICE1.md       slice-one methodology, results, diagnosis
```
