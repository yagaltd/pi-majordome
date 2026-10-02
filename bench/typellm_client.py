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

# Named feature dimensions for slice-one (session-matching dims, chosen
# knowing the domain — same methodology as jevbeddings' 34 banking dims).
DIMS = [
    "code_parser",
    "pi_codemap",
    "typellm_setup",
    "routing",
    "benchmarks_evals",
    "docs_pii",
    "infinite_chat",
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


def _dim_questions(extra: dict | None = None) -> dict:
    q = {
        d: {
            "type": "number",
            "instructions": f"Probability 0.0-1.0 that this conversation segment is about '{d}'. Use the full range; 0.5 means genuinely mixed.",
        }
        for d in DIMS
    }
    if extra:
        q.update(extra)
    return q


def block_vector(text: str, max_chars: int = 6000) -> dict:
    """One batched block-close call: dims + intent + gist."""
    extra = {
        "intent": {
            "type": "string",
            "enum": ["implementation", "investigation", "evaluation", "documentation", "discussion"],
            "instructions": "Primary intent of this segment.",
        },
        "gist": {"type": "string", "instructions": "One sentence: what was done or decided."},
    }
    r = generate(text[:max_chars], _dim_questions(extra))
    return r.get("result", {})


def query_vector(text: str) -> dict:
    r = generate(text, _dim_questions())
    return {d: float(r.get("result", {}).get(d, 0.0) or 0.0) for d in DIMS}


def cosine(a: dict, b: dict) -> float:
    num = sum(a.get(d, 0.0) * b.get(d, 0.0) for d in DIMS)
    da = math_sqrt(sum(a.get(d, 0.0) ** 2 for d in DIMS))
    db = math_sqrt(sum(b.get(d, 0.0) ** 2 for d in DIMS))
    return num / (da * db) if da and db else 0.0


def math_sqrt(x: float) -> float:
    return x ** 0.5
