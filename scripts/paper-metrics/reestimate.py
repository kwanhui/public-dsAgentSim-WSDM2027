"""Re-estimates the pre-fix runs' unmetered spend from the MEASURED per-call
token costs of the fully metered runs (group "paper"), replacing the Aug-26
character-count reconstruction. Writes unmetered-estimate.csv.

Usage: python3 reestimate.py --dir <analyse.py output dir> --prices prices.json
           [--previous <earlier unmetered-estimate.csv>]

The fully metered runs are those with group "paper" in run-summary.csv; every
other run whose metering regime is "metered calls only" is re-estimated. Prices come from lib/llm/prices.ts through
prices.json (export-prices.ts).
"""
import argparse
import json
from pathlib import Path
import pandas as pd

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True, help="analyse.py output directory (holds run-summary.csv)")
ap.add_argument("--prices", required=True)
ap.add_argument("--previous", help="earlier unmetered-estimate.csv to compare against")
ap.add_argument("--persona-model", default="claude-sonnet-5")
ap.add_argument("--judge-model", default="claude-opus-4-8")
args = ap.parse_args()

D = Path(args.dir)
rs = pd.read_csv(D / "run-summary.csv")
paper = rs[rs.group == "paper"]

aud_calls = paper.n_audit.sum()
rea_calls = paper.n_react.sum()
aud_p, aud_c = paper.c_in.sum() / aud_calls, paper.c_out.sum() / aud_calls
rea_p, rea_c = paper.r_in.sum() / rea_calls, paper.r_out.sum() / rea_calls
print(f"measured per-call, pooled over the paper runs:")
print(f"  consistency audit ({aud_calls} calls): {aud_p:.0f} prompt / {aud_c:.0f} completion  [Opus 4.8]")
print(f"  client reaction   ({rea_calls} calls): {rea_p:.0f} prompt / {rea_c:.0f} completion  [Sonnet 5]")

_p = json.loads(Path(args.prices).read_text())
_p = _p.get("models", _p)
OP_IN, OP_OUT = _p[args.judge_model]["input"], _p[args.judge_model]["output"]
SO_IN, SO_OUT = _p[args.persona_model]["input"], _p[args.persona_model]["output"]

old = pd.read_csv(args.previous).set_index("run") if args.previous else None

# Only runs that did not meter every call get a reconstruction; a fully
# metered run outside the paper group (for example a regenerated human
# reference run) already counts every call.
unmetered_runs = rs[(rs.group != "paper") & rs.metering_regime.astype(str).str.startswith("metered calls only")]
rows = []
for _, r in unmetered_runs.iterrows():
    na, nr = int(r.n_audit), int(r.n_react)
    ap, ac = na * aud_p, na * aud_c
    rp, rc = nr * rea_p, nr * rea_c
    usd = (ap * OP_IN + ac * OP_OUT + rp * SO_IN + rc * SO_OUT) / 1e6
    prev = old.loc[r.label] if old is not None and r.label in old.index else None
    rows.append({
        "run": r.label, "n_audits": na, "n_react": nr,
        "est_audit_prompt": round(ap), "est_audit_completion": round(ac),
        "est_react_prompt": round(rp), "est_react_completion": round(rc),
        "est_unmetered_tokens": round(ap + ac + rp + rc),
        "est_unmetered_usd": round(usd, 4),
        "metered_usd": round(r.usd, 4),
        "est_true_usd": round(r.usd + usd, 4),
        "uplift_pct": round(100 * usd / r.usd, 1),
        "aug26_charcount_usd": float(prev.est_unmetered_usd) if prev is not None else None,
        "basis": "measured per-call means from " + "+".join(paper.label) + " (fully metered)",
    })
COLUMNS = ["run", "n_audits", "n_react", "est_audit_prompt", "est_audit_completion", "est_react_prompt",
           "est_react_completion", "est_unmetered_tokens", "est_unmetered_usd", "metered_usd", "est_true_usd",
           "uplift_pct", "aug26_charcount_usd", "basis"]
out = pd.DataFrame(rows, columns=COLUMNS)
out.to_csv(D / "unmetered-estimate.csv", index=False)
print()
print(out.to_string(index=False))
