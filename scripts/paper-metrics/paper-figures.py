"""The paper's section 5 figures that analyse.py does not print, computed
from the same exports so that none of them needs a hand calculation.

    python3 paper-figures.py --dir <paper-metrics out> --data <export dir> \
        --runs "<label=id:group,...>" --prices <prices.json>

Writes four CSVs to --dir:

  paper-figures-runs.csv     per run: learner or agent messages, persona
                             replies and gate reactions; tokens and USD for
                             successful calls and for all metered calls
                             (successful plus failed attempts, each priced at
                             the model that served it); wall clock of
                             successful stage attempts, failed attempts and
                             interrupted attempts; hidden facts obtained and
                             verified; early-disclosure flags on the revealing
                             reply and on other replies.
  paper-figures-facts.csv    per run and hidden fact: the learner message and
                             the persona turn at which it was obtained, and
                             whether an early-disclosure flag fell on the
                             reply that revealed it.
  paper-figures-audits.csv   per run: consistency audits by trigger (the
                             first-two floor, of which reveals; later
                             reveal-triggered; gate reactions; sampled later
                             turns) with their verdicts, plus an "all" row.
  paper-figures-latency.csv  latency pooled over every pinned run from the
                             per-run n, mean and sd in metrics-summary.csv:
                             N = sum n_i, M = sum n_i m_i / N,
                             s^2 = [sum (n_i - 1) s_i^2 + sum n_i (m_i - M)^2] / (N - 1).

Rules, as in results/2026-10-01-r5/README.md of the paper repository:

- Wall clock of an agent run: the sum of analyst_stage_started to
  analyst_stage_finished brackets, leaving out a bracket that holds an
  analyst failure (a failed attempt) and a start with no finish before the
  next start (an interrupted attempt). A run with no analyst brackets (a
  replay or a learner) reports its end-to-end time from run-summary.csv as
  its wall clock, with the basis named.
- An audit is matched to the latest persona reply (persona_turn or
  client_reaction) of the same persona before it. A reaction audit is a
  reaction; a chat reply that is one of that persona's first two chat
  replies is the floor; a later reply audited for a reveal is
  reveal-triggered; any other later reply was sampled.
- An early-disclosure flag is "on the revealing reply" when a fact_elicited
  event for the flagged fact, from the same persona, falls between the
  persona's reply that the flag follows and the flag itself.
"""
import argparse
import csv
import glob
import json
import math
import os
from collections import Counter, defaultdict

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True)
ap.add_argument("--data", required=True)
ap.add_argument("--runs", required=True)
ap.add_argument("--prices", required=True)
args = ap.parse_args()

prices = json.load(open(args.prices))["models"]
runs = []
for item in args.runs.split(","):
    label, rest = item.split("=", 1)
    runs.append((label, rest.split(":", 1)[0]))

events_path = next(iter(sorted(glob.glob(os.path.join(args.data, "*-events.csv")))), None) or os.path.join(args.data, "events.csv")
with open(events_path, newline="") as f:
    all_events = list(csv.DictReader(f))
with open(os.path.join(args.data, "db-messages.csv"), newline="") as f:
    all_messages = list(csv.DictReader(f))
with open(os.path.join(args.dir, "run-summary.csv"), newline="") as f:
    summary = {r["label"]: r for r in csv.DictReader(f)}
metrics_path = os.path.join(args.dir, "metrics-summary.csv")
metrics = list(csv.DictReader(open(metrics_path, newline=""))) if os.path.exists(metrics_path) else []


def detail(e):
    raw = e.get("detail_json") or ""
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


def num(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def ts(iso):
    # ISO 8601 with milliseconds and Z; seconds since the epoch, as float.
    from datetime import datetime

    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def cost(model, prompt, completion):
    if not model or model == "mock" or model not in prices:
        return 0.0
    p = prices[model]
    return (prompt * p["input"] + completion * p["output"]) / 1e6


def most_common(values):
    values = [v for v in values if v]
    return Counter(values).most_common(1)[0][0] if values else None


FAILED_CALL_TYPES = {"persona_failed", "analyst_step_failed", "analyst_stage_failed", "client_reaction_failed", "submission_scoring_failed"}
ANALYST_FAILURES = {"analyst_step_failed", "analyst_stage_failed"}
REPLY_TYPES = {"persona_turn", "client_reaction"}

run_rows, fact_rows, audit_rows = [], [], []

for label, eid in runs:
    # Events in export order within a timestamp, which is insertion order.
    ev = [e for e in all_events if e["engagement_id"] == eid]
    ev = sorted(enumerate(ev), key=lambda p: (p[1]["timestamp_iso"], p[0]))
    ev = [e for _, e in ev]
    msgs = [m for m in all_messages if m["engagement_id"] == eid]
    d = [detail(e) for e in ev]

    persona_model = most_common(
        [x.get("servedModel") or x.get("model") for e, x in zip(ev, d) if e["event_type"] in REPLY_TYPES]
    ) or "claude-sonnet-5"

    # Tokens and USD, per call at the model that served it.
    msg_prompt = sum(num(m["prompt_tokens"]) for m in msgs)
    msg_completion = sum(num(m["completion_tokens"]) for m in msgs)
    tokens_ok = msg_prompt + msg_completion
    usd_ok = cost(persona_model, msg_prompt, msg_completion)
    tokens_failed = 0.0
    usd_failed = 0.0
    for e, x in zip(ev, d):
        p, c = num(x.get("promptTokens")), num(x.get("completionTokens"))
        jp, jc = num(x.get("judgePromptTokens")), num(x.get("judgeCompletionTokens"))
        model = x.get("servedModel") or x.get("model") or x.get("judgeModel") or persona_model
        judge_model = x.get("judgeServedModel") or x.get("judgeModel") or x.get("servedModel") or x.get("model")
        if e["event_type"] in FAILED_CALL_TYPES:
            tokens_failed += p + c + jp + jc
            usd_failed += cost(model, p, c) + cost(judge_model, jp, jc)
        else:
            tokens_ok += p + c + jp + jc
            usd_ok += cost(model, p, c) + cost(judge_model, jp, jc)

    # Messages.
    learner_msgs = sum(1 for m in msgs if m["sender"] == "learner")
    persona_msgs = sum(1 for m in msgs if m["sender"] != "learner")
    reactions = sum(1 for e in ev if e["event_type"] == "client_reaction")

    # Wall clock from the analyst's stage brackets.
    brackets = []
    open_b = None
    for e in ev:
        t = ts(e["timestamp_iso"])
        typ = e["event_type"]
        if typ == "analyst_stage_started":
            if open_b:
                if not open_b["failed"]:
                    open_b["interrupted"] = True
                brackets.append(open_b)
            open_b = {"start": t, "end": None, "last": t, "failed": False, "interrupted": False}
        elif open_b is not None:
            open_b["last"] = t
            if typ in ANALYST_FAILURES:
                open_b["failed"] = True
            elif typ == "analyst_stage_finished":
                open_b["end"] = t
                brackets.append(open_b)
                open_b = None
    if open_b:
        open_b["interrupted"] = open_b["end"] is None and not open_b["failed"]
        brackets.append(open_b)
    has_brackets = any(b["end"] is not None for b in brackets)
    ok = [b for b in brackets if b["end"] is not None and not b["failed"] and not b["interrupted"]]
    failed = [b for b in brackets if b["failed"]]
    interrupted = [b for b in brackets if b["interrupted"]]
    if has_brackets:
        wall_basis = "successful stage attempts"
        wall_ok = sum(b["end"] - b["start"] for b in ok)
    else:
        wall_basis = "end to end (replay or learner; no analyst brackets)"
        wall_ok = num(summary.get(label, {}).get("e2e"))
    wall_failed = sum((b["end"] or b["last"]) - b["start"] for b in failed)
    # An interrupted attempt ends at its last event before the next start.
    wall_interrupted = sum(b["last"] - b["start"] for b in interrupted)

    # Hidden facts and early disclosures.
    elicited = [(e, x) for e, x in zip(ev, d) if e["event_type"] == "fact_elicited"]
    first_by_fact = {}
    for e, x in elicited:
        first_by_fact.setdefault(x.get("factId"), (e, x))
    last_reply = {}
    early_on_reveal, early_other = 0, 0
    early_facts_on_reveal = set()
    for e, x in zip(ev, d):
        if e["event_type"] in REPLY_TYPES:
            last_reply[x.get("personaId")] = ts(e["timestamp_iso"])
        if e["event_type"] != "early_disclosure_flagged":
            continue
        t = ts(e["timestamp_iso"])
        persona = x.get("personaId")
        since = last_reply.get(persona, t)
        for fact in x.get("factIds") or []:
            hit = any(
                ex.get("factId") == fact and ex.get("persona") == persona and since - 1.0 <= ts(ee["timestamp_iso"]) <= t
                for ee, ex in elicited
            )
            if hit:
                early_on_reveal += 1
                early_facts_on_reveal.add(fact)
            else:
                early_other += 1
    for fact, (e, x) in sorted(first_by_fact.items(), key=lambda kv: int(kv[1][1].get("learnerMessagesSoFar") or 0)):
        fact_rows.append({
            "run": label,
            "fact": fact,
            "persona": x.get("persona"),
            "learner_message": x.get("learnerMessagesSoFar"),
            "persona_turn": x.get("turnIndex"),
            "verified": bool(x.get("verified")),
            "detection": x.get("detection") or "reported",
            "early_on_reveal": fact in early_facts_on_reveal,
        })
    obtained = len(first_by_fact)
    verified = sum(1 for _, x in first_by_fact.values() if x.get("verified"))
    indices = ", ".join(
        f"{x.get('learnerMessagesSoFar')}{' (early)' if f in early_facts_on_reveal else ''}"
        for f, (_, x) in sorted(first_by_fact.items(), key=lambda kv: int(kv[1][1].get("learnerMessagesSoFar") or 0))
    )

    # Audits by trigger.
    chat_turns = defaultdict(int)
    last = {}
    cats = Counter()
    verdicts = defaultdict(Counter)
    for e, x in zip(ev, d):
        typ = e["event_type"]
        persona = x.get("personaId")
        if typ in REPLY_TYPES:
            if typ == "persona_turn":
                chat_turns[persona] += 1
            last[persona] = (typ, chat_turns[persona])
        if typ != "persona_consistency":
            continue
        reply = last.get(persona)
        reason = x.get("reason")
        if reason == "reaction" or (reply and reply[0] == "client_reaction"):
            cat = "reaction"
        elif reply and reply[1] <= 2:
            cat = "first_two_reveal" if reason == "reveal" else "first_two"
        elif reason == "reveal":
            cat = "reveal_later"
        else:
            cat = "sampled_later"
        cats[cat] += 1
        verdict = "consistent" if x.get("consistent") is True else "inconsistent" if x.get("consistent") is False else "failed"
        verdicts[cat][verdict] += 1
    for cat in ["first_two", "first_two_reveal", "reveal_later", "reaction", "sampled_later"]:
        audit_rows.append({
            "run": label,
            "trigger": cat,
            "audits": cats[cat],
            "consistent": verdicts[cat]["consistent"],
            "inconsistent": verdicts[cat]["inconsistent"],
            "failed": verdicts[cat]["failed"],
        })
    audit_rows.append({
        "run": label,
        "trigger": "all",
        "audits": sum(cats.values()),
        "consistent": sum(v["consistent"] for v in verdicts.values()),
        "inconsistent": sum(v["inconsistent"] for v in verdicts.values()),
        "failed": sum(v["failed"] for v in verdicts.values()),
    })

    run_rows.append({
        "run": label,
        "learner_or_agent_messages": learner_msgs,
        "persona_messages": persona_msgs,
        "persona_replies": persona_msgs - reactions,
        "gate_reactions": reactions,
        "tokens_successful_calls": int(tokens_ok),
        "tokens_all_metered_calls": int(tokens_ok + tokens_failed),
        "usd_successful_calls": round(usd_ok, 4),
        "usd_all_metered_calls": round(usd_ok + usd_failed, 4),
        "wall_clock_s": round(wall_ok, 1),
        "wall_clock_basis": wall_basis,
        "failed_attempts": len(failed),
        "failed_attempts_s": round(wall_failed, 1),
        "interrupted_attempts": len(interrupted),
        "interrupted_attempts_s": round(wall_interrupted, 1),
        "hidden_facts_obtained": obtained,
        "hidden_facts_verified": verified,
        "hidden_fact_messages": indices or "-",
        "early_flags_on_reveal": early_on_reveal,
        "early_flags_other": early_other,
    })

# Latency pooled over every pinned run.
labels = [label for label, _ in runs]
latency_rows = []
for metric in ["persona_reply_latency", "consistency_audit_latency", "rubric_scoring_latency"]:
    parts = []
    for r in metrics:
        if r["metric"] == metric and r["run"] in labels and r["n"] and int(float(r["n"])) > 0 and r["mean"]:
            parts.append((int(float(r["n"])), float(r["mean"]), float(r["sd"]) if r["sd"] else 0.0, r["run"]))
    n_total = sum(p[0] for p in parts)
    if n_total == 0:
        continue
    mean = sum(n * m for n, m, _, _ in parts) / n_total
    var = (
        (sum((n - 1) * s * s for n, _, s, _ in parts) + sum(n * (m - mean) ** 2 for n, m, _, _ in parts)) / (n_total - 1)
        if n_total > 1
        else float("nan")
    )
    latency_rows.append({
        "metric": metric,
        "runs": "+".join(p[3] for p in parts),
        "n": n_total,
        "mean": round(mean, 2),
        "sd": round(math.sqrt(var), 2) if not math.isnan(var) else "",
    })


def write(name, rows):
    if not rows:
        return
    with open(os.path.join(args.dir, name), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


write("paper-figures-runs.csv", run_rows)
write("paper-figures-facts.csv", fact_rows)
write("paper-figures-audits.csv", audit_rows)
write("paper-figures-latency.csv", latency_rows)
print(f"paper-figures: {len(run_rows)} runs, {len(fact_rows)} facts, {len(audit_rows)} audit rows, {len(latency_rows)} pooled latencies")
