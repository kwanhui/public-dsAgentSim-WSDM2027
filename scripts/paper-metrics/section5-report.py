"""Markdown summary of the section 5 numbers from one paper-metrics output
directory (written by `make section5`).

    python3 section5-report.py --dir <paper-metrics out> --snapshot <snapshot.json> \
        --runs "<label=id:group,...>" > section5-report.md

It only reads the CSVs that analyse.py and reestimate.py wrote, so every
figure in it can be traced to a CSV cell. No timestamp of its own is printed,
so two runs on the same snapshot give the same file.
"""
import argparse
import json
import os

import pandas as pd

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True)
ap.add_argument("--snapshot", required=True)
ap.add_argument("--runs", required=True)
args = ap.parse_args()


def csv(name):
    path = os.path.join(args.dir, name)
    return pd.read_csv(path) if os.path.exists(path) else None


def first(values):
    try:
        v = json.loads(values) if isinstance(values, str) else values
    except ValueError:
        return str(values)
    if isinstance(v, list):
        return ", ".join(str(x) for x in v) if v else "-"
    return "-" if v is None or (isinstance(v, float) and pd.isna(v)) else str(v)


def fmt(v, spec="{:.4f}"):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return "-"
    return spec.format(v)


snap = json.load(open(args.snapshot))
prices = json.load(open(os.path.join(args.dir, "prices.json")))
runs = csv("run-summary.csv")
cpr = csv("cost-per-reply.csv")
unmetered = csv("unmetered-estimate.csv")
audits = csv("audit-totals.csv")
summary = csv("metrics-summary.csv")

# A run whose judge calls were all served by the offline mock cost nothing.
# Its token counts are real, but its USD figures are priced at 0 here so a
# mock regeneration is not read as a real cost.
mock_engagements = set()
_scores = snap["tables"].get("rubricScores", [])
_by_run = {}
for _row in _scores:
    _by_run.setdefault(_row["engagementId"], []).append(_row.get("judgeModel"))
for _eng, _models in _by_run.items():
    if _models and all(m == "mock" for m in _models):
        mock_engagements.add(_eng)
run_ids = {}
for _item in args.runs.split(","):
    _label, _rest = _item.split("=", 1)
    run_ids[_label] = _rest.split(":", 1)[0]
mock_labels = {label for label, eid in run_ids.items() if eid in mock_engagements}

out = []
out.append("# Section 5 figures")
out.append("")
out.append(f"Snapshot: `{args.snapshot}` (cohort `{snap['cohort']['slug']}`, exported {snap['exportedAt']}).")
out.append(f"Runs: `{args.runs}`.")
# The prices of every model the pinned runs' events record (personas,
# analyst, judge and auditor), rather than the whole table, so a model added
# to the table for another provider does not change this report.
def _label(model_id):
    parts = model_id.removeprefix("claude-").split("-")
    return parts[0].title() + (" " + ".".join(parts[1:]) if len(parts) > 1 else "")


_used = set()
for _ev in snap["tables"].get("events", []):
    if _ev.get("engagementId") not in set(run_ids.values()):
        continue
    _d = _ev.get("detailJson") or {}
    for _k in ("servedModel", "model", "judgeModel"):
        if isinstance(_d.get(_k), str):
            _used.add(_d[_k])
_priced = [m for m in prices["models"] if m in _used]
if _priced:
    basis = ", ".join(
        f"{_label(m)} ${prices['models'][m]['input']:g}/${prices['models'][m]['output']:g}" for m in _priced
    ) + " per MTok"
else:
    basis = cpr.iloc[0].prices if cpr is not None and len(cpr) else ", ".join(prices["models"])
out.append(f"Prices: {basis} (USD per million input/output tokens, from `{prices['source']}`).")
# A run started on its own analyst model (lib/agents/analyst-model.ts) records
# it on its analyst events; analyse.py prices the analyst's tokens at it. The
# line appears only when some run's analyst is not the persona model, so
# reports on earlier snapshots do not change.
_analyst = {}
for _ev in snap["tables"].get("events", []):
    if _ev.get("type") == "analyst_step":
        _d = _ev.get("detailJson") or {}
        _analyst.setdefault(_ev["engagementId"], []).append((_d.get("model"), _d.get("modelOverride")))
_analyst_cells = []
_differs = False
for _label, _eid in run_ids.items():
    _vals = _analyst.get(_eid)
    if not _vals:
        continue
    _model = max(set(v[0] for v in _vals), key=[v[0] for v in _vals].count)
    _override = next((v[1] for v in _vals if v[1]), None)
    if _override or _model not in (None, "mock", "claude-sonnet-5"):
        _differs = True
    if _model == "mock" and _override:
        _analyst_cells.append(f"{_label} {_override} (requested; served by the mock)")
    else:
        _analyst_cells.append(f"{_label} {_model}")
if _differs:
    out.append(f"Analyst model per agent run: {', '.join(_analyst_cells)}; each run's analyst tokens are priced at its own model.")
out.append("")

out.append("## Per run")
out.append("")
out.append("| Run | Group | Mode | Completed | Rubric | Rubric prompt | Consistency prompt | Analyst prompt | Tokens | USD metered | USD est. true | USD per persona reply | Wall clock (s) | Audits (consistent / inconsistent) |")
out.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for _, r in runs.iterrows():
    est = None
    if unmetered is not None and (unmetered.run == r.label).any():
        est = unmetered[unmetered.run == r.label].iloc[0].est_true_usd
    per_reply = None
    if cpr is not None and (cpr.run == r.label).any():
        per_reply = cpr[cpr.run == r.label].iloc[0].usd_per_reply
    if r.label in mock_labels:
        usd_cell, est_cell, reply_cell = "0 (mock)", "0 (mock)", "0 (mock)"
    else:
        usd_cell, est_cell, reply_cell = fmt(r.usd), fmt(est), fmt(per_reply)
    out.append(
        f"| {r.label} | {r.group} | {r['mode']} | {r.completed} | {int(r.rubric_total)}/{int(r.rubric_max)} "
        f"| {first(r.rubric_prompt_versions)} | {first(r.consistency_prompt_versions)} | {first(r.analyst_prompt_versions)} "
        f"| {int(r.tokens_total)} | {usd_cell} | {est_cell} | {reply_cell} | {fmt(r.e2e, '{:.1f}')} "
        f"| {int(r.n_audit)} ({int(r.consistent)} / {int(r.inconsistent)}) |"
    )
out.append("")
if mock_labels:
    out.append("Runs marked mock were served by the offline mock model and are priced at 0.")
    out.append("")
out.append("USD metered prices every successful call that logged its tokens. USD est. true adds the reconstructed cost of calls that logged none (only for runs recorded before every call was metered). Wall clock (s) here is end to end, from the first event to the last, and includes any gap between an interrupted attempt and its resume; the section below gives the paper's measure, the sum of successful stage attempts.")
out.append("")

if cpr is not None:
    pooled = cpr[cpr.run.str.contains("pooled", na=False)]
    if len(pooled) and not mock_labels:
        p = pooled.iloc[0]
        lo, hi = cpr[~cpr.run.str.contains("pooled", na=False)].usd_per_reply.agg(["min", "max"])
        out.append(f"Persona reply cost: {fmt(lo)} to {fmt(hi)} USD across runs; {p.run}: {fmt(p.usd_per_reply)} USD over {int(p.persona_replies)} replies.")
        out.append("")

if summary is not None:
    out.append("## Latency (seconds, mean ± sd, n)")
    out.append("")
    metrics = ["persona_reply_latency", "consistency_audit_latency", "rubric_scoring_latency", "analyst_policy_latency", "analyst_stage_wallclock", "stage_dwell_time"]
    labels = list(runs.label)
    pooled_names = sorted(n for n in summary.run.unique() if "paper-ready" in str(n))
    cols = labels + pooled_names
    out.append("| Metric | " + " | ".join(cols) + " |")
    out.append("|---|" + "---|" * len(cols))
    for m in metrics:
        cells = []
        for c in cols:
            row = summary[(summary.metric == m) & (summary.run == c)]
            if len(row) == 0 or pd.isna(row.iloc[0]["mean"]):
                cells.append("-")
            else:
                x = row.iloc[0]
                sd = "" if pd.isna(x.sd) else f" ± {x.sd:.2f}"
                cells.append(f"{x['mean']:.2f}{sd} ({int(x.n)})")
        out.append(f"| {m} | " + " | ".join(cells) + " |")
    out.append("")

if audits is not None:
    out.append("## Consistency audits")
    out.append("")
    out.append("| Run | Position | Persona replies | Audits | Consistent | Inconsistent | Failed | Audit rate |")
    out.append("|---|---|---|---|---|---|---|---|")
    for _, a in audits.iterrows():
        out.append(f"| {a.run} | {a.position} | {a.replies} | {a.audits} | {a.consistent} | {a.inconsistent} | {a.failed} | {a.audit_rate} |")
    out.append("")

figures = csv("paper-figures-runs.csv")
facts = csv("paper-figures-facts.csv")
triggers = csv("paper-figures-audits.csv")
pooled_latency = csv("paper-figures-latency.csv")

if figures is not None:
    out.append("## Paper figures per run")
    out.append("")
    out.append(
        "Written by `paper-figures.py` from the same exports. \"Successful calls\" is the basis of the per-run table above; "
        "\"all metered calls\" adds the metered calls of failed attempts (a persona turn that failed schema validation, "
        "for example), each priced at the model that served it. The paper reports the all-metered figures. "
        "Wall clock for an agent run is the sum of its successful stage attempts; failed and interrupted attempts are left out "
        "and listed apart. A run without analyst stage brackets (a scripted replay) reports its end-to-end time."
    )
    out.append("")
    out.append("| Run | Messages (learner or agent) | Persona replies + gate reactions | Tokens, successful calls | Tokens, all metered calls | USD, successful calls | USD, all metered calls | Wall clock (s) | Wall clock basis | Failed attempts (s) | Interrupted attempts (s) | Hidden facts (verified) | Obtained at message | Early flags on the revealing reply / other |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for _, r in figures.iterrows():
        usd_ok = "0 (mock)" if r.run in mock_labels else f"{r.usd_successful_calls:.4f}"
        usd_all = "0 (mock)" if r.run in mock_labels else f"{r.usd_all_metered_calls:.4f}"
        out.append(
            f"| {r.run} | {int(r.learner_or_agent_messages)} | {int(r.persona_replies)} + {int(r.gate_reactions)} "
            f"| {int(r.tokens_successful_calls)} | {int(r.tokens_all_metered_calls)} | {usd_ok} | {usd_all} "
            f"| {r.wall_clock_s:.1f} | {r.wall_clock_basis} | {int(r.failed_attempts)} ({r.failed_attempts_s:.1f}) "
            f"| {int(r.interrupted_attempts)} ({r.interrupted_attempts_s:.1f}) "
            f"| {int(r.hidden_facts_obtained)} ({int(r.hidden_facts_verified)}) | {r.hidden_fact_messages} "
            f"| {int(r.early_flags_on_reveal)} / {int(r.early_flags_other)} |"
        )
    out.append("")
    ok = figures[~figures.run.isin(mock_labels)]
    if len(ok):
        out.append(
            f"Run cost, all metered calls: USD {ok.usd_all_metered_calls.min():.2f} to {ok.usd_all_metered_calls.max():.2f}. "
            f"Early-disclosure flags: {int(figures.early_flags_on_reveal.sum() + figures.early_flags_other.sum())}, "
            f"{int(figures.early_flags_on_reveal.sum())} of them on the revealing reply."
        )
        out.append("")

if facts is not None:
    out.append("## Hidden facts")
    out.append("")
    out.append("| Run | Fact | Persona | Learner message | Persona turn | Verified | Early flag on the revealing reply |")
    out.append("|---|---|---|---|---|---|---|")
    for _, r in facts.iterrows():
        out.append(
            f"| {r.run} | {r.fact} | {r.persona} | {int(r.learner_message)} | {int(r.persona_turn)} | {bool(r.verified)} | {bool(r.early_on_reveal)} |"
        )
    out.append("")

if triggers is not None:
    out.append("## Audits by trigger")
    out.append("")
    out.append("Each audit is matched to the persona reply it follows. The floor is a persona's first two chat replies (of which some revealed a fact); later replies are audited when they reveal a fact or when the sample picks them; every gate reaction is audited.")
    out.append("")
    out.append("| Run | First two replies (of which reveals) | Reveal-triggered, later | Reactions | Sampled later turns | Total | Consistent / inconsistent / failed |")
    out.append("|---|---|---|---|---|---|---|")
    for label in list(dict.fromkeys(triggers.run)):
        t = triggers[triggers.run == label].set_index("trigger")
        a = lambda k: int(t.loc[k].audits) if k in t.index else 0
        allrow = t.loc["all"]
        out.append(
            f"| {label} | {a('first_two') + a('first_two_reveal')} ({a('first_two_reveal')}) | {a('reveal_later')} | {a('reaction')} "
            f"| {a('sampled_later')} | {a('all')} | {int(allrow.consistent)} / {int(allrow.inconsistent)} / {int(allrow.failed)} |"
        )
    tot = triggers[triggers.trigger != "all"].groupby("trigger").audits.sum()
    allt = triggers[triggers.trigger == "all"]
    g = lambda k: int(tot.get(k, 0))
    out.append(
        f"| All | {g('first_two') + g('first_two_reveal')} ({g('first_two_reveal')}) | {g('reveal_later')} | {g('reaction')} "
        f"| {g('sampled_later')} | {int(allt.audits.sum())} | {int(allt.consistent.sum())} / {int(allt.inconsistent.sum())} / {int(allt.failed.sum())} |"
    )
    out.append("")

if pooled_latency is not None:
    out.append("## Latency pooled over the pinned runs (seconds)")
    out.append("")
    out.append("Pooled from the per-run n, mean and sd above: N = Σn, M = Σn·m / N, s² = [Σ(n − 1)s² + Σn(m − M)²] / (N − 1).")
    out.append("")
    out.append("| Metric | Runs | Mean ± sd (n) |")
    out.append("|---|---|---|")
    for _, r in pooled_latency.iterrows():
        sd = "" if pd.isna(r.sd) else f" ± {r.sd:.2f}"
        out.append(f"| {r.metric} | {r.runs} | {r['mean']:.2f}{sd} ({int(r.n)}) |")
    out.append("")

print("\n".join(out))
