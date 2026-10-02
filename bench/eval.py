#!/usr/bin/env python3
"""Slice-one/two eval: offline replay of a pi session through the topic-memory indexer.

Pipeline: session JSONL -> turns -> boundary detection (Jaccard sweep:
chained/centroid/ema) -> block segmentation scored against a hand-labeled key ->
retrieval probes (union vs hybrid lexical, optional TypeLLM named-vector cosine,
optional recency tiebreak).

Usage:
  python3 bench/eval.py --session <path.jsonl> --key bench/key.json
  python3 bench/eval.py ... --classify               # v1 dims (slice-one)
  python3 bench/eval.py ... --classify --dimset v2   # artifact/activity dims
  python3 bench/eval.py ... --strategy ema --recency 0.05
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
            cur = {
                "user": txt,
                "user_norm": norm,
                "text": txt,
                "n": len(turns) + 1,
                "utokens": tokens(txt),
            }
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


def detect_boundaries(turns: list[dict], strategy: str, tau: float, min_size: int = 2,
                      decay: float = 0.85, keep: float = 0.3) -> list[int]:
    """Return first-turn indices of each predicted block (always includes turn 1)."""
    bounds = [1]
    if strategy == "chained":
        for i in range(1, len(turns)):
            if len(turns) - bounds[-1] < min_size:
                continue
            if jaccard(turns[i]["tokens"], turns[i - 1]["tokens"]) < tau:
                bounds.append(i + 1)
    elif strategy == "ema":
        # running token set with exponential decay: old topics fade, recent dominate
        ema: dict[str, float] = {}
        for i, t in enumerate(turns):
            for k in list(ema):
                ema[k] *= decay
                if ema[k] < keep:
                    del ema[k]
            new = t["tokens"]
            if i > 0 and len(turns) - bounds[-1] >= min_size:
                if jaccard(set(ema), new) < tau:
                    bounds.append(i + 1)
            for k in new:
                ema[k] = ema.get(k, 0.0) + 1.0
    else:  # centroid
        for i in range(1, len(turns)):
            if len(turns) - bounds[-1] < min_size:
                continue
            centroid: set = set()
            for t in turns[bounds[-1] - 1 : i]:
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


def bm25_rank(blocks: list[dict], query_tokens: set, field: str = "tokens",
              k1: float = 1.5, b: float = 0.75) -> list[float]:
    """Tiny BM25 (binary tf: token sets); returns score per block."""
    n = len(blocks)
    avgdl = sum(len(blk[field]) for blk in blocks) / n
    df: Counter = Counter()
    for blk in blocks:
        df.update(blk[field])
    scores = []
    for blk in blocks:
        s = 0.0
        dl = len(blk[field])
        for term in query_tokens:
            if term not in blk[field]:
                continue
            idf = math.log((n - df[term] + 0.5) / (df[term] + 0.5) + 1)
            tf = 1
            s += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))
        scores.append(s)
    return scores


def block_texts(turns: list[dict], firsts: list[int], tail_k: int = 3) -> list[dict]:
    """Materialize blocks. tokens = whole-block union; tokens_hybrid = user-turn
    tokens (dense intent statements) + last tail_k turns (recent context)."""
    blocks = []
    for j, start in enumerate(firsts):
        end = firsts[j + 1] - 1 if j + 1 < len(firsts) else len(turns)
        seg = turns[start - 1 : end]
        hyb: set = set()
        for t in seg:
            hyb |= t["utokens"]
        for t in seg[-tail_k:]:
            hyb |= t["tokens"]
        blocks.append({
            "label": f"block{j}",
            "first_turn": start,
            "last_turn": end,
            "text": "\n".join(t["text"] for t in seg),
            "tokens": set().union(*(t["tokens"] for t in seg)),
            "tokens_hybrid": hyb,
        })
    return blocks


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True, help="path to session .jsonl")
    ap.add_argument("--key", default=str(Path(__file__).parent / "key.json"))
    ap.add_argument("--strategy", choices=["chained", "centroid", "ema"], default="centroid")
    ap.add_argument("--tau", type=float, default=None, help="fixed threshold (skips sweep)")
    ap.add_argument("--min-size", type=int, default=2)
    ap.add_argument("--classify", action="store_true", help="add TypeLLM vector tier")
    ap.add_argument("--dimset", choices=["v1", "v2"], default="v1",
                    help="v1=session topics; v2=artifact/activity dims (slice-two)")
    ap.add_argument("--recency", type=float, default=0.0,
                    help="recency tiebreak weight: score += w * (block_pos / n)")
    ap.add_argument("--rewrite", action="store_true",
                    help="TypeLLM meta-query rewrite before lexical scoring (slice-three)")
    ap.add_argument("--induce", action="store_true",
                    help="with --classify: induce dim vocabulary from blocks instead of fixed dims")
    ap.add_argument("--out", default=str(Path(__file__).parent / "results"))
    args = ap.parse_args()

    key = json.loads(Path(args.key).read_text())
    gold_bounds = [b["first_turn"] for b in key["blocks"]]
    turns = parse_session(Path(args.session).expanduser())
    print(f"parsed {len(turns)} turns from session")

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    report: dict = {"turns": len(turns), "gold_blocks": len(key["blocks"]),
                    "dimset": args.dimset, "recency": args.recency}

    # --- boundary sweep ---
    taus = [args.tau] if args.tau else [round(0.01 + 0.015 * i, 3) for i in range(26)]
    sweep = []
    for tau in taus:
        pred = detect_boundaries(turns, args.strategy, tau, args.min_size)
        sweep.append({"tau": tau, "n_blocks": len(pred), **prf(pred, gold_bounds)})
    best = max(sweep, key=lambda s: s["f1"])
    report["strategy"] = args.strategy
    report["sweep"] = sweep
    report["best"] = best
    print(f"boundary sweep ({args.strategy}): best F1={best['f1']} at tau={best['tau']} ({best['n_blocks']} blocks)")

    # --- clustering accuracy at best tau ---
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
        b["label"] = kb["label"]
    probes = key["probes"]
    dims = None
    if args.classify:
        import typellm_client as tc

        dims = tc.DIMS_V2 if args.dimset == "v2" else tc.DIMS
        if args.induce:
            seen: set = set()
            for b in gold_blocks:
                for d in tc.induce_dims(b["text"]):
                    seen.add(d)
            dims = sorted(seen)[:24]
            report["induced_dims"] = dims
            print(f"induced dim vocabulary ({len(dims)}): {', '.join(dims)}")
        print(f"classifying {len(gold_blocks)} blocks via TypeLLM...")
        for b in gold_blocks:
            r = tc.block_vector(b["text"], dims=dims)
            b["vec"] = {d: float(r.get(d, 0.0) or 0.0) for d in dims}
            b["gist"] = r.get("gist", "")
            b["tokens_hybrid"] |= tokens(b["gist"])
            print(f"  {b['label'][:44]:46s} intent={r.get('intent')} gist={b['gist'][:60]}")

    def rrf(orders: list[list[int]], k: int = 60) -> list[int]:
        """Reciprocal-rank fusion over method orders."""
        s: dict = {}
        for order in orders:
            for pos, bi in enumerate(order):
                s[bi] = s.get(bi, 0.0) + 1.0 / (k + pos + 1)
        return sorted(range(len(s)), key=lambda i: -s.get(i, 0.0))

    rows = []
    for p in probes:
        expect = p["expect"]
        exp_idx = next(i for i, b in enumerate(gold_blocks) if b["label"] == expect)
        n = len(gold_blocks)
        row: dict = {"probe": p["id"], "expect": expect, "rewrite": None}

        def rank_of(order: list[int]) -> int:
            return order.index(exp_idx) + 1

        def lex_orders(q: set) -> dict:
            jac_u = sorted(range(n), key=lambda i: -jaccard(q, gold_blocks[i]["tokens"]))
            bm_u = sorted(range(n), key=lambda i: -bm25_rank(gold_blocks, q, "tokens")[i])
            jac_h = sorted(range(n), key=lambda i: -jaccard(q, gold_blocks[i]["tokens_hybrid"]))
            base_h = bm25_rank(gold_blocks, q, "tokens_hybrid")
            if args.recency > 0:
                base_h = [sc + args.recency * ((i + 1) / n) for i, sc in enumerate(base_h)]
            bm_h = sorted(range(n), key=lambda i: -base_h[i])
            return {"jac_union": jac_u, "bm25_union": bm_u, "jac_hybrid": jac_h, "bm25_hybrid": bm_h}

        o = lex_orders(tokens(p["query"]))
        for name, order in o.items():
            row[name] = rank_of(order)
        row["rrf_lex"] = rank_of(rrf(list(o.values())))
        if args.rewrite:
            import typellm_client as tc

            rw = tc.rewrite_query(p["query"])
            row["rewrite"] = rw
            o2 = lex_orders(tokens(rw))
            row["bm25_rw"] = rank_of(o2["bm25_hybrid"])
            row["rrf_rw"] = rank_of(rrf(list(o2.values())))
        if args.classify:
            import typellm_client as tc

            qv = tc.query_vector(p["query"], dims=dims)
            cos = sorted(range(n), key=lambda i: -tc.cosine(qv, gold_blocks[i]["vec"]))
            row["cosine"] = rank_of(cos)
            row["query_vec"] = qv
        rows.append(row)
        print("probe " + p["id"] + ": " + json.dumps(row))
    report["retrieval"] = rows

    def r1(field: str) -> str:
        vals = [r[field] for r in rows if r.get(field)]
        return f"{sum(1 for v in vals if v == 1)}/{len(vals)}" if vals else "-"

    def r2(field: str) -> str:
        vals = [r[field] for r in rows if r.get(field)]
        return f"{sum(1 for v in vals if v <= 2)}/{len(vals)}" if vals else "-"

    fields = ["jac_union", "bm25_union", "jac_hybrid", "bm25_hybrid",
              "rrf_lex", "bm25_rw", "rrf_rw", "cosine"]
    report["summary"] = {f: {"recall@1": r1(f), "recall@2": r2(f)} for f in fields}
    print("\nsummary:", json.dumps(report["summary"], indent=1))

    report["block_gists"] = [
        {"label": b["label"], "turns": [b["first_turn"], b["last_turn"]],
         "gist": b.get("gist", ""), "vec": b.get("vec")}
        for b in gold_blocks
    ]

    (out_dir / "report.json").write_text(json.dumps(report, indent=2))
    print(f"\nreport -> {out_dir}/report.json")


if __name__ == "__main__":
    main()
