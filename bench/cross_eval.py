#!/usr/bin/env python3
"""Slice-four: cross-session index + time-travel probes + community sweep.

Builds an EMA-blocked, gist-annotated index over TWO sessions, then:
1. time-travel rerank of probes with asked_at (candidates = blocks fully
   before that turn; the live router never sees the future or the in-context
   current block),
2. cross-session recall probes (gold block may live in either session),
3. connected-components sweep across all blocks (Leiden-lite; upgrade later).

Usage: python3 bench/cross_eval.py [--rewrite]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import typellm_client as tc
from eval import block_texts, bm25_rank, detect_boundaries, jaccard, parse_session, tokens


def rrf(orders: list[list[int]], k: int = 60) -> list[int]:
    s: dict = {}
    for order in orders:
        for pos, bi in enumerate(order):
            s[bi] = s.get(bi, 0.0) + 1.0 / (k + pos + 1)
    return sorted(range(len(s)), key=lambda i: -s.get(i, 0.0))


def gist_blocks(blocks: list[dict], tag: str) -> None:
    for b in blocks:
        r = tc.block_vector(b["text"])
        b["gist"] = r.get("gist", "")
        b["intent"] = r.get("intent")
        b["tokens_hybrid"] |= tokens(b["gist"])
        print(f"  [{tag}] {b['label'][:52]:54s} {b['gist'][:66]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default=str(Path(__file__).parent / "key_cross.json"))
    ap.add_argument("--ema-tau", type=float, default=0.07)
    ap.add_argument("--min-size", type=int, default=4)
    ap.add_argument("--rewrite", action="store_true")
    ap.add_argument("--federate", action="store_true",
                    help="per-session top-k pooling before merge (for cross-intent probes)")
    ap.add_argument("--out", default=str(Path(__file__).parent / "results"))
    args = ap.parse_args()

    cfg = json.loads(Path(args.key).read_text())
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    report: dict = {"index": [], "probes": [], "communities": []}

    # --- build the cross-session index ---
    all_blocks: list[dict] = []
    for sid, scfg in cfg["sessions"].items():
        turns = parse_session(Path(scfg["path"]).expanduser())
        gold_firsts = [b["first_turn"] for b in scfg["gold"]]
        if scfg.get("ema", False):
            firsts = detect_boundaries(turns, "ema", args.ema_tau, args.min_size)
            blocks = block_texts(turns, firsts)
        else:
            blocks = block_texts(turns, gold_firsts)
        for i, b in enumerate(blocks):
            b["label"] = scfg["gold"][i]["label"] if i < len(scfg["gold"]) else f"{sid}-block{i}"
            b["session"] = sid
        print(f"session {sid}: {len(turns)} turns -> {len(blocks)} blocks; gisting...")
        gist_blocks(blocks, sid)
        report["index"].append({
            "session": sid,
            "turns": len(turns),
            "blocks": [{"label": b["label"], "turns": [b["first_turn"], b["last_turn"]],
                        "gist": b["gist"], "intent": b.get("intent")} for b in blocks],
        })
        all_blocks.extend(blocks)
    n = len(all_blocks)
    print(f"\nindex: {n} blocks across {len(cfg['sessions'])} sessions")

    # --- probes: time-travel + cross-session ---
    rows = []
    for p in cfg["probes"]:
        exp_sid, exp_label = p["expect"].split(":", 1)
        exp_idx = next(i for i, b in enumerate(all_blocks)
                       if b["session"] == exp_sid and b["label"] == exp_label)

        cands = list(range(n))
        if p.get("asked_at"):
            t = p["asked_at"]
            # live router: only fully-formed past blocks, never the current one
            cands = [i for i, b in enumerate(all_blocks)
                     if b["session"] == "A" and b["last_turn"] < t]
        if not cands:
            rows.append({"probe": p["id"], "note": "expected block is current -> continuation, no retrieval"})
            continue

        def rank_of(order: list[int]) -> int:
            return cands.index(exp_idx) + 1 if exp_idx in cands else -1

        def federated_order(q: set, topk: int = 3) -> list[int]:
            pools: dict = {}
            for i in cands:
                pools.setdefault(all_blocks[i]["session"], []).append(i)
            orders = []
            for pool in pools.values():
                sc = bm25_rank([all_blocks[i] for i in pool], q, "tokens_hybrid")
                orders.append([pool[i] for i in sorted(range(len(pool)), key=lambda j: -sc[j])[:topk]])
            merged, seen = [], set()
            for r in range(topk):
                for o in orders:
                    if r < len(o) and o[r] not in seen:
                        seen.add(o[r])
                        merged.append(o[r])
            return merged

        def hybrid_order(q: set) -> list[int]:
            base = bm25_rank([all_blocks[i] for i in cands], q, "tokens_hybrid")
            return [cands[i] for i in sorted(range(len(cands)), key=lambda j: -base[j])]

        o = hybrid_order(tokens(p["query"]))
        row = {"probe": p["id"], "expect": p["expect"], "n_cands": len(cands),
               "bm25_hybrid": rank_of(o)}
        row["rrf_self"] = rank_of(o)  # single-method; RRF needs multiple orders
        if args.rewrite:
            rw = tc.rewrite_query(p["query"])
            row["rewrite"] = rw
            o2 = hybrid_order(tokens(rw))
            row["bm25_rw"] = rank_of(o2)
            row["rrf_rw"] = rank_of(rrf([o, o2]))
        if args.federate:
            merged = federated_order(tokens(p["query"]))
            row["federated"] = merged.index(exp_idx) + 1 if exp_idx in merged else -1
        rows.append(row)
        print("probe " + p["id"] + ": " + json.dumps(row))
    report["probes"] = rows

    # --- community sweep (CC at edge threshold) ---
    for tau in (0.08, 0.15, 0.25, 0.3):
        parent = list(range(n))

        def find(x: int) -> int:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for i in range(n):
            for j in range(i + 1, n):
                if jaccard(all_blocks[i]["tokens_hybrid"], all_blocks[j]["tokens_hybrid"]) >= tau:
                    parent[find(i)] = find(j)
        comps: dict = {}
        for i in range(n):
            comps.setdefault(find(i), []).append(i)
        grouped = sorted(comps.values(), key=len, reverse=True)
        report["communities"].append({
            "tau": tau,
            "n_components": len(grouped),
            "largest": [[f"{all_blocks[i]['session']}:{all_blocks[i]['label'][:36]}" for i in c]
                        for c in grouped[:3]],
        })
        print(f"tau={tau}: {len(grouped)} components; largest={[len(c) for c in grouped[:3]]}")

    (out_dir / "cross_report.json").write_text(json.dumps(report, indent=2))
    print(f"\nreport -> {out_dir}/cross_report.json")


if __name__ == "__main__":
    main()
