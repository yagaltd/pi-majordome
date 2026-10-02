#!/usr/bin/env python3
"""Slice-one eval: offline replay of a pi session through the infinite-chat indexer.

Pipeline: session JSONL -> turns -> boundary detection (Jaccard sweep) ->
block segmentation scored against a hand-labeled key -> retrieval probes
(Jaccard vs BM25 vs TypeLLM named-vector cosine).

Usage:
  python3 bench/eval.py --session <path.jsonl> --key bench/key.json
  python3 bench/eval.py ... --classify          # adds TypeLLM vector tier
  python3 bench/eval.py ... --strategy centroid --tau 0.08
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

STOP = set(
    """the a an and or of to in on for with is are was were be been being i you he she it we they
this that these those do does did done can could will would should shall may might must have has had
my your our their its his her as at by from if then than so not no nor but about into over under
again further more most some any each few other such only own same too very s t just don now
what which who whom how why when where ok yes yeah okay go continue wait also""".split()
)

TOK = re.compile(r"[a-z0-9_]{2,}")


def textof(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def tokens(text: str) -> set:
    return {t for t in TOK.findall(text.lower()) if t not in STOP and not t.isdigit()}


def parse_session(path: Path) -> list[dict]:
    """Walk the JSONL; a turn = user message + assistant/tool text until next user message.

    Skips tool/toolResult wrappers, dedupes retried turns (identical user text).
    """
    turns: list[dict] = []
    cur: dict | None = None
    for line in path.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") != "message":
            continue
        m = e.get("message", {})
        role, txt = m.get("role"), textof(m.get("content")).strip()
        if role == "user":
            if not txt or txt.startswith("<") or "system-reminder" in txt[:30]:
                continue
            norm = re.sub(r"\s+", " ", txt.lower())
            if cur and cur["user_norm"] == norm:
                continue  # retried turn
            cur = {"user": txt, "user_norm": norm, "text": txt, "n": len(turns) + 1}
            turns.append(cur)
        elif role == "assistant" and cur is not None:
            cur["text"] += "\n" + txt
    for t in turns:
        t["tokens"] = tokens(t["text"])
    return turns


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def detect_boundaries(turns: list[dict], strategy: str, tau: float, min_size: int = 2) -> list[int]:
    """Return first-turn indices of each predicted block (always includes turn 1)."""
    bounds = [1]
    if strategy == "chained":
        for i in range(1, len(turns)):
            if len(turns) - bounds[-1] < min_size:
                continue
            if jaccard(turns[i]["tokens"], turns[i - 1]["tokens"]) < tau:
                bounds.append(i + 1)
    else:  # centroid
        for i in range(1, len(turns)):
            if len(turns) - bounds[-1] < min_size:
                continue
            start = bounds[-1] - 1
            centroid: set = set()
            for t in turns[start:i]:
                centroid |= t["tokens"]
            if jaccard(turns[i]["tokens"], centroid) < tau:
                bounds.append(i + 1)
    return bounds


def prf(pred: list[int], gold: list[int], tol: int = 1) -> dict:
    """Boundary P/R/F1 with +-tol turn tolerance."""
    hits = sum(1 for p in pred if any(abs(p - g) <= tol for g in gold))
    prec = hits / len(pred) if pred else 0.0
    rec = hits / len(gold) if gold else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"precision": round(prec, 3), "recall": round(rec, 3), "f1": round(f1, 3)}


def bm25_rank(blocks: list[dict], query_tokens: set, k1: float = 1.5, b: float = 0.75) -> list[float]:
    """Tiny BM25; returns score per block."""
    n = len(blocks)
    avgdl = sum(len(b["tokens"]) for b in blocks) / n
    df = Counter()
    for blk in blocks:
        df.update(blk["tokens"])
    scores = []
    for blk in blocks:
        s = 0.0
        dl = len(blk["tokens"])
        for term in query_tokens:
            if term not in blk["tokens"]:
                continue
            idf = math.log((n - df[term] + 0.5) / (df[term] + 0.5) + 1)
            tf = 1  # binary tf: token sets, adequate at block granularity
            s += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))
        scores.append(s)
    return scores


def label_of(blocks: list[dict], idx: int) -> str:
    return blocks[idx]["label"] if 0 <= idx < len(blocks) else "?"


def block_texts(turns: list[dict], firsts: list[int]) -> list[dict]:
    """Materialize blocks (concatenated turn text) from boundary firsts."""
    blocks = []
    for j, start in enumerate(firsts):
        end = firsts[j + 1] - 1 if j + 1 < len(firsts) else len(turns)
        blocks.append({
            "label": f"block{j}",
            "first_turn": start,
            "last_turn": end,
            "text": "\n".join(t["text"] for t in turns[start - 1 : end]),
            "tokens": set().union(*(t["tokens"] for t in turns[start - 1 : end])),
        })
    return blocks


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True, help="path to session .jsonl")
    ap.add_argument("--key", default=str(Path(__file__).parent / "key.json"))
    ap.add_argument("--strategy", choices=["chained", "centroid"], default="centroid")
    ap.add_argument("--tau", type=float, default=None, help="fixed threshold (skips sweep)")
    ap.add_argument("--min-size", type=int, default=2)
    ap.add_argument("--classify", action="store_true", help="add TypeLLM vector tier")
    ap.add_argument("--out", default=str(Path(__file__).parent / "results"))
    args = ap.parse_args()

    key = json.loads(Path(args.key).read_text())
    gold_bounds = [b["first_turn"] for b in key["blocks"]]
    turns = parse_session(Path(args.session).expanduser())
    print(f"parsed {len(turns)} turns from {args.session}")

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {"turns": len(turns), "gold_blocks": len(key["blocks"])}

    # --- boundary sweep ---
    taus = [args.tau] if args.tau else [round(0.01 + 0.015 * i, 3) for i in range(26)]
    sweep = []
    for tau in taus:
        pred = detect_boundaries(turns, args.strategy, tau, args.min_size)
        sweep.append({"tau": tau, "n_blocks": len(pred), **prf(pred, gold_bounds)})
    best = max(sweep, key=lambda s: s["f1"])
    report["sweep"] = sweep
    report["best"] = best
    print(f"boundary sweep ({args.strategy}): best F1={best['f1']} at tau={best['tau']} ({best['n_blocks']} blocks)")

    # --- clustering accuracy at best tau (turn -> gold label) ---
    pred = detect_boundaries(turns, args.strategy, best["tau"], args.min_size)
    turn_label = []
    for i in range(1, len(turns) + 1):
        gi = next((g for g in key["blocks"] if g["first_turn"] <= i <= g["last_turn"]), None)
        turn_label.append(gi["label"] if gi else "?")
    correct = 0
    for j, start in enumerate(pred):
        end = pred[j + 1] - 1 if j + 1 < len(pred) else len(turns)
        majority = Counter(turn_label[start - 1 : end]).most_common(1)[0][0]
        correct += sum(1 for l in turn_label[start - 1 : end] if l == majority)
    report["cluster_accuracy"] = round(correct / len(turns), 3)
    print(f"clustering accuracy vs gold labels: {report['cluster_accuracy']}")

    # --- retrieval over GOLD blocks (isolate retrieval from boundary quality) ---
    gold_blocks = block_texts(turns, gold_bounds)
    for b, kb in zip(gold_blocks, key["blocks"]):
        b["label"] = kb["label"]  # restore real labels (block_texts uses placeholders)
    probes = key["probes"]
    rows = []
    vectors: list[dict] = []
    if args.classify:
        from typellm_client import block_vector, cosine, query_vector

        print(f"classifying {len(gold_blocks)} blocks via TypeLLM...")
        for b in gold_blocks:
            r = block_vector(b["text"])
            b["vec"] = {d: float(r.get(d, 0.0) or 0.0) for d in __import__("typellm_client").DIMS}
            b["gist"] = r.get("gist", "")
            vectors.append(b["vec"])
            print(f"  {b['label']}: intent={r.get('intent')} gist={r.get('gist', '')[:70]}")
    for p in probes:
        qtok = tokens(p["query"])
        expect = p["expect"]
        jac = sorted(range(len(gold_blocks)), key=lambda i: -jaccard(qtok, gold_blocks[i]["tokens"]))
        bm = sorted(range(len(gold_blocks)), key=lambda i: -bm25_rank(gold_blocks, qtok)[i])
        exp_idx = next(i for i, b in enumerate(gold_blocks) if b["label"] == expect)
        row = {
            "probe": p["id"],
            "expect": expect,
            "jaccard_rank": jac.index(exp_idx) + 1,
            "bm25_rank": bm.index(exp_idx) + 1,
        }
        if args.classify:
            from typellm_client import query_vector as qv

            qv_vec = qv(p["query"])
            cos = sorted(range(len(gold_blocks)), key=lambda i: -cosine(qv_vec, gold_blocks[i]["vec"]))
            row["cosine_rank"] = cos.index(exp_idx) + 1
        rows.append(row)
        print(f"probe {p['id']}: {row}")
    report["retrieval"] = rows
    report["block_gists"] = [
        {
            "label": b["label"],
            "turns": [b["first_turn"], b["last_turn"]],
            "gist": b.get("gist", ""),
            "vec": b.get("vec"),
        }
        for b in gold_blocks
    ]

    (out_dir / "report.json").write_text(json.dumps(report, indent=2))
    print(f"\nreport -> {out_dir}/report.json")


if __name__ == "__main__":
    main()
