"""Cheap system metrics for the AgenticPracticum WSDM demo paper.

Reads the cohort CSV exports (fetched from the live instance) plus the two
read-only DB pulls the exports do not carry (per-message persona token counts,
engagement lifecycle timestamps) and writes metrics-summary.csv.

Usage (see `make paper-metrics`):

  python3 analyse.py --source export-dir:<dir> --runs "A1=<engagement-id>:paper,H1=<id>:exemplar" \\
      --prices prices.json --out <dir> [--cohort <slug>]

`--source export-dir:<dir>` holds `<slug>-events.csv`, `<slug>-rubric-scores.csv`
and `db-messages.csv`, as written by pull-db.ts (from a PGlite directory or a
Postgres database) or by fetch-exports.ts plus pull-db.ts (from a hosted
instance). `--runs` is a comma-separated list of `label=engagement-id[:group]`;
the group is `paper` (pooled and quoted), `exemplar` or `context` (default).
The mode (human or agent) is read from the events export.

Every run is tagged with

  * its **metering regime**: whether consistency audits and client-sponsor
    reactions record token usage. By default this is observed from the data (a
    run is fully metered when every audit and every reaction carries a token
    count); `--metering-cutoff <ISO time>` classifies by the run's first event
    time instead, for a corpus that spans a known metering commit. Runs that
    are not fully metered understate spend;
  * its **prompt versions as observed in the exports**: the rubric judge's
    `prompt_version` on the score rows, the auditor's `promptVersion` on
    `persona_consistency` events, and the analyst's `promptVersion` on
    `analyst_step` events. Nothing is assumed from the source tree.

Token accounting is correspondingly split by call type rather than by "did this
row carry a nonzero count", because post-fix client reactions carry real counts
and would otherwise be pooled into the persona-reply bucket. A non-learner
message is a **persona reply** when the message immediately before it in the
same channel came from the learner (the orchestrator writes the learner turn and
the reply together); any other non-learner message is a **client-sponsor
reaction**, which the stage gate appends after scoring. The classifier is
checked against the pre-fix runs, where reactions are exactly the zero-token
messages.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import pandas as pd

# The guaranteed-first-N-turns audit floor (GUARANTEED_AUDIT_TURNS in
# lib/agents/consistency.ts). Used to split audits by turn position.
DEFAULT_GUARANTEED_TURNS = 2

# Model roles: the persona, the analyst policy and the client reaction run on
# the persona model; the rubric judge and the consistency auditor run on the
# judge model. Prices come from lib/llm/prices.ts through prices.json
# (export-prices.ts), never from this file.
DEFAULT_PERSONA_MODEL = "claude-sonnet-5"
DEFAULT_JUDGE_MODEL = "claude-opus-4-8"

# two-sided t critical values at 95%
TCRIT = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
         8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160,
         14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093,
         20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
         26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042}


def tcrit(df):
    if df <= 0:
        return float("nan")
    if df in TCRIT:
        return TCRIT[df]
    return 1.96 if df > 30 else 2.086


def describe(vals, metric, run, mode, unit, note=""):
    v = pd.Series([x for x in vals if x is not None and not (isinstance(x, float) and math.isnan(x))], dtype="float64")
    n = len(v)
    row = {"metric": metric, "run": run, "mode": mode, "unit": unit, "n": n,
           "mean": None, "sd": None, "median": None, "min": None, "max": None,
           "ci95_lo": None, "ci95_hi": None, "note": note}
    if n == 0:
        return row
    row["mean"] = round(v.mean(), 3)
    row["median"] = round(v.median(), 3)
    row["min"] = round(v.min(), 3)
    row["max"] = round(v.max(), 3)
    if n >= 2:
        sd = v.std(ddof=1)
        row["sd"] = round(sd, 3)
        if n >= 3:
            h = tcrit(n - 1) * sd / math.sqrt(n)
            row["ci95_lo"] = round(v.mean() - h, 3)
            row["ci95_hi"] = round(v.mean() + h, 3)
    return row


def classify_messages(m):
    """Split one engagement's non-learner messages into persona replies and
    client-sponsor stage-gate reactions.

    The orchestrator persists the learner turn and the persona reply in the same
    call, so every persona reply is immediately preceded in its channel by a
    learner message. The stage gate's client reaction is appended on its own,
    after scoring, with no learner turn in front of it. Message ids are serial,
    so ordering by id is the insertion order.
    """
    reply_idx, react_idx = [], []
    for _, chan in m.sort_values("id").groupby("channel_id"):
        prev_sender = None
        for i, r in chan.iterrows():
            if r.sender != "learner":
                (reply_idx if prev_sender == "learner" else react_idx).append(i)
            prev_sender = r.sender
    return m.loc[reply_idx], m.loc[react_idx]


def model_label(model_id):
    """claude-opus-4-8 -> "Opus 4.8"; only used in notes."""
    parts = model_id.removeprefix("claude-").split("-")
    return parts[0].title() + (" " + ".".join(parts[1:]) if len(parts) > 1 else "")


def analyst_model_of(asx, prices, default):
    """The model a run's analyst steps record (the most frequent one), when
    it is priced and not the mock; otherwise `default` (the persona model)."""
    models = [r.d.get("model") for _, r in asx.iterrows() if r.d.get("model")]
    if not models:
        return default
    top = max(set(models), key=models.count)
    if top in prices and top not in ("mock", "mock-model-id"):
        return top
    return default


def parse_runs(spec):
    """`label=engagement-id[:group],...` -> {engagement_id: (label, group)}."""
    runs = {}
    for item in spec.split(","):
        item = item.strip()
        if not item:
            continue
        if "=" not in item:
            sys.exit(f"--runs entry {item!r} is not label=engagement-id[:group]")
        label, rest = item.rsplit("=", 1)
        eid, _, group = rest.partition(":")
        runs[eid.strip()] = (label.strip(), (group or "context").strip())
    if not runs:
        sys.exit("--runs is empty")
    return runs


def load_prices(path):
    data = json.loads(Path(path).read_text())
    return data["models"] if "models" in data else data


def find_export(d, cohort, suffix):
    """`<slug>-events.csv` style export, or a bare `events.csv`."""
    if cohort and (d / f"{cohort}-{suffix}.csv").exists():
        return d / f"{cohort}-{suffix}.csv"
    hits = sorted(d.glob(f"*-{suffix}.csv"))
    hits = [h for h in hits if not h.name.startswith("db-")]
    if cohort:
        sys.exit(f"no {cohort}-{suffix}.csv in {d}")
    if len(hits) == 1:
        return hits[0]
    if (d / f"{suffix}.csv").exists():
        return d / f"{suffix}.csv"
    sys.exit(f"expected exactly one *-{suffix}.csv in {d} (found {len(hits)}); pass --cohort <slug>")


def audit_positions(aud_ev, m):
    """1-based position of each audited reply among its persona's replies.

    A persona-authored message is written before it is audited, so the position
    of an audit is the number of that persona's non-learner messages, in this
    engagement, stamped at or before the audit event. This matches the
    `priorPersonaTurns` count the app uses for the guaranteed-audit floor
    (which counts client-sponsor reactions as persona turns too).
    """
    nl = m[m.sender != "learner"]
    times = pd.to_datetime(nl.timestamp_iso, format="ISO8601", utc=True)
    out = []
    for _, r in aud_ev.iterrows():
        n = int(((nl.persona_id == r.d.get("personaId")) & (times <= r.ts)).sum())
        out.append(max(n, 1))
    return out


def replies_by_position(m, guaranteed):
    """Persona-authored messages split into the first `guaranteed` per persona and the rest."""
    nl = m[m.sender != "learner"]
    first = later = 0
    for _, g in nl.groupby("persona_id"):
        first += min(len(g), guaranteed)
        later += max(len(g) - guaranteed, 0)
    return first, later


def observed_floor(aud_ev, positions, m, persona_msgs, guaranteed):
    """True when every persona reply in its persona's first `guaranteed`
    messages was audited. Client-sponsor reactions are not checked: the app
    audited them only when they were sampled, before every reaction was
    audited."""
    nl = m[m.sender != "learner"].sort_values("id")
    have = {(r.d.get("personaId"), p) for (_, r), p in zip(aud_ev.iterrows(), positions)}
    for pid, g in nl.groupby("persona_id"):
        for pos, idx in enumerate(g.index, start=1):
            if pos > guaranteed:
                break
            if idx in persona_msgs.index and (pid, pos) not in have:
                return False
    return True


def observed_metered(aud_ev, reaction_msgs):
    """True when every completed audit and every reaction carries a token count."""
    for _, r in aud_ev.iterrows():
        if r.d.get("consistent") is None:
            continue
        if not ((r.d.get("promptTokens") or 0) or (r.d.get("completionTokens") or 0)):
            return False
    if len(reaction_msgs):
        if ((reaction_msgs.prompt_tokens == 0) & (reaction_msgs.completion_tokens == 0)).any():
            return False
    return True


def main(args):
    src_kind, _, src_path = args.source.partition(":")
    if src_kind != "export-dir" or not src_path:
        sys.exit("--source must be export-dir:<dir> (run pull-db.ts first for a PGlite or Postgres source)")
    D = Path(src_path)
    OUT = Path(args.out)
    OUT.mkdir(parents=True, exist_ok=True)
    RUNS = parse_runs(args.runs)
    prices = load_prices(args.prices)
    for role_model in (args.persona_model, args.judge_model):
        if role_model not in prices:
            sys.exit(f"{role_model} is not in {args.prices}; add it to lib/llm/prices.ts")
    guaranteed = args.guaranteed_turns
    metering_cutoff = pd.Timestamp(args.metering_cutoff) if args.metering_cutoff else None
    floor_cutoff = pd.Timestamp(args.audit_floor_cutoff) if args.audit_floor_cutoff else None

    # The cohort's sampled audit rate, from the cohorts pull when present.
    audit_rate_cfg = args.audit_rate
    cohorts_csv = D / "db-cohorts.csv"
    if audit_rate_cfg is None and cohorts_csv.exists() and args.cohort:
        c = pd.read_csv(cohorts_csv)
        hit = c[(c.slug == args.cohort) | (c.id == args.cohort)]
        if len(hit):
            cfg = json.loads(hit.iloc[0].config_json)
            audit_rate_cfg = (cfg.get("research") or {}).get("consistencyAuditRate")

    ev = pd.read_csv(find_export(D, args.cohort, "events"))
    ev["ts"] = pd.to_datetime(ev.timestamp_iso, format="ISO8601", utc=True)
    ev["d"] = ev.detail_json.apply(lambda s: json.loads(s) if isinstance(s, str) and s else {})
    ev = ev.sort_values("ts").reset_index(drop=True)

    sc = pd.read_csv(find_export(D, args.cohort, "rubric-scores"))
    sc["submitted_at"] = pd.to_datetime(sc.submitted_at_iso, format="ISO8601", utc=True)
    subs = sc.drop_duplicates("submission_id")[
        ["engagement_id", "submission_id", "stage", "attempt", "submitted_at", "judge_model", "prompt_version"]
    ]

    msg = pd.read_csv(D / "db-messages.csv")

    rows = []
    per_run = {}
    pool = {}  # (mode, metric) -> list of per-call values, for the pooled table
    gpool = {}  # (group, metric) -> same, so the paper-ready pair can be pooled
    classifier_check = []
    stage_token_rows = []

    reply_cost_rows = []
    audit_rows = []
    audit_pool = {}  # group -> [replies_first, replies_later, per-audit (pos_class, verdict) list]
    metered_by_label = {}
    versions_by_label = {}

    for eid, (label, group) in RUNS.items():
        e = ev[ev.engagement_id == eid].reset_index(drop=True)
        if len(e) == 0:
            print(f"!! no events for {label} ({eid}), skipped")
            continue
        mode = str(e.iloc[0]["mode"])
        m = msg[msg.engagement_id == eid]
        s = subs[subs.engagement_id == eid]
        info = {"mode": mode, "label": label, "group": group, "engagement_id": eid}

        # ---------- REGIME AND PROMPT VERSIONS (observed, not assumed) -------
        first_ts = e.iloc[0].ts
        aud_ev = e[e.event_type == "persona_consistency"]
        persona_msgs, reaction_msgs = classify_messages(m)
        positions = audit_positions(aud_ev, m)
        ref = f" ({{}}-{args.metering_ref})" if metering_cutoff is not None and args.metering_ref else ""
        if metering_cutoff is not None:
            metered = first_ts > metering_cutoff
            info["metering_regime"] = (
                ("fully metered" + ref.format("post")) if metered else ("metered calls only" + ref.format("pre"))
            )
        else:
            metered = observed_metered(aud_ev, reaction_msgs)
            info["metering_regime"] = "fully metered" if metered else "metered calls only"
        floor_on = (first_ts > floor_cutoff) if floor_cutoff is not None else observed_floor(aud_ev, positions, m, persona_msgs, guaranteed)
        rate_txt = f"{audit_rate_cfg:g}" if audit_rate_cfg is not None else "sampled"
        info["audit_floor"] = "in force" if floor_on else f"not deployed ({rate_txt} sampling only)"
        info["started_utc"] = first_ts.isoformat()
        metered_by_label[label] = metered
        info["rubric_prompt_versions"] = sorted(set(s.prompt_version.dropna())) or None
        info["consistency_prompt_versions"] = sorted(
            {r.d.get("promptVersion") for _, r in aud_ev.iterrows() if r.d.get("promptVersion")}
        ) or None
        info["analyst_prompt_versions"] = sorted(
            {r.d.get("promptVersion") for _, r in e[e.event_type.str.startswith("analyst_")].iterrows()
             if r.d.get("promptVersion")}
        ) or None
        info["judge_models"] = sorted(set(s.judge_model.dropna())) or None
        versions_by_label[label] = (info["rubric_prompt_versions"], info["consistency_prompt_versions"])

        # ---------- LATENCY ----------
        # (a) persona reply: analyst_step(action=message) -> next persona_turn.
        #     Only agent runs carry a server-side request-start marker.
        persona_lat = []
        for i, r in e.iterrows():
            if r.event_type != "analyst_step" or r.d.get("action") != "message":
                continue
            nxt = e[(e.index > i) & (e.event_type == "persona_turn")]
            if len(nxt):
                persona_lat.append((nxt.iloc[0].ts - r.ts).total_seconds())
        pool.setdefault((mode, "persona_reply_latency"), []).extend(persona_lat)
        gpool.setdefault((group, "persona_reply_latency"), []).extend(persona_lat)
        rows.append(describe(persona_lat, "persona_reply_latency", label, mode, "s",
                             "analyst_step(message) -> next persona_turn; agent runs only"))

        # (b) consistency audit: persona_turn -> persona_consistency that follows it.
        audit_lat = []
        pt_idx = e.index[e.event_type == "persona_turn"].tolist()
        for i in pt_idx:
            nxt = e[(e.index > i)]
            if len(nxt) and nxt.iloc[0].event_type == "persona_consistency":
                audit_lat.append((nxt.iloc[0].ts - e.loc[i].ts).total_seconds())
        pool.setdefault((mode, "consistency_audit_latency"), []).extend(audit_lat)
        gpool.setdefault((group, "consistency_audit_latency"), []).extend(audit_lat)
        rows.append(describe(audit_lat, "consistency_audit_latency", label, mode, "s",
                             "persona_turn -> immediately following persona_consistency"))

        # (c) rubric judge: submission created_at -> submission_scored.
        judge_lat = []
        for _, sr in s.iterrows():
            hit = e[(e.event_type == "submission_scored") & (e.d.apply(lambda d: d.get("submissionId")) == sr.submission_id)]
            if len(hit):
                judge_lat.append((hit.iloc[0].ts - sr.submitted_at).total_seconds())
        pool.setdefault((mode, "rubric_scoring_latency"), []).extend(judge_lat)
        gpool.setdefault((group, "rubric_scoring_latency"), []).extend(judge_lat)
        rows.append(describe(judge_lat, "rubric_scoring_latency", label, mode, "s",
                             "submissions.created_at -> submission_scored event"))

        # (d) analyst policy call: preceding event -> analyst_step.
        policy_lat = []
        for i, r in e.iterrows():
            if r.event_type != "analyst_step" or i == 0:
                continue
            policy_lat.append((r.ts - e.loc[i - 1].ts).total_seconds())
        pool.setdefault((mode, "analyst_policy_latency"), []).extend(policy_lat)
        gpool.setdefault((group, "analyst_policy_latency"), []).extend(policy_lat)
        rows.append(describe(policy_lat, "analyst_policy_latency", label, mode, "s",
                             "previous event -> analyst_step (view build + policy LLM call)"))

        # (e) analyst stage wall-clock: non-empty analyst_stage_started/finished brackets.
        stage_wall, empty_brackets = [], 0
        starts = e.index[e.event_type == "analyst_stage_started"].tolist()
        for i in starts:
            fin = e[(e.index > i) & (e.event_type == "analyst_stage_finished")]
            if not len(fin):
                continue
            j = fin.index[0]
            inner = e.loc[i + 1: j - 1]
            if len(inner) == 0:
                empty_brackets += 1
                continue
            stage_wall.append((e.loc[j].ts - e.loc[i].ts).total_seconds())
        pool.setdefault((mode, "analyst_stage_wallclock"), []).extend(stage_wall)
        gpool.setdefault((group, "analyst_stage_wallclock"), []).extend(stage_wall)
        rows.append(describe(stage_wall, "analyst_stage_wallclock", label, mode, "s",
                             f"analyst_stage_started -> analyst_stage_finished; {empty_brackets} empty bracket(s) excluded"))
        info["empty_brackets"] = empty_brackets
        info["stage_wall_sum"] = round(sum(stage_wall), 1) if stage_wall else None

        # (f) stage dwell time, computed identically in both modes: stage entry
        #     (engagement_started, or the stage_advanced that moved into it) ->
        #     stage exit (next stage_advanced, or engagement_completed).
        bounds = [e.iloc[0].ts]
        for _, r in e[e.event_type == "stage_advanced"].iterrows():
            bounds.append(r.ts)
        done_ev = e[e.event_type == "engagement_completed"]
        if len(done_ev):
            bounds.append(done_ev.iloc[0].ts)
        dwell = [(bounds[i + 1] - bounds[i]).total_seconds() for i in range(len(bounds) - 1)]
        pool.setdefault((mode, "stage_dwell_time"), []).extend(dwell)
        gpool.setdefault((group, "stage_dwell_time"), []).extend(dwell)
        rows.append(describe(dwell, "stage_dwell_time", label, mode, "s",
                             "stage entry -> stage exit (stage_advanced boundaries); "
                             "includes learner think time (human) / operator click latency (agent)"))

        # (g) end-to-end engagement wall-clock.
        first, last = e.iloc[0], e.iloc[-1]
        done = e[e.event_type == "engagement_completed"]
        end = done.iloc[0].ts if len(done) else last.ts
        e2e = (end - first.ts).total_seconds()
        pool.setdefault((mode, "engagement_wallclock"), []).append(e2e)
        gpool.setdefault((group, "engagement_wallclock"), []).append(e2e)
        rows.append(describe([e2e], "engagement_wallclock", label, mode, "s",
                             "first event -> engagement_completed" + ("" if len(done) else " (INCOMPLETE: last event used)")))
        info["e2e"] = round(e2e, 1)
        info["completed"] = bool(len(done))

        # ---------- TOKENS ----------
        # Persona replies and client-sponsor reactions are told apart by their
        # position in the channel, not by whether they carry a token count:
        # after e65c008 the reactions carry real counts too.
        zero_token = m[(m.sender != "learner") & (m.prompt_tokens == 0) & (m.completion_tokens == 0)]
        classifier_check.append({
            "run": label, "metered": metered,
            "n_reply": len(persona_msgs), "n_react": len(reaction_msgs),
            "n_zero_token_nonlearner": len(zero_token),
            "n_persona_turn_events": int((e.event_type == "persona_turn").sum()),
            "positional_reactions_match_zero_token": set(reaction_msgs.index) == set(zero_token.index),
        })
        p_in, p_out = int(persona_msgs.prompt_tokens.sum()), int(persona_msgs.completion_tokens.sum())
        r_in, r_out = int(reaction_msgs.prompt_tokens.sum()), int(reaction_msgs.completion_tokens.sum())

        js = e[e.event_type == "submission_scored"]
        j_in = int(sum(r.d.get("judgePromptTokens", 0) for _, r in js.iterrows()))
        j_out = int(sum(r.d.get("judgeCompletionTokens", 0) for _, r in js.iterrows()))

        asx = e[e.event_type.isin(["analyst_step", "analyst_step_rejected"])]
        a_in = int(sum(r.d.get("promptTokens", 0) for _, r in asx.iterrows()))
        a_out = int(sum(r.d.get("completionTokens", 0) for _, r in asx.iterrows()))

        # Consistency audits: usage recorded on the event since e65c008.
        c_in = int(sum(r.d.get("promptTokens", 0) or 0 for _, r in aud_ev.iterrows()))
        c_out = int(sum(r.d.get("completionTokens", 0) or 0 for _, r in aud_ev.iterrows()))

        n_audit = len(aud_ev)
        n_react = len(reaction_msgs)
        # Calls that still record nothing: pre-fix audits and reactions.
        unmetered = sum(1 for _, r in aud_ev.iterrows() if not (r.d.get("promptTokens") or r.d.get("completionTokens")))
        unmetered += int(((reaction_msgs.prompt_tokens == 0) & (reaction_msgs.completion_tokens == 0)).sum())

        stages = len(e[e.event_type == "stage_advanced"]) + (1 if not info["completed"] else 0)
        stages_reached = 6 if info["completed"] else stages

        for kind, (ti, to, ncalls) in {
            "persona": (p_in, p_out, len(persona_msgs)),
            "judge": (j_in, j_out, len(js)),
            "analyst_policy": (a_in, a_out, len(asx)),
            "consistency_audit": (c_in, c_out, n_audit),
            "client_reaction": (r_in, r_out, n_react),
        }.items():
            rows.append({"metric": f"tokens_{kind}_prompt", "run": label, "mode": mode, "unit": "tok",
                         "n": ncalls, "mean": round(ti / ncalls, 1) if ncalls else None, "sd": None,
                         "median": None, "min": None, "max": None, "ci95_lo": None, "ci95_hi": None,
                         "note": f"engagement total {ti}"})
            rows.append({"metric": f"tokens_{kind}_completion", "run": label, "mode": mode, "unit": "tok",
                         "n": ncalls, "mean": round(to / ncalls, 1) if ncalls else None, "sd": None,
                         "median": None, "min": None, "max": None, "ci95_lo": None, "ci95_hi": None,
                         "note": f"engagement total {to}"})

        tot_in = p_in + j_in + a_in + c_in + r_in
        tot_out = p_out + j_out + a_out + c_out + r_out
        n_calls = len(persona_msgs) + len(js) + len(asx) + n_audit + n_react
        # persona and the client reaction run on the persona model (Sonnet 5);
        # the rubric judge and the consistency auditor on the judge model
        # (Opus 4.8). The analyst policy runs on the model its analyst_step
        # events record (a run can be started on its own analyst model, for
        # example A2 on Haiku 4.5); a run that records none, or the mock, is
        # priced as the persona model, as before.
        sp_in, sp_out = prices[args.persona_model]["input"], prices[args.persona_model]["output"]
        op_in, op_out = prices[args.judge_model]["input"], prices[args.judge_model]["output"]
        analyst_model = analyst_model_of(asx, prices, args.persona_model)
        ap_in, ap_out = prices[analyst_model]["input"], prices[analyst_model]["output"]
        sonnet_in, sonnet_out = p_in + r_in, p_out + r_out
        opus_in, opus_out = j_in + c_in, j_out + c_out
        usd = (sonnet_in * sp_in + sonnet_out * sp_out + a_in * ap_in + a_out * ap_out
               + opus_in * op_in + opus_out * op_out) / 1e6
        price_note = (f"{model_label(args.persona_model)} ${sp_in:g}/${sp_out:g}, "
                      f"{model_label(args.judge_model)} ${op_in:g}/${op_out:g} per MTok")
        if analyst_model != args.persona_model:
            price_note += f"; analyst {model_label(analyst_model)} ${ap_in:g}/${ap_out:g}"
        # Persona-reply cost: the persona model's tokens on persona replies only.
        reply_usd = (p_in * sp_in + p_out * sp_out) / 1e6
        reply_cost_rows.append({
            "run": label, "mode": mode, "group": group, "persona_replies": len(persona_msgs),
            "prompt_tokens": p_in, "completion_tokens": p_out,
            "usd_total": round(reply_usd, 6),
            "usd_per_reply": round(reply_usd / len(persona_msgs), 4) if len(persona_msgs) else None,
            "prices": price_note,
        })

        for name, val, unit, note in [
            ("tokens_total_prompt", tot_in, "tok", f"{stages_reached} stages reached"),
            ("tokens_total_completion", tot_out, "tok", ""),
            ("tokens_total", tot_in + tot_out, "tok", info["metering_regime"]),
            ("tokens_per_stage", round((tot_in + tot_out) / stages_reached, 1), "tok", f"total / {stages_reached} stages"),
            ("llm_calls_total", n_calls, "calls", "persona + judge + analyst policy + audit + reaction"),
            ("cost_usd_list", round(usd, 4), "USD", price_note),
            ("cost_usd_per_stage_list", round(usd / stages_reached, 4), "USD", ""),
            ("unmetered_llm_calls", unmetered, "calls",
             "audits/reactions that recorded no usage; 0 once "
             + (f"{args.metering_ref} is deployed" if args.metering_ref else "every call is metered")),
        ]:
            rows.append({"metric": name, "run": label, "mode": mode, "unit": unit, "n": 1,
                         "mean": val, "sd": None, "median": val, "min": val, "max": val,
                         "ci95_lo": None, "ci95_hi": None, "note": note})

        # ---------- TOKENS BY STAGE ----------
        # Every metered call is attributed to the stage whose [entry, exit)
        # interval contains its timestamp; boundaries are the same
        # `stage_advanced` events used for stage dwell time, so the split is
        # consistent with the latency table. Calls are bucketed by wall-clock
        # rather than by a stage field because messages carry no stage column.
        adv = e[e.event_type == "stage_advanced"]
        stage_names = [(adv.iloc[0].d.get("from") if len(adv) else None) or "formulation"]
        for _, r in adv.iterrows():
            stage_names.append(r.d.get("to") or r.d.get("stage") or f"stage{len(stage_names)}")
        # bounds[] was built above for dwell time and has len(stage_names)+1 edges
        # when the run completed, len(stage_names) otherwise.
        edges = list(bounds)
        if len(edges) < len(stage_names) + 1:
            edges.append(e.iloc[-1].ts)

        def bucket(ts):
            for k in range(len(stage_names)):
                if edges[k] <= ts < edges[k + 1] or (k == len(stage_names) - 1 and ts >= edges[k]):
                    return k
            return len(stage_names) - 1

        by_stage = {k: {} for k in range(len(stage_names))}

        def add(k, kind, ti, to):
            d = by_stage[k].setdefault(kind, [0, 0, 0])
            d[0] += 1
            d[1] += int(ti or 0)
            d[2] += int(to or 0)

        for _, r in persona_msgs.iterrows():
            add(bucket(pd.Timestamp(r.timestamp_iso).tz_convert("UTC")), "persona", r.prompt_tokens, r.completion_tokens)
        for _, r in reaction_msgs.iterrows():
            add(bucket(pd.Timestamp(r.timestamp_iso).tz_convert("UTC")), "client_reaction", r.prompt_tokens, r.completion_tokens)
        for _, r in js.iterrows():
            add(bucket(r.ts), "judge", r.d.get("judgePromptTokens", 0), r.d.get("judgeCompletionTokens", 0))
        for _, r in asx.iterrows():
            add(bucket(r.ts), "analyst_policy", r.d.get("promptTokens", 0), r.d.get("completionTokens", 0))
        for _, r in aud_ev.iterrows():
            add(bucket(r.ts), "consistency_audit", r.d.get("promptTokens", 0), r.d.get("completionTokens", 0))

        for k, name in enumerate(stage_names):
            for kind, (nc, ti, to) in sorted(by_stage[k].items()):
                stage_token_rows.append({
                    "run": label, "mode": mode, "group": group, "stage_index": k,
                    "stage": name, "call_type": kind, "calls": nc,
                    "prompt_tokens": ti, "completion_tokens": to, "tokens": ti + to,
                })
            tot = sum(v[1] + v[2] for v in by_stage[k].values())
            stage_token_rows.append({
                "run": label, "mode": mode, "group": group, "stage_index": k,
                "stage": name, "call_type": "ALL", "calls": sum(v[0] for v in by_stage[k].values()),
                "prompt_tokens": sum(v[1] for v in by_stage[k].values()),
                "completion_tokens": sum(v[2] for v in by_stage[k].values()), "tokens": tot,
            })

        # ---------- AUDIT RATE ----------
        n_turns = len(e[e.event_type == "persona_turn"])
        consistent = sum(1 for _, r in aud_ev.iterrows() if r.d.get("consistent") is True)
        inconsistent = sum(1 for _, r in aud_ev.iterrows() if r.d.get("consistent") is False)
        failed = n_audit - consistent - inconsistent
        rate = n_audit / n_turns if n_turns else float("nan")
        regime = f"guaranteed-first-two {info['audit_floor']}"
        for name, val, unit, note in [
            ("persona_turns", n_turns, "turns", ""),
            ("consistency_audits", n_audit, "audits", regime),
            ("audit_rate", round(rate, 3), "ratio", f"{n_audit}/{n_turns}; cohort rate {rate_txt}; {regime}"),
            ("audits_consistent", consistent, "audits", ""),
            ("audits_inconsistent", inconsistent, "audits", ""),
            ("audits_failed", failed, "audits", ""),
        ]:
            rows.append({"metric": name, "run": label, "mode": mode, "unit": unit, "n": 1,
                         "mean": val, "sd": None, "median": val, "min": val, "max": val,
                         "ci95_lo": None, "ci95_hi": None, "note": note})

        # Audit verdict totals, all and by turn position: the first
        # `guaranteed` replies of each persona (always audited once the floor is
        # in force) against later replies (sampled).
        rep_first, rep_later = replies_by_position(m, guaranteed)
        verdicts = []
        for (_, r), pos in zip(aud_ev.iterrows(), positions):
            v = r.d.get("consistent")
            verdicts.append(("first_two" if pos <= guaranteed else "later",
                             "consistent" if v is True else "inconsistent" if v is False else "failed"))
        for scope, replies, sel in [("all", rep_first + rep_later, verdicts),
                                    ("first_two", rep_first, [v for v in verdicts if v[0] == "first_two"]),
                                    ("later", rep_later, [v for v in verdicts if v[0] == "later"])]:
            audit_rows.append({
                "run": label, "mode": mode, "group": group, "position": scope,
                "replies": replies, "audits": len(sel),
                "consistent": sum(1 for v in sel if v[1] == "consistent"),
                "inconsistent": sum(1 for v in sel if v[1] == "inconsistent"),
                "failed": sum(1 for v in sel if v[1] == "failed"),
                "audit_rate": round(len(sel) / replies, 3) if replies else None,
            })
        ap = audit_pool.setdefault(group, [0, 0, []])
        ap[0] += rep_first
        ap[1] += rep_later
        ap[2].extend(verdicts)

        # ---------- RUBRIC TOTAL ----------
        # One score per criterion per attempt; the run's total takes the last
        # attempt at each stage (the one that stands when the gate closes).
        sce = sc[sc.engagement_id == eid]
        stage_rows = []
        for stage, g in sce.groupby("stage", sort=False):
            final = g[g.attempt == g.attempt.max()]
            stage_rows.append({
                "stage": stage,
                "attempt": int(g.attempt.max()),
                "attempts": int(g.attempt.nunique()),
                "score": int(final.score.sum()),
                "max": int(final.max_score.sum()),
                "passed": bool(final.passed.iloc[0]),
            })
        # stage order as first submitted
        order = list(dict.fromkeys(sce.sort_values("submitted_at").stage))
        stage_rows.sort(key=lambda r: order.index(r["stage"]))
        info["stage_scores"] = stage_rows
        info["rubric_total"] = sum(r["score"] for r in stage_rows)
        info["rubric_max"] = sum(r["max"] for r in stage_rows)
        for name, val, unit, note in [
            ("rubric_total_score", info["rubric_total"], "pts", f"last attempt per stage; out of {info['rubric_max']}"),
            ("rubric_max_score", info["rubric_max"], "pts", f"{len(stage_rows)} stages scored"),
            ("rubric_ratio", round(info["rubric_total"] / info["rubric_max"], 4) if info["rubric_max"] else None,
             "ratio", ""),
        ]:
            rows.append({"metric": name, "run": label, "mode": mode, "unit": unit, "n": 1,
                         "mean": val, "sd": None, "median": val, "min": val, "max": val,
                         "ci95_lo": None, "ci95_hi": None, "note": note})
        for r in stage_rows:
            rows.append({"metric": f"rubric_stage_{r['stage']}", "run": label, "mode": mode, "unit": "pts",
                         "n": 1, "mean": r["score"], "sd": None, "median": r["score"],
                         "min": r["score"], "max": r["max"], "ci95_lo": None, "ci95_hi": None,
                         "note": f"{r['score']}/{r['max']}; attempts {r['attempts']}; passed={r['passed']}"})

        info.update(dict(p_in=p_in, p_out=p_out, j_in=j_in, j_out=j_out, a_in=a_in, a_out=a_out,
                         c_in=c_in, c_out=c_out, r_in=r_in, r_out=r_out,
                         n_persona=len(persona_msgs), n_judge=len(js), n_policy=len(asx),
                         n_audit=n_audit, n_react=n_react, n_turns=n_turns, n_calls=n_calls,
                         unmetered=unmetered, usd=round(usd, 4),
                         usd_per_stage=round(usd / stages_reached, 4),
                         tokens_total=tot_in + tot_out, stages=stages_reached,
                         audit_regime=regime, consistent=consistent, inconsistent=inconsistent,
                         failed=failed))
        per_run[label] = info

    for (mode, metric), vals in pool.items():
        rows.append(describe(vals, metric, f"{mode} (pooled)", mode, "s",
                             "both runs of this mode pooled at the call level"))

    # Pooled over the paper-ready agent runs only (A3 + A4: fully metered,
    # rubric-v2 / consistency-v2, audit floor in force). These are the agent
    # numbers the paper should quote.
    paper_labels = [l for (l, g) in RUNS.values() if g == "paper" and l in per_run]
    pooled_name = "+".join(paper_labels) + " (paper-ready, pooled)"
    # rubric versions first, then consistency versions, each in sorted order
    paper_versions = []
    for k in (0, 1):
        for v in sorted({v for l in paper_labels for v in (versions_by_label[l][k] or [])}):
            if v not in paper_versions:
                paper_versions.append(v)
    paper_metered = paper_labels and all(metered_by_label[l] for l in paper_labels)
    for (grp, metric), vals in gpool.items():
        if grp != "paper":
            continue
        rows.append(describe(vals, metric, pooled_name, "agent", "s",
                             "call-level pool over " + " + ".join(paper_labels)
                             + ("; fully metered" if paper_metered else "; not all fully metered")
                             + (", " + " / ".join(paper_versions) if paper_versions else "")))


    out = pd.DataFrame(rows)
    out.to_csv(OUT / "metrics-summary.csv", index=False)

    pd.DataFrame(stage_token_rows).to_csv(OUT / "tokens-by-stage.csv", index=False)

    chk = pd.DataFrame(classifier_check)
    chk.to_csv(OUT / "message-classifier-check.csv", index=False)

    summary = pd.DataFrame([
        {k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in info.items()}
        for info in per_run.values()
    ])
    summary.to_csv(OUT / "run-summary.csv", index=False)

    # Per-persona-reply cost, pooled over the paper-ready runs as well.
    rc = pd.DataFrame(reply_cost_rows)
    paper_rc = rc[rc.group == "paper"]
    if len(paper_rc):
        n_rep = int(paper_rc.persona_replies.sum())
        usd_rep = float(paper_rc.usd_total.sum())
        rc = pd.concat([rc, pd.DataFrame([{
            "run": pooled_name, "mode": "agent", "group": "paper", "persona_replies": n_rep,
            "prompt_tokens": int(paper_rc.prompt_tokens.sum()),
            "completion_tokens": int(paper_rc.completion_tokens.sum()),
            "usd_total": round(usd_rep, 6),
            "usd_per_reply": round(usd_rep / n_rep, 4) if n_rep else None,
            "prices": paper_rc.prices.iloc[0],
        }])], ignore_index=True)
    rc.to_csv(OUT / "cost-per-reply.csv", index=False)

    # Audit verdict totals, per run and pooled over each group.
    for grp, (rf, rl, vs) in audit_pool.items():
        if grp != "paper":
            continue
        for scope, replies, sel in [("all", rf + rl, vs),
                                    ("first_two", rf, [v for v in vs if v[0] == "first_two"]),
                                    ("later", rl, [v for v in vs if v[0] == "later"])]:
            audit_rows.append({
                "run": pooled_name, "mode": "agent", "group": grp, "position": scope,
                "replies": replies, "audits": len(sel),
                "consistent": sum(1 for v in sel if v[1] == "consistent"),
                "inconsistent": sum(1 for v in sel if v[1] == "inconsistent"),
                "failed": sum(1 for v in sel if v[1] == "failed"),
                "audit_rate": round(len(sel) / replies, 3) if replies else None,
            })
    au = pd.DataFrame(audit_rows)
    au.to_csv(OUT / "audit-totals.csv", index=False)

    print(out.to_string())
    print()
    print("--- cost per persona reply ---")
    print(rc.to_string(index=False))
    print()
    print("--- audit verdicts by turn position ---")
    print(au.to_string(index=False))
    print()
    print("--- message classifier check (positional split vs zero-token split) ---")
    print(chk.to_string(index=False))
    print()
    for k, v in per_run.items():
        print(k, json.dumps(v, default=str, indent=1))

    # flagged quotes
    print("\n--- inconsistent verdicts (verbatim) ---")
    for _, r in ev[ev.event_type == "persona_consistency"].iterrows():
        if r.d.get("consistent") is False:
            lbl = RUNS.get(r.engagement_id, (r.engagement_id, "?"))[0]
            print(lbl, "|", r.d.get("personaId"), "|", r.d.get("promptVersion"), "|", r.d.get("contradiction"))
    print("\n--- failed audits ---")
    for _, r in ev[ev.event_type == "persona_consistency"].iterrows():
        if r.d.get("consistent") is None:
            lbl = RUNS.get(r.engagement_id, (r.engagement_id, "?"))[0]
            print(lbl, "|", r.d.get("personaId"), "|", r.d.get("error"))


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--source", required=True, help="export-dir:<dir> written by pull-db.ts / fetch-exports.ts")
    ap.add_argument("--runs", required=True, help="label=engagement-id[:group],... (group: paper | exemplar | context)")
    ap.add_argument("--prices", required=True, help="prices.json written by export-prices.ts (from lib/llm/prices.ts)")
    ap.add_argument("--out", required=True, help="directory for the output CSVs")
    ap.add_argument("--cohort", help="cohort slug (export file prefix); needed when the dir holds several")
    ap.add_argument("--persona-model", default=DEFAULT_PERSONA_MODEL)
    ap.add_argument("--judge-model", default=DEFAULT_JUDGE_MODEL)
    ap.add_argument("--guaranteed-turns", type=int, default=DEFAULT_GUARANTEED_TURNS,
                    help="GUARANTEED_AUDIT_TURNS in lib/agents/consistency.ts (default 2)")
    ap.add_argument("--audit-rate", type=float, default=None,
                    help="cohort audit sampling rate; default: read from db-cohorts.csv")
    ap.add_argument("--metering-cutoff", help="ISO time: runs starting later are fully metered (default: observe from the data)")
    ap.add_argument("--metering-ref", help="label for the metering commit, e.g. e65c008")
    ap.add_argument("--audit-floor-cutoff", help="ISO time: runs starting later have the audit floor (default: observe)")
    return ap.parse_args(argv)


if __name__ == "__main__":
    main(parse_args())
