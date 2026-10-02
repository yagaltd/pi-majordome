#!/usr/bin/env python3
"""Slice-5b: confidence-based arm selection + same-product pair-cell positive case.

Part A (offline): confidence arms on the 7 slice-5 probes — pick lexical vs
Jev by per-arm margin (class as tie-break prior).
Part B: MorphEditor-Aug index (8 coarse blocks, gisted), Jev pair cells for
AUG<->SEP and AUG<->A (chunked), cross-session community joins, lexical
routing for the 3 new AUG probes.
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import typellm_client as tc
from eval import block_texts, bm25_rank, jaccard, parse_session, tokens
from slice5 import load_key_jev, jev, cached

OUT = Path(__file__).parent / "results" / "slice5b"
OUT.mkdir(parents=True, exist_ok=True)
S5 = Path(__file__).parent / "results" / "slice5"


def pair_battery(pairs: list[tuple[int, int]], labels: dict[int, dict]) -> dict:
    """Chunked same_topic? batteries; pairs = (i, j) global block indices."""
    out = {}
    CH = 60
    for start in range(0, len(pairs), CH):
        chunk = pairs[start:start + CH]
        fields = sorted({x for pair in chunk for x in pair})
        state = {f"s{i}": f"[{labels[i]['session']}] {labels[i]['gist']} | terms: "
                 f"{', '.join(sorted(list(labels[i]['tokens_hybrid']))[:40])}" for i in fields}
        qs = {f"p{i}_{j}": {"type": "noul", "instructions":
               f"Segments s{i} and s{j} come from different work sessions (same product family). Do they belong to the SAME topic/theme? Answer yes/no."}
              for i, j in chunk}
        ans = jev(state, qs)
        out.update({q: v["noul"] for q, v in ans.items()})
    return out


def main() -> None:
    cfg5 = json.loads((Path(__file__).parent / "key_cross.json").read_text())
    cfgA = json.loads((Path(__file__).parent / "key_cross_aug.json").read_text())

    # ---- build A + SEP from slice-5 caches, AUG fresh ----
    blocks = []
    gists5 = json.loads((S5 / ".." / "cross" / "cross_report.json").read_text())["index"]
    gist_map = {}
    for sess in gists5:
        for i, b in enumerate(sess["blocks"]):
            gist_map[(sess["session"], i)] = b.get("gist", "")
    for sid, scfg in cfg5["sessions"].items():
        turns = parse_session(Path(scfg["path"]).expanduser())
        bs = block_texts(turns, [g["first_turn"] for g in scfg["gold"]])
        for i, b in enumerate(bs):
            b["label"] = scfg["gold"][i]["label"]
            b["session"] = sid
            b["gist"] = gist_map.get((sid, i), "")
            b["tokens_hybrid"] |= tokens(b["gist"])
        blocks.extend(bs)
    n_ab = len(blocks)  # 14

    aug_cfg = cfgA["sessions"]["AUG"]
    turns_aug = parse_session(Path(aug_cfg["path"]).expanduser())
    aug = block_texts(turns_aug, [g["first_turn"] for g in aug_cfg["gold"]])
    for i, b in enumerate(aug):
        b["label"] = aug_cfg["gold"][i]["label"]
        b["session"] = "AUG"
    print(f"index: A+SEP={n_ab} blocks, AUG={len(aug)} blocks ({len(turns_aug)} turns)")

    def gist_new(blist, tag):
        for b in blist:
            r = tc.block_vector(b["text"])
            b["gist"] = r.get("gist", "")
            b["tokens_hybrid"] |= tokens(b["gist"])
            print(f"  [{tag}] {b['label'][:50]:52s} {b['gist'][:64]}")
    def do_gist():
        gist_new(aug, "AUG")
        return [b["gist"] for b in aug]
    aug_gists = cached("aug_gists.json", do_gist)
    for b, g in zip(aug, aug_gists):
        b["gist"] = g
    allb = blocks + aug
    N = len(allb)
    labels = {i: b for i, b in enumerate(allb)}

    # ---- Part B: pair cells (AUG vs everything) ----
    def aug_pairs():
        pairs = [(i, j) for i in range(N) for j in range(i + 1, N)
                 if "AUG" in (labels[i]["session"], labels[j]["session"])
                 and labels[i]["session"] != labels[j]["session"]]
        return pair_battery(pairs, labels)
    cells = cached("aug_pairs.json", aug_pairs)
    vals = sorted(cells.items(), key=lambda kv: -kv[1])
    print(f"\npair cells with AUG: {len(cells)} judgments; top:")
    for k, v in vals[:6]:
        i, j = k[1:].split("_")
        print(f"  {v:.2f}  {labels[int(i)]['session']}:{labels[int(i)]['label'][:30]}  <->  {labels[int(j)]['label'][:30]}")

    for tau in (0.5, 0.6):
        parent = list(range(N))
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        # lexical within-session edges
        for i in range(N):
            for j in range(i + 1, N):
                if labels[i]["session"] == labels[j]["session"] and \
                   jaccard(labels[i]["tokens_hybrid"], labels[j]["tokens_hybrid"]) >= 0.25:
                    parent[find(i)] = find(j)
        # slice-5 cross cells (A<->SEP)
        s5cells = json.loads((S5 / "pair_cells.json").read_text())["pairs"]
        for k, v in s5cells.items():
            if v >= tau:
                i, j = map(int, k[1:].split("_"))
                parent[find(i)] = find(j)
        for k, v in cells.items():
            if v >= tau:
                i, j = map(int, k[1:].split("_"))
                parent[find(i)] = find(j)
        comps = {}
        for i in range(N):
            comps.setdefault(find(i), []).append(i)
        joined = [c for c in comps.values() if len({labels[i]["session"] for i in c}) > 1]
        print(f"tau_jev={tau}: {len(comps)} components, {len(joined)} cross-session joined")
        for c in joined[:5]:
            print("   " + " | ".join(f"{labels[i]['session']}:{labels[i]['label'][:26]}" for i in c))

    # ---- Part A: confidence arms on the 7 slice-5 probes ----
    vecs = {k: [x["noul"] if isinstance(x, dict) else x for x in v]
            for k, v in json.loads((S5 / "jev_vecs.json").read_text()).items()}
    intents = json.loads((S5 / "intents.json").read_text())
    dims = json.loads((S5 / "report.json").read_text())["dims"]

    def cosv(a, b):
        num = sum(x * y for x, y in zip(a, b))
        da = sum(x * x for x in a) ** .5
        db = sum(y * y for y in b) ** .5
        return num / (da * db) if da and db else 0.0

    def federated(q, topk=3):
        pools = {}
        for i in range(n_ab):
            pools.setdefault(blocks[i]["session"], []).append(i)
        merged, seen = [], set()
        for r in range(topk):
            for pool in pools.values():
                sc = bm25_rank([blocks[i] for i in pool], q, "tokens_hybrid")
                order = [pool[j] for j in sorted(range(len(pool)), key=lambda x: -sc[x])]
                if r < len(order) and order[r] not in seen:
                    seen.add(order[r]); merged.append(order[r])
        return merged

    print("\nconfidence arms (7 slice-5 probes):")
    res = {"class": 0, "conf": 0, "oracle": 0}
    for p in probes5:
        exp = next(i for i, b in enumerate(blocks)
                   if b["session"] == p["expect"].split(":")[0] and b["label"] == p["expect"].split(":", 1)[1])
        it = intents[p["id"]]
        cands = federated(tokens(it["search_terms"] or p["query"]))
        sub = [blocks[i] for i in cands]
        sc = bm25_rank(sub, tokens(it["search_terms"] or p["query"]), "tokens_hybrid")
        qv = vecs[f"q:{p['id']}"]
        cosines = [cosv(qv, vecs[f"{blocks[i]['session']}:{i}"]) for i in cands]
        lex_rank = sorted(range(len(cands)), key=lambda x: -sc[x])
        jev_rank = sorted(range(len(cands)), key=lambda x: -cosines[x])
        lex_conf = (sc[lex_rank[0]] - sc[lex_rank[1]]) / (abs(sc[lex_rank[0]]) + 1e-9) if len(lex_rank) > 1 else 0
        jev_conf = cosines[jev_rank[0]] - cosines[jev_rank[1]] if len(jev_rank) > 1 else 0
        arm = "jev" if jev_conf > lex_conf else "lex"
        order = lex_rank if arm == "lex" else jev_rank
        pos = cands[order[0]] if order else None
        r_conf = 1 if pos == exp else 0
        r_class = 1 if (arm if False else True) and False else 0  # class-based from slice-5 rows
        r_lex = 1 if (exp == cands[lex_rank[0]]) else 0
        r_jev = 1 if (exp == cands[jev_rank[0]]) else 0
        res["conf"] += r_conf; res["lex"] = res.get("lex", 0) + r_lex; res["jev"] = res.get("jev", 0) + r_jev
        res["oracle"] += 1 if (r_lex or r_jev) else 0
        print(f"  {p['id']:18s} margins lex={lex_conf:.2f} jev={jev_conf:.2f} -> arm={arm:3s} "
              f"top1={'HIT' if r_conf else 'miss'} (lex:{'H' if r_lex else '.'} jev:{'H' if r_jev else '.'})")
    print(f"\nconfidence: {res['conf']}/7 hit | lex {res.get('lex',0)}/7 | jev {res.get('jev',0)}/7 | oracle(any) {res['oracle']}/7")


probes5 = json.loads((Path(__file__).parent / "key_cross.json").read_text())["probes"]

if __name__ == "__main__":
    main()
