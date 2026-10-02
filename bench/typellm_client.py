#!/usr/bin/env python3
"""TypeLLM judgment client for pi-majordome.

Same endpoint/conventions as pi-codemap's ext/typellm.ts:
POST {base}/v1/generate, Bearer key, body {context, questions}.
Key: ~/.config/pi-codemap/typellm.key (chmod 600) or TYPELLM_API_KEY env.
"""
import json
import os
import urllib.request
from pathlib import Path

URL = "https://api.typellm.ai/v1/generate"

# Slice-one dims: session topics (what was talked about).
DIMS = [
    "code_parser",
    "pi_codemap",
    "typellm_setup",
    "routing",
    "benchmarks_evals",
    "docs_pii",
    "infinite_chat",
]

# Slice-two v2 dims: artifact/activity hybrid — coding sessions partition by
# what was done and what was touched, not by topic noun (EVAL-SLICE1 finding).
DIMS_V2 = [
    "watcher_bench_infra",     # code-parser watcher, dogfood benches
    "edit_override_decider",   # guarded edit, many-file decider, codemode
    "classifier_key_setup",    # jev/typellm keys, provider config
    "model_routing_evals",     # effort/tier routing, virtual model, evals
    "docs_pii_audit",          # README/docs, PII scrub, repo hygiene
    "context_memory_design",   # infinite-chat / topic-memory brainstorm
]


def load_key() -> str:
    k = os.environ.get("TYPELLM_API_KEY", "").strip()
    if k:
        return k
    p = Path.home() / ".config/pi-codemap/typellm.key"
    if p.exists():
        k = p.read_text().strip()
        if k:
            return k
    raise SystemExit("no TypeLLM key: set TYPELLM_API_KEY or write ~/.config/pi-codemap/typellm.key")


def generate(context: str, questions: dict, retries: int = 1) -> dict:
    body = json.dumps({"context": context, "questions": questions}).encode()
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                URL,
                data=body,
                headers={"Authorization": f"Bearer {load_key()}", "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.load(resp)
        except Exception as e:  # noqa: BLE001
            last = e
    raise SystemExit(f"TypeLLM call failed after {retries + 1} attempts: {last}")


def _dim_questions(dims: list[str], extra: dict | None = None) -> dict:
    q = {
        d: {
            "type": "number",
            "instructions": f"Probability 0.0-1.0 that this conversation segment is about '{d}'. Use the full range; 0.5 means genuinely mixed.",
        }
        for d in dims
    }
    if extra:
        q.update(extra)
    return q


_BLOCK_EXTRA = {
    "intent": {
        "type": "string",
        "enum": ["implementation", "investigation", "evaluation", "documentation", "discussion"],
        "instructions": "Primary intent of this segment.",
    },
    "gist": {"type": "string", "instructions": "One sentence: what was done or decided."},
}


def _parse_dims(r: dict, dims: list[str]) -> dict | None:
    """Extract float dims; None if the call returned nulls. Silently zero-filling
    poisons retrieval — TypeLLM intermittently nulls number-typed questions
    while string questions in the same call succeed."""
    res = r.get("result")
    if not isinstance(res, dict):
        return None
    out = {}
    for d in dims:
        v = res.get(d)
        if v is None:
            return None
        try:
            out[d] = float(v)
        except (TypeError, ValueError):
            return None
    return out


def block_vector(text: str, max_chars: int = 6000, dims: list[str] | None = None,
                 attempts: int = 3) -> dict:
    """One batched block-close call: dims + intent + gist. Retries while dims null."""
    ds = dims or DIMS
    for _ in range(attempts):
        r = generate(text[:max_chars], _dim_questions(ds, _BLOCK_EXTRA))
        vec = _parse_dims(r, ds)
        if vec is not None:
            out = dict(vec)
            res = r.get("result", {})
            out["intent"] = res.get("intent")
            out["gist"] = res.get("gist")
            return out
    raise SystemExit(f"block dims null after {attempts} attempts")


def query_vector(text: str, dims: list[str] | None = None, attempts: int = 3) -> dict:
    ds = dims or DIMS
    for _ in range(attempts):
        out = _parse_dims(generate(text, _dim_questions(ds)), ds)
        if out is not None:
            return out
    raise SystemExit(f"query dims null after {attempts} attempts: {text[:60]}")


def cosine(a: dict, b: dict) -> float:
    dims = set(a) | set(b)
    num = sum(a.get(d, 0.0) * b.get(d, 0.0) for d in dims)
    da = sum(a.get(d, 0.0) ** 2 for d in dims) ** 0.5
    db = sum(b.get(d, 0.0) ** 2 for d in dims) ** 0.5
    return num / (da * db) if da and db else 0.0
