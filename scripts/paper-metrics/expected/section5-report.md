# Section 5 figures

Snapshot: `demo/showcase-snapshot.json` (cohort `showcase-meridian-mobile-churn-esagd`, exported 2026-10-07T06:53:16.003Z).
Runs: `H1=26d4e1e6-c1c0-49f8-b013-5993aeaa8ef8:exemplar,A1=2b0e1f3b-5cd7-4cb8-ac89-17af80ac810a:paper,A2=434e523b-ca69-4b67-ba5f-d2f99206955a:paper,exhibit=ae719d83-fddf-453d-903e-9f231a44b6ee:context`.
Prices: Sonnet 5 $2/$10, Opus 4.8 $5/$25, Haiku 4.5 $1/$5 per MTok (USD per million input/output tokens, from `lib/llm/prices.ts`).
Analyst model per agent run: A1 claude-sonnet-5, A2 claude-haiku-4-5; each run's analyst tokens are priced at its own model.

## Per run

| Run | Group | Mode | Completed | Rubric | Rubric prompt | Consistency prompt | Analyst prompt | Tokens | USD metered | USD est. true | USD per persona reply | Wall clock (s) | Audits (consistent / inconsistent) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| H1 | exemplar | human | True | 100/105 | rubric-v10 | consistency-v6 | - | 385344 | 1.3343 | - | 0.0220 | 175.5 | 15 (15 / 0) |
| A1 | paper | agent | True | 84/105 | rubric-v10 | consistency-v6 | analyst-v3 | 432764 | 1.6371 | - | 0.0282 | 405.6 | 14 (14 / 0) |
| A2 | paper | agent | True | 87/105 | rubric-v10 | consistency-v6 | analyst-v3 | 656714 | 2.0228 | - | 0.0236 | 520.0 | 20 (20 / 0) |
| exhibit | context | human | False | 34/35 | rubric-v10 | consistency-v6 | - | 154679 | 0.5446 | - | 0.0258 | 90.9 | 7 (7 / 0) |

USD metered prices every successful call that logged its tokens. USD est. true adds the reconstructed cost of calls that logged none (only for runs recorded before every call was metered). Wall clock (s) here is end to end, from the first event to the last, and includes any gap between an interrupted attempt and its resume; the section below gives the paper's measure, the sum of successful stage attempts.

Persona reply cost: 0.0220 to 0.0282 USD across runs; A1+A2 (paper-ready, pooled): 0.0248 USD over 28 replies.

## Latency (seconds, mean ± sd, n)

| Metric | H1 | A1 | A2 | exhibit | A1+A2 (paper-ready, pooled) |
|---|---|---|---|---|---|
| persona_reply_latency | - | 6.14 ± 1.97 (7) | 4.70 ± 1.71 (21) | - | 5.06 ± 1.85 (28) |
| consistency_audit_latency | 1.50 ± 0.20 (9) | 1.57 ± 0.07 (6) | 1.46 ± 0.27 (11) | 1.53 ± 0.14 (4) | 1.50 ± 0.23 (17) |
| rubric_scoring_latency | 9.12 ± 1.83 (6) | 10.85 ± 2.99 (8) | 10.49 ± 2.00 (8) | 8.99 ± 2.89 (3) | 10.67 ± 2.46 (16) |
| analyst_policy_latency | - | 12.97 ± 8.40 (15) | 8.62 ± 9.11 (29) | - | 10.10 ± 9.02 (44) |
| analyst_stage_wallclock | - | 64.22 ± 44.48 (6) | 82.72 ± 24.49 (6) | - | 73.47 ± 35.57 (12) |
| stage_dwell_time | 29.26 ± 12.85 (6) | 67.60 ± 44.20 (6) | 86.66 ± 25.79 (6) | 42.15 ± 12.24 (2) | 77.13 ± 35.91 (12) |

## Consistency audits

| Run | Position | Persona replies | Audits | Consistent | Inconsistent | Failed | Audit rate |
|---|---|---|---|---|---|---|---|
| H1 | all | 25 | 15 | 15 | 0 | 0 | 0.6 |
| H1 | first_two | 6 | 6 | 6 | 0 | 0 | 1.0 |
| H1 | later | 19 | 9 | 9 | 0 | 0 | 0.474 |
| A1 | all | 15 | 14 | 14 | 0 | 0 | 0.933 |
| A1 | first_two | 6 | 6 | 6 | 0 | 0 | 1.0 |
| A1 | later | 9 | 8 | 8 | 0 | 0 | 0.889 |
| A2 | all | 29 | 20 | 20 | 0 | 0 | 0.69 |
| A2 | first_two | 6 | 6 | 6 | 0 | 0 | 1.0 |
| A2 | later | 23 | 14 | 14 | 0 | 0 | 0.609 |
| exhibit | all | 9 | 7 | 7 | 0 | 0 | 0.778 |
| exhibit | first_two | 4 | 4 | 4 | 0 | 0 | 1.0 |
| exhibit | later | 5 | 3 | 3 | 0 | 0 | 0.6 |
| A1+A2 (paper-ready, pooled) | all | 44 | 34 | 34 | 0 | 0 | 0.773 |
| A1+A2 (paper-ready, pooled) | first_two | 12 | 12 | 12 | 0 | 0 | 1.0 |
| A1+A2 (paper-ready, pooled) | later | 32 | 22 | 22 | 0 | 0 | 0.688 |

## Paper figures per run

Written by `paper-figures.py` from the same exports. "Successful calls" is the basis of the per-run table above; "all metered calls" adds the metered calls of failed attempts (a persona turn that failed schema validation, for example), each priced at the model that served it. The paper reports the all-metered figures. Wall clock for an agent run is the sum of its successful stage attempts; failed and interrupted attempts are left out and listed apart. A run without analyst stage brackets (a scripted replay) reports its end-to-end time.

| Run | Messages (learner or agent) | Persona replies + gate reactions | Tokens, successful calls | Tokens, all metered calls | USD, successful calls | USD, all metered calls | Wall clock (s) | Wall clock basis | Failed attempts (s) | Interrupted attempts (s) | Hidden facts (verified) | Obtained at message | Early flags on the revealing reply / other |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| H1 | 19 | 19 + 6 | 385344 | 385344 | 1.3343 | 1.3343 | 175.5 | end to end (replay or learner; no analyst brackets) | 0 (0.0) | 0 (0.0) | 4 (4) | 2, 2, 9, 14 | 0 / 0 |
| A1 | 7 | 7 + 8 | 432764 | 432764 | 1.6371 | 1.6371 | 385.3 | successful stage attempts | 0 (0.0) | 0 (0.0) | 2 (2) | 2, 4 | 0 / 0 |
| A2 | 21 | 21 + 8 | 656714 | 656714 | 2.0228 | 2.0228 | 496.4 | successful stage attempts | 0 (0.0) | 0 (0.0) | 1 (1) | 13 | 0 / 0 |
| exhibit | 6 | 6 + 3 | 154679 | 154679 | 0.5446 | 0.5446 | 90.9 | end to end (replay or learner; no analyst brackets) | 0 (0.0) | 0 (0.0) | 1 (1) | 2 | 0 / 0 |

Run cost, all metered calls: USD 0.54 to 2.02. Early-disclosure flags: 0, 0 of them on the revealing reply.

## Hidden facts

| Run | Fact | Persona | Learner message | Persona turn | Verified | Early flag on the revealing reply |
|---|---|---|---|---|---|---|
| H1 | offer-cost | client | 2 | 2 | True | False |
| H1 | save-definition | client | 2 | 2 | True | False |
| H1 | duplicate-rows | data-owner | 9 | 4 | True | False |
| H1 | offer-levers | end-user | 14 | 2 | True | False |
| A1 | offer-cost | client | 2 | 2 | True | False |
| A1 | duplicate-rows | data-owner | 4 | 2 | True | False |
| A2 | offer-levers | end-user | 13 | 1 | True | False |
| exhibit | save-definition | client | 2 | 2 | True | False |

## Audits by trigger

Each audit is matched to the persona reply it follows. The floor is a persona's first two chat replies (of which some revealed a fact); later replies are audited when they reveal a fact or when the sample picks them; every gate reaction is audited.

| Run | First two replies (of which reveals) | Reveal-triggered, later | Reactions | Sampled later turns | Total | Consistent / inconsistent / failed |
|---|---|---|---|---|---|---|
| H1 | 6 (2) | 1 | 6 | 2 | 15 | 15 / 0 / 0 |
| A1 | 6 (2) | 0 | 8 | 0 | 14 | 14 / 0 / 0 |
| A2 | 6 (1) | 0 | 8 | 6 | 20 | 20 / 0 / 0 |
| exhibit | 4 (1) | 0 | 3 | 0 | 7 | 7 / 0 / 0 |
| All | 22 (6) | 1 | 25 | 8 | 56 | 56 / 0 / 0 |

## Latency pooled over the pinned runs (seconds)

Pooled from the per-run n, mean and sd above: N = Σn, M = Σn·m / N, s² = [Σ(n − 1)s² + Σn(m − M)²] / (N − 1).

| Metric | Runs | Mean ± sd (n) |
|---|---|---|
| persona_reply_latency | A1+A2 | 5.06 ± 1.85 (28) |
| consistency_audit_latency | H1+A1+A2+exhibit | 1.50 ± 0.20 (30) |
| rubric_scoring_latency | H1+A1+A2+exhibit | 10.09 ± 2.41 (25) |

