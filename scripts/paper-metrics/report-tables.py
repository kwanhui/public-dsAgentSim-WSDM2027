"""Renders the report-ready figures from metrics-summary.csv / run-summary.csv.

Usage: python3 report-tables.py --dir <analyse.py output directory>
"""
import argparse
import json
from pathlib import Path
import pandas as pd

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True, help="analyse.py output directory")
D = Path(ap.parse_args().dir)
ms = pd.read_csv(D / "metrics-summary.csv")
rs = pd.read_csv(D / "run-summary.csv")
ts = pd.read_csv(D / "tokens-by-stage.csv")

def cell(metric, run):
    r = ms[(ms.metric == metric) & (ms.run == run)]
    if not len(r):
        return "--"
    r = r.iloc[0]
    if pd.isna(r["mean"]):
        return "--"
    n = int(r["n"])
    s = f"{r['mean']:.2f}"
    if not pd.isna(r["sd"]):
        s += f" ± {r['sd']:.2f}"
    s += f" ({n})"
    if not pd.isna(r["median"]):
        s += f"; med {r['median']:.2f}"
    if not pd.isna(r["min"]):
        s += f"; [{r['min']:.2f}–{r['max']:.2f}]"
    if not pd.isna(r["ci95_lo"]):
        s += f"; CI [{r['ci95_lo']:.2f}, {r['ci95_hi']:.2f}]"
    return s

def scalar(metric, run, fmt="{:g}"):
    r = ms[(ms.metric == metric) & (ms.run == run)]
    return fmt.format(r.iloc[0]["mean"]) if len(r) and not pd.isna(r.iloc[0]["mean"]) else "--"

PAPER = list(rs[rs.group == "paper"].label)
OTHER = list(rs[rs.group != "paper"].label)
RUNS = PAPER + ([("+".join(PAPER) + " (paper-ready, pooled)")] if PAPER else []) + OTHER
LAT = ["persona_reply_latency", "consistency_audit_latency", "rubric_scoring_latency",
       "analyst_policy_latency", "analyst_stage_wallclock", "stage_dwell_time"]

print("### LATENCY")
for m in LAT:
    print(f"\n-- {m}")
    for run in RUNS:
        print(f"   {run:32s} {cell(m, run)}")

print("\n### PER-RUN SUMMARY")
cols = ["label", "group", "started_utc", "metering_regime", "audit_floor", "completed",
        "rubric_prompt_versions", "consistency_prompt_versions", "analyst_prompt_versions",
        "judge_models", "e2e", "stage_wall_sum", "empty_brackets", "rubric_total", "rubric_max",
        "n_turns", "n_audit", "n_persona", "n_judge", "n_policy", "n_react", "n_calls",
        "p_in", "p_out", "j_in", "j_out", "a_in", "a_out", "c_in", "c_out", "r_in", "r_out",
        "tokens_total", "stages", "usd", "usd_per_stage", "unmetered",
        "consistent", "inconsistent", "failed"]
print(rs[cols].to_string(index=False))

print("\n### RUBRIC PER STAGE")
for _, r in rs.iterrows():
    ss = json.loads(r.stage_scores)
    tot = sum(x["score"] for x in ss); mx = sum(x["max"] for x in ss)
    print(f"{r.label:22s} total {tot}/{mx} :: " +
          " | ".join(f"{x['stage']} {x['score']}/{x['max']} (att {x['attempts']}, pass={x['passed']})" for x in ss))

print("\n### TOKENS PER STAGE (paper runs)")
for run in PAPER:
    t = ts[ts.run == run]
    if not len(t): continue
    print(f"\n-- {run}")
    piv = t.pivot_table(index=["stage_index", "stage"], columns="call_type", values="tokens",
                        aggfunc="sum", fill_value=0)
    print(piv.to_string())

print("\n### TOKENS PER ENGAGEMENT BY CALL TYPE")
for _, r in rs.iterrows():
    print(f"\n-- {r.label} ({r.metering_regime})")
    for k, (i, o, n) in {"persona": (r.p_in, r.p_out, r.n_persona),
                          "judge": (r.j_in, r.j_out, r.n_judge),
                          "analyst_policy": (r.a_in, r.a_out, r.n_policy),
                          "consistency_audit": (r.c_in, r.c_out, r.n_audit),
                          "client_reaction": (r.r_in, r.r_out, r.n_react)}.items():
        print(f"   {k:19s} {int(i):7d} / {int(o):6d} over {int(n):3d} calls  = {int(i)+int(o):7d}")
    print(f"   {'TOTAL':19s} {int(r.tokens_total):7d} tok, {int(r.n_calls)} calls, ${r.usd:.4f}")

print("\n### AUDIT RATE")
for _, r in rs.iterrows():
    rate = r.n_audit / r.n_turns if r.n_turns else float('nan')
    print(f"{r.label:22s} {int(r.n_audit)}/{int(r.n_turns)} = {rate:.3f}  "
          f"consistent {int(r.consistent)} / inconsistent {int(r.inconsistent)} / failed {int(r.failed)}  "
          f"[{r.audit_floor}]  prompts {r.consistency_prompt_versions}")

print("\n### SPEND OF THE PAPER RUNS")
sub = rs[rs.group == "paper"]
print(f"tokens {int(sub.tokens_total.sum())}, calls {int(sub.n_calls.sum())}, USD ${sub.usd.sum():.4f}")
