#!/usr/bin/env python3
"""Slice-five: Jev pair-cell edges, intent-specialist routing, community-as-unit.

Reuses the slice-4 two-session index (gists cached in cross_report.json).
New model work (all cached under bench/results/slice5/):
  - induce dims for session B blocks (TypeLLM)
  - Jev vectors: 14 blocks + 7 probes over the union dim vocabulary
  - Jev pair cells: same_topic? for all 48 cross-session block pairs
  - TypeLLM DAG intent per probe (intent -> search_terms depends_on)

Then: communities = lexical CC within-session + Jev cross edges;
routing = federated candidates, arm chosen by intent (specialists,
not averages); community-as-unit ranking.
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import typellm_client as tc
from eval import block_texts, bm25_rank, jaccard, parse_session, tokens

OUT = Path(__file__).parent / "results" / "slice5"
OUT.mkdir(parents=True, exist_ok=True)


def load_key_jev() -> str:
    for line in Path.home().joinpath("Documents/current/pi-codemap/.env").read_text().splitlines():
        if "TYPESAFE_API_KEY" in line and "=" in line:
            return line.split("=", 1)[1].strip()
    raise SystemExit("no TYPESAFE_API_KEY")


def jev(state: dict, questions: dict) -> dict:
    body = json.dumps({"state": state, "model": "jev-latest", "questions": questions}).encode()
    req = urllib.request.Request("https://api.typesafe.ai/v1/systemone", data=body,
        headers={"Authorization": f"Bearer {load_key_jev()}", "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)["answers"]


def cached(path: str, fn):
    p = OUT / path
    if p.exists():
        return json.loads(p.read_text())
    v = fn()
    p.write_text(json.dumps(v))
    return v


def build_index(cfg: dict) -> list[dict]:
    xrep = json.loads((OUT.parent / "cross" / "cross_report.json").read_text())
    gists = {}
    for sess in xrep["index"]:
        for i, b in enumerate(sess["blocks"]):
            gists[(sess["session"], i)] = b.get("gist", "")
    allb = []
    for sid, scfg in cfg["sessions"].items():
        turns = parse_session(Path(scfg["path"]).expanduser())
        blocks = block_texts(turns, [g["first_turn"] for g in scfg["gold"]])
        for i, b in enumerate(blocks):
            b["label"] = scfg["gold"][i]["label"]
            b["session"] = sid
            b["gist"] = gists.get((sid, i), "")
            b["tokens_hybrid"] |= tokens(b["gist"])
        allb.extend(blocks)
    return allb


def main() -> None:
    cfg = json.loads((Path(__file__).parent / "key_cross.json").read_text())
    blocks = build_index(cfg)
    n = len(blocks)
    print(f"index: {n} blocks (gists reused from slice-4)")

    # --- 1. union dim vocabulary (A induced in slice-3 + B induced now) ---
    a_dims = json.loads((OUT.parent / "slice3" / "report.json").read_text())["induced_dims"]
    def induce_b():
        dims = []
        for b in blocks:
            if b["session"] != "B":
                continue
            dims.extend(tc.induce_dims(b["text"]))
        return sorted(set(dims) - set(a_dims))
    b_new = cached("b_dims.json", induce_b)
    dims = (a_dims + b_new)[:40]
    print(f"dim vocabulary: {len(a_dims)} (A induced) + {len(b_new)} (B induced) = {len(dims)}")

    # --- 2. Jev vectors (blocks + probes) ---
    probes = cfg["probes"]
    def jev_vecs():
        vecs = {}
        for i, b in enumerate(blocks):
            qs = {d: {"type": "noul", "instructions":
                   f"State field 'seg' is a conversation segment from a coding-agent session. Is this segment primarily about '{d}'? Answer yes/no."}
                  for d in dims}
            ans = jev({"seg": b["text"][:2500]}, qs)
            vecs[f"{b['session']}:{i}"] = [ans[d] for d in dims]
        for p in probes:
            qs = {d: {"type": "noul", "instructions":
                   f"State field 'seg' is a user chat message from a coding-agent session. Is this message primarily about '{d}'? Answer yes/no."}
                  for d in dims}
            ans = jev({"seg": p["query"]}, qs)
            vecs[f"q:{p['id']}"] = [ans[d] for d in dims]
        return vecs
    vecs = cached("jev_vecs.json", jev_vecs)
    vecs = {k: [x["noul"] if isinstance(x, dict) else x for x in v] for k, v in vecs.items()}

    def cos(a: list, b: list) -> float:
        num = sum(x * y for x, y in zip(a, b))
        da = sum(x * x for x in a) ** 0.5
        db = sum(x * x for x in b) ** 0.5
        return num / (da * db) if da and db else 0.0

    # --- 3. Jev pair cells (48 cross-session pairs) ---
    def pair_cells():
        state, qs = {}, {}
        for i, b in enumerate(blocks):
            state[f"s{i}"] = f"[{b['session']}] {b['gist']} | terms: {', '.join(sorted(list(b['tokens_hybrid']))[:40])}"
        k = 0
        for i in range(n):
            for j in range(i + 1, n):
                if blocks[i]["session"] != blocks[j]["session"]:
                    qs[f"p{i}_{j}"] = {"type": "noul", "instructions":
                        f"Segments s{i} and s{j} come from different work sessions. Do they belong to the SAME topic/theme? Answer yes/no."}
                    k += 1
        return {"pairs": {q: v["noul"] for q, v in jev(state, qs).items()}}
    cells = cached("pair_cells.json", pair_cells)
    print(f"pair cells: {len(cells['pairs'])} cross-session judgments")

    # --- 4. communities: lexical CC within-session + Jev cross edges ---
    def build_communities(tau_lex: float, tau_jev: float):
        parent = list(range(n))
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for i in range(n):
            for j in range(i + 1, n):
                same = blocks[i]["session"] == blocks[j]["session"]
                if same and jaccard(blocks[i]["tokens_hybrid"], blocks[j]["tokens_hybrid"]) >= tau_lex:
                    parent[find(i)] = find(j)
                elif not same and cells["pairs"].get(f"p{i}_{j}", 0.0) >= tau_jev:
                    parent[find(i)] = find(j)
        comps = {}
        for i in range(n):
            comps.setdefault(find(i), []).append(i)
        return list(comps.values())
    communities = build_communities(0.25, 0.5)
    joined = [c for c in communities if len({blocks[i]["session"] for i in c}) > 1]
    print(f"communities: {len(communities)} components, {len(joined)} cross-session")
    for c in joined:
        print("   joined: " + " | ".join(f"{blocks[i]['session']}:{blocks[i]['label'][:30]}" for i in c))

    # --- 5. TypeLLM DAG intent per probe ---
    def intents():
        out = {}
        for p in probes:
            r = tc.generate(p["query"], {
                "intent": {"type": "string",
                           "enum": ["definition_recall", "incident_specific", "continuation"],
                           "instructions": "Classify this user message in a coding-agent chat: definition_recall = asks what something is / summarize / remind me; incident_specific = refers to a concrete event (a crash, a bug, a specific run); continuation = continues the current topic."},
                "search_terms": {"type": "string", "depends_on": ["intent"],
                                 "instructions": "5-12 terse content keywords for retrieving the relevant past work. Strip meta framing."},
            })
            res = r.get("result", {})
            out[p["id"]] = {"intent": res.get("intent"), "search_terms": res.get("search_terms", "")}
        return out
    intent = cached("intents.json", intents)
    for pid, v in intent.items():
        it_s = str(v["intent"])
        print(f"  intent {pid:18s} -> {it_s:18s} terms: {str(v['search_terms'])[:50]}")

    # --- 6. routing: federated candidates, specialist arm, community-as-unit ---
    def federated_set(q: set, topk: int = 3) -> list[int]:
        pools: dict = {}
        for i in range(n):
            pools.setdefault(blocks[i]["session"], []).append(i)
        merged, seen = [], set()
        for r in range(topk):
            for pool in pools.values():
                sc = bm25_rank([blocks[i] for i in pool], q, "tokens_hybrid")
                order = [pool[j] for j in sorted(range(len(pool)), key=lambda x: -sc[x])]
                if r < len(order) and order[r] not in seen:
                    seen.add(order[r])
                    merged.append(order[r])
        return merged

    def arm_ranks(cands: list[int], q: set, qvec: list, arm: str) -> list[int]:
        if arm == "jev":
            return sorted(cands, key=lambda i: -cos(qvec, vecs[f"{blocks[i]['session']}:{blocks.index(blocks[i])}"]))
        base = bm25_rank([blocks[i] for i in cands], q, "tokens_hybrid")
        return [cands[j] for j in sorted(range(len(cands)), key=lambda x: -base[x])]

    def comm_of(i: int) -> int:
        for ci, c in enumerate(communities):
            if i in c:
                return ci
        return -1

    rows = []
    for p in probes:
        exp_sid, exp_label = p["expect"].split(":", 1)
        exp = next(i for i, b in enumerate(blocks) if b["session"] == exp_sid and b["label"] == exp_label)
        it = intent[p["id"]]
        q_rw = tokens(it["search_terms"] or p["query"])
        cands = federated_set(q_rw)
        arm = "jev" if it["intent"] == "definition_recall" else "lex"
        order = arm_ranks(cands, q_rw, vecs[f"q:{p['id']}"], arm)
        # community-as-unit: winner community first, then best member
        comm_score: dict = {}
        for r, i in enumerate(order):
            ci = comm_of(i)
            comm_score.setdefault(ci, 10 ** 6)
            comm_score[ci] = min(comm_score[ci], r + 1)
        comms_sorted = sorted(comm_score, key=lambda c: comm_score[c])
        cu_order = [i for c in comms_sorted for i in sorted(candidates_in(c, communities), key=lambda x: order.index(x) if x in order else 999)]
        q0 = tokens(p["query"])
        lex0 = arm_ranks(cands, q0, vecs[f"q:{p['id']}"], "lex")
        jv0 = arm_ranks(cands, q0, vecs[f"q:{p['id']}"], "jev")
        naive = rrf_merge([lex0, jv0])
        def rk(o):
            return o.index(exp) + 1 if exp in o else -1
        rows.append({"probe": p["id"], "intent": it["intent"], "arm": arm,
                     "specialist": rk(order), "community_unit": rk(cu_order),
                     "lex": rk(lex0), "jev": rk(jv0), "naive_rrf": rk(naive)})
        print("probe " + p["id"] + ": " + json.dumps(rows[-1]))

    summary = {}
    for k in ("specialist", "community_unit", "lex", "jev", "naive_rrf"):
        vals = [r[k] for r in rows if r.get(k, -1) > 0]
        summary[k] = {"r1": sum(1 for v in vals if v == 1), "of": len(rows)}
    print("\nsummary: " + json.dumps(summary))
    (OUT / "report.json").write_text(json.dumps(
        {"summary": summary, "rows": rows, "communities": communities,
         "dims": dims, "pair_cells": cells["pairs"]}, indent=1))


def candidates_in(ci: int, communities: list[list[int]]) -> list[int]:
    return communities[ci] if 0 <= ci < len(communities) else []


def rrf_merge(orders: list[list[int]], k: int = 60) -> list[int]:
    s: dict = {}
    for order in orders:
        for pos, bi in enumerate(order):
            s[bi] = s.get(bi, 0.0) + 1.0 / (k + pos + 1)
    return sorted(set(b for o in orders for b in o), key=lambda i: -s.get(i, 0.0))


if __name__ == "__main__":
    main()
