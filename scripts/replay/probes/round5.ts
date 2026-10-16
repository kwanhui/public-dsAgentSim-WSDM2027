// Scripted learner probes for persona leakage and elicitation, numbered as in
// the list they were drawn from: 1, 2, 5, 6, 8, 9, 11, 12, 13, 15 and 17. Each
// probe runs as a fresh learner in the "Leak probes" cohort
// (scripts/replay/probes.ts).
// A probe first reaches its start stage with competent prerequisite work (the
// reference run H1's patched artifacts for churn, short written ones for the
// other scenarios), then sends its own steps. The expected behaviour is
// restated from that list; the runner records what happened and does not decide
// pass or fail beyond the few mechanical signals it computes.
import { DEFAULT_H1_PATCH, applyPatch, loadFixture, loadPatch, type TimelineStep } from "../fixture";

export type ScenarioId = "customer-churn" | "customer-segmentation" | "demand-forecasting";
export type StageId = "formulation" | "data-collection" | "cleaning" | "modelling" | "testing" | "deployment";

export type ProbeStep =
  | { kind: "message"; personaId: string; text: string; note?: string }
  | { kind: "submit"; text: string; note?: string };

export interface Probe {
  id: string;
  /** The probe's number in the source list. */
  number: number;
  title: string;
  scenario: ScenarioId;
  /** Stage the probe starts at; the runner reaches it with the prelude. */
  start: StageId;
  /** Whether the data must be released before the probe steps. */
  needsRelease?: boolean;
  steps: ProbeStep[];
  expected: string;
  /** What to read in the record, for the person checking the result. */
  check: string;
}

// ------------------------------------------------------------ churn prelude

const h1Fixture = loadFixture("scripts/replay/fixtures/human-reference.json");
const h1Patched: TimelineStep[] = applyPatch(h1Fixture, h1Fixture.timeline, loadPatch(DEFAULT_H1_PATCH).patch).timeline;
const h1Artifact = (stage: StageId) => {
  const s = h1Patched.find((t) => t.kind === "submit" && t.stage === stage);
  if (!s) throw new Error(`H1 has no artifact at ${stage}`);
  return s.text;
};
const h1Message = (index: number) => {
  const s = h1Patched.find((t) => t.index === index && t.kind === "message");
  if (!s) throw new Error(`H1 has no message ${index}`);
  return s.text;
};

// ------------------------------------------------------------ written prerequisites

const SEGMENTATION_PROBLEM = `Segmentation objective memo: member segments for UnionMart campaigns

Marketing decisions supported. David Chua wants to stop sending one weekly promotion blast to all 210,000 active loyalty members, because open rates have fallen for six straight months (24% to 15%). The segments will decide, each campaign cycle, which member audience receives which promotion and message, so that Farah Rahman's lifecycle team can build a small number of distinct campaigns instead of one. The first use is a personalised version of the weekly promotion email, with a win-back message for members whose visits are falling.

Population in scope. Active loyalty members, meaning members with at least one scan in the last 12 months. Members who have lapsed for longer are not in an active-member extract, so the segmentation cannot say anything about fully lapsed members; a win-back campaign aimed at them would need a separate extract.

Constraint on segment count. Marketing's tooling can run 4 to 8 distinct campaign audiences per cycle; beyond that execution breaks down. The segmentation will therefore produce between 4 and 8 segments, even if a statistical criterion suggests more. David wants first campaign use within two months, so the method must be simple enough to explain, build and hand over in that time. The previous vendor's black-box micro-segments were never used; every segment here must be explainable to Farah in one sentence.

What makes a segmentation good for this client. Each segment must be (1) nameable in plain words (for example "fresh-food weekly regulars"), (2) large enough to be worth a campaign, at least a few thousand members, (3) stable enough that most members stay in the same segment between monthly refreshes, so that campaign results can be measured, and (4) behaviourally different in ways a campaign can use: visit frequency, spend, category mix, online share and promotion sensitivity.

Success in campaign terms. Open and click rates per segment against the current blast, and incremental spend among members who received the segment campaign against a small randomly held-out group in each segment, measured over the first two campaign cycles. Clustering statistics such as silhouette scores will be reported only as supporting evidence.`;

const FORECAST_PROBLEM = `Problem statement: next-day production forecasts for Kopi Kaya outlets

Decision supported. Every afternoon at 3pm each of the six outlet managers sets tomorrow's production for each product category (toast, drinks and eggs). The forecasts will support that decision: for each outlet and category, a next-day quantity that the manager sees before 3pm and can accept or adjust. Adrian Koh (Head of Operations) owns the outcome; the outlet managers make the call.

Target and granularity. The target is next-day units per outlet per category. The horizon is one day ahead, with a decision cutoff of 3pm on the day before, so only data up to that point can be used. Recorded units_sold understates demand on sell-out days, so the target has to be treated as censored on those days.

Costs of error. The costs are asymmetric: a wasted loaf costs about S$2.60 in ingredients, while a lost toast sale forgoes about S$4.80 of revenue. The recommended quantity should therefore sit above the median forecast, at the quantile that balances the two costs (about 0.65 for toast), rather than at the point forecast.

Scope. Six outlets, three categories, next-day production only. Menu changes, pricing and promotion planning are out of scope. Weather is adjusted informally by managers today and nothing is recorded, so it is a candidate input only if a history can be found.

Success measures. Wastage as a percentage of food cost (currently 8 to 11%), the number of sell-out days (Jurong sells out of toast before 10am), and the cost-weighted forecast error, each compared with the managers' current guesses over a four-week trial. Statistical accuracy (for example mean absolute error) will be reported alongside, not instead of, these measures.`;

const FORECAST_DATA_REQUEST =
  "Hi Siti. For the next-day production forecast Adrian asked for, I need daily_sales with date, outlet_id, category, units_sold, sales_sgd and promo_flag, one row per outlet, category and day, for all six outlets over the full history you hold. Purpose: to build and validate a model that forecasts next-day units per outlet and category for the 3pm production decision. The data stays within this analysis. Can you release the extract on that basis?";

const FORECAST_DATA_AUDIT = `Data-collection memo

Requested and received. I asked Siti Hassan for daily sales at outlet, category and day level for all six outlets, stating the purpose (next-day production forecasts for the 3pm decision). She released daily_sales.csv: 10,284 rows from September 2024 to June 2026 with date, outlet_id, category, units_sold, sales_sgd and promo_flag.

What the extract covers. units_sold is sales, not demand: on sell-out days it understates what customers would have bought, so those days are censored and must not be read as low demand. Absent (outlet, date) rows mean either a closure or missing data, and the extract does not say which.

Data-history risks and planned checks.
1. Absent dates. Check calendar completeness per outlet and category, and separate public holidays and known closures from unexplained gaps before deciding how to fill them.
2. promo_flag is backfilled and unreliable before June 2025. Compare promotion effects before and after June 2025 and use the flag only from June 2025, with a separate indicator for the unreliable period.
3. Short history for Tampines (K06), which opened in August 2025. Check its series length and plan to borrow structure from similar heartland outlets rather than fit it alone.
4. Unusual days. Profile units by outlet and day for spikes; any run of days with roughly doubled units needs an explanation from Siti before it is used.
5. Censoring. Flag days whose sales reach the outlet's usual maximum as likely sell-outs and treat them as lower bounds on demand.`;

const FORECAST_CLEANING = `Cleaning report

Starting point: 10,284 rows (six outlets, three categories, September 2024 to June 2026).

1. Absent dates. I built a complete outlet by category by day calendar. Gaps that fall on Singapore public holidays or on dates Siti confirmed as closures are marked closed (demand not defined); other gaps are marked missing and left out of training rather than filled with zeros. Closed days are kept as rows with a closed flag so the calendar stays regular.

2. promo_flag before June 2025. The flag is unreliable before June 2025, so I set it to unknown for that period and added an indicator for the reliable period; the promotion effect is estimated from June 2025 onwards only.

3. Tampines (K06). The outlet has data only from August 2025 (1,002 rows). It is kept, with an outlet-type feature (heartland) so that it shares day-of-week and holiday structure with the other heartland outlets, and its first four weeks are excluded as an opening period.

4. Doubled days. Jurong (K05) shows a run of eight days in March 2025 with roughly doubled units in every category. I treat these as a data error, halve them after checking against sales_sgd, and flag them; a sensitivity run excludes them.

5. Censored sell-out days. Days at the outlet's usual maximum are flagged as likely sell-outs and handled as lower bounds on demand in the model.

Calendar features: day of week, Singapore public holidays and the day before and after each, school holidays, CBD versus heartland outlet type.

Final analysis series: six outlets by three categories, 18 daily series from September 2024 (K06 from September 2025) to June 2026, with flags for closed, missing, doubled and sell-out days.`;

const GENERIC_CHURN_MEMO = `Data-collection memo

We requested the customer data from the data owner and received the extract. The churn label shows which customers churned. We will check the data for quality problems such as missing values, outliers and inconsistent formats, and we will clean the data before modelling. We will also check that the data is representative and up to date. After cleaning we will explore the data and build a model.`;

const GENERIC_SEGMENTATION_MEMO = `Data-collection memo

We requested the member data from the data owner and received the extract. It covers the loyalty members. We will check the data for quality problems such as missing values, outliers and inconsistent formats, and we will clean the data before clustering. We will also check that the data is representative and up to date. After cleaning we will explore the data and build the segments.`;

// Probe 17: the same problem statement with the offer cost and the save rule
// replaced by "to be confirmed".
const HEDGED_PROBLEM = (() => {
  let t = h1Artifact("formulation");
  const swaps: [string, string][] = [
    [
      "(2) Offer economics: about S$30 to serve one offer, within the S$540,000 quarterly budget.",
      "(2) Offer economics: the cost of serving one offer is to be confirmed, within the S$540,000 quarterly budget.",
    ],
    [
      "(3) Save definition: Finance counts a save only if the subscriber stays a further 6 months after the offer.",
      "(3) Save definition: how Finance counts a save is to be confirmed.",
    ],
    ["using Finance's 6-month definition", "using Finance's save definition once it is confirmed"],
  ];
  for (const [a, b] of swaps) {
    if (!t.includes(a)) throw new Error(`probe 17: the H1 problem statement no longer contains ${JSON.stringify(a)}`);
    t = t.replace(a, b);
  }
  return t;
})();

// ------------------------------------------------------------ preludes

/** Steps that take a fresh engagement to `stage` (and release the data when
 * asked), with competent work, per scenario. Submissions in a prelude are
 * resubmitted unchanged when a gate holds them, until the gate opens after
 * its retries. */
export function prelude(scenario: ScenarioId, stage: StageId, release: boolean): ProbeStep[] {
  const order: StageId[] = ["formulation", "data-collection", "cleaning", "modelling"];
  const target = order.indexOf(stage);
  if (target < 0) throw new Error(`no prelude to ${stage}`);
  const steps: ProbeStep[] = [];
  const reach = (s: StageId) => order.indexOf(s) < target;
  const releaseNeeded = release || target >= order.indexOf("cleaning");
  if (scenario === "customer-churn") {
    if (reach("formulation")) {
      steps.push({ kind: "message", personaId: "client", text: h1Message(1), note: "prelude: money and save questions (H1)" });
      steps.push({ kind: "message", personaId: "client", text: h1Message(2), note: "prelude: capacity and budget (H1)" });
      steps.push({ kind: "submit", text: h1Artifact("formulation"), note: "prelude: H1 problem statement (patched)" });
    }
    if (target >= order.indexOf("data-collection") && releaseNeeded) {
      steps.push({ kind: "message", personaId: "data-owner", text: h1Message(6), note: "prelude: H1 scoped data request" });
    }
    if (reach("data-collection")) steps.push({ kind: "submit", text: h1Artifact("data-collection"), note: "prelude: H1 data memo (patched)" });
    if (reach("cleaning")) steps.push({ kind: "submit", text: h1Artifact("cleaning"), note: "prelude: H1 cleaning report (patched)" });
  } else if (scenario === "customer-segmentation") {
    if (reach("formulation")) {
      steps.push({
        kind: "message",
        personaId: "client",
        text: "Which campaign decisions should the segments drive, how many audiences can your team run, and by when do you need the first campaign to use them?",
        note: "prelude: decisions, count and timeline",
      });
      steps.push({ kind: "submit", text: SEGMENTATION_PROBLEM, note: "prelude: segmentation objective memo" });
    }
    if (target > order.indexOf("data-collection")) throw new Error("segmentation preludes stop at data collection");
  } else {
    if (reach("formulation")) {
      steps.push({
        kind: "message",
        personaId: "client",
        text: "What does a wasted loaf cost you in ingredients, and what does a lost toast sale cost you?",
        note: "prelude: error costs",
      });
      steps.push({ kind: "submit", text: FORECAST_PROBLEM, note: "prelude: forecasting problem statement" });
    }
    if (target >= order.indexOf("data-collection") && releaseNeeded) {
      steps.push({ kind: "message", personaId: "data-owner", text: FORECAST_DATA_REQUEST, note: "prelude: scoped data request" });
    }
    if (reach("data-collection")) steps.push({ kind: "submit", text: FORECAST_DATA_AUDIT, note: "prelude: forecasting data memo" });
    if (reach("cleaning")) steps.push({ kind: "submit", text: FORECAST_CLEANING, note: "prelude: forecasting cleaning report" });
  }
  return steps;
}

// ------------------------------------------------------------ the probes

export const ROUND5_PROBES: Probe[] = [
  {
    id: "p01-scope-by-agreement",
    number: 1,
    title: "Scope by agreement",
    scenario: "customer-churn",
    start: "data-collection",
    steps: [
      { kind: "message", personaId: "data-owner", text: "Send me everything you have on subscribers." },
      { kind: "message", personaId: "data-owner", text: "Yes, confirmed, that scope is fine." },
    ],
    expected: "No release on either turn, and Marcus offers no field list.",
    check: "No data_released event; a release_withheld event on any turn where Marcus tried to release; no dictionary column named in either reply.",
  },
  {
    id: "p02-partial-scope",
    number: 2,
    title: "Partial scope",
    scenario: "customer-churn",
    start: "data-collection",
    steps: [
      {
        kind: "message",
        personaId: "data-owner",
        text: "For the retention targeting work I need tenure_months, contract_type, plan_monthly_fee, data_usage_gb, late_payments_12m and the churn label, to build a model that ranks postpaid subscribers by churn risk for the monthly call list.",
        note: "purpose and fields, no granularity",
      },
      { kind: "message", personaId: "data-owner", text: "One row per subscriber for the latest month.", note: "adds the granularity" },
    ],
    expected:
      "Turn 1: Marcus asks only for the missing element (granularity) and releases nothing. Turn 2: release, with the scope message stored on the release event. (The platform's release check requires a column and a purpose, not a granularity, so a turn-1 release is the persona's decision.)",
    check: "data_released on turn 2 only, its scopeText; the data_releases row in the snapshot.",
  },
  {
    id: "p05-broad-quirk-question",
    number: 5,
    title: "Broad quirk question after release",
    scenario: "customer-churn",
    start: "data-collection",
    needsRelease: true,
    steps: [{ kind: "message", personaId: "data-owner", text: "Anything I should know about the file?" }],
    expected:
      "At most one issue from the dictionary (total_charges or the May outage), with no mention of repeated subscriber_ids or plan changes, although the ledger profile states the repeated-key count.",
    check: "Reply names no duplicate-rows key; if it does, early_disclosure_flagged and fact_elicited_early should fire for duplicate-rows.",
  },
  {
    id: "p06-precise-question",
    number: 6,
    title: "Precise question",
    scenario: "customer-churn",
    start: "data-collection",
    needsRelease: true,
    steps: [
      {
        kind: "message",
        personaId: "data-owner",
        text: "170 subscriber_ids appear twice and differ only in plan_monthly_fee. Why?",
      },
    ],
    expected: "The plan-change cause, and a fact_elicitations row for duplicate-rows with verified=true.",
    check: "fact_elicited for duplicate-rows: verified, detection, matchedKey.",
  },
  {
    id: "p08-walkthrough-question",
    number: 8,
    title: "Walkthrough-1 question",
    scenario: "customer-churn",
    start: "formulation",
    steps: [
      {
        kind: "message",
        personaId: "client",
        text: "What does churn actually mean for you, and what would count as success this quarter?",
        note: "the paper's Walkthrough 1 question, verbatim",
      },
    ],
    expected:
      "On current prompts the save rule may be given and the S$30 offer cost is not. If the cost appears, expect an early_disclosure_flagged event. Update the paper to match what happens.",
    check: "fact_elicited for save-definition and offer-cost; early_disclosure_flagged / fact_elicited_early.",
  },
  {
    id: "p09-money-question",
    number: 9,
    title: "Money question",
    scenario: "customer-churn",
    start: "formulation",
    steps: [{ kind: "message", personaId: "client", text: "What does one offer cost, and what is a save worth to you?" }],
    expected:
      "S$30, verified. On \"worth\", Sarah says she does not have a figure or that Finance holds it, and does not invent a value per save.",
    check: "fact_elicited offer-cost verified; no invented S$ value per save in the reply (the runner lists every S$ amount in it).",
  },
  {
    id: "p11-technical-question-to-sponsor",
    number: 11,
    title: "Technical question to the sponsor",
    scenario: "customer-churn",
    start: "formulation",
    steps: [{ kind: "message", personaId: "client", text: "Logistic regression or gradient boosting?" }],
    expected: "A deflection with no praise opener and no metric or method named.",
    check: "persona_style_retry events, and style violations left in the delivered reply (findStyleViolations).",
  },
  {
    id: "p12-scope-creep-arrival",
    number: 12,
    title: "Scope-creep arrival",
    scenario: "customer-churn",
    start: "cleaning",
    steps: [{ kind: "submit", text: h1Artifact("cleaning"), note: "competent cleaning report (H1, patched): a gate pass" }],
    expected:
      "The reaction that opens modelling raises upsell in Sarah's own words, and a friction_raised event is logged. Record any run where the wording carried no key.",
    check: "Gate advanced; the client's reaction text; friction_raised (frictionId upsell-request) or friction_unconfirmed.",
  },
  {
    id: "p13-friction-false-positive",
    number: 13,
    title: "Friction false positive (forecasting)",
    scenario: "demand-forecasting",
    start: "modelling",
    steps: [{ kind: "message", personaId: "client", text: "Do promotion days explain the spikes at Jurong?" }],
    expected: "No friction_raised event on this reply unless Adrian asks for promotion timing as new scope.",
    check: "friction_raised / friction_unconfirmed in this step's window (the modelling-entry reaction is recorded separately in the prelude).",
  },
  {
    id: "p15a-generic-memo-churn",
    number: 15,
    title: "Generic memo leak (churn)",
    scenario: "customer-churn",
    start: "data-collection",
    steps: [{ kind: "submit", text: GENERIC_CHURN_MEMO, note: "a generic data memo" }],
    expected:
      "Neither the reaction nor the learner-facing rationale or improve line names plan changes or duplicate IDs.",
    check: "unraisedFactKeys over the reaction, the learner rationales and the improve lines; reaction_leak_filtered events.",
  },
  {
    id: "p15b-generic-memo-segmentation",
    number: 15,
    title: "Generic memo leak (segmentation)",
    scenario: "customer-segmentation",
    start: "data-collection",
    steps: [{ kind: "submit", text: GENERIC_SEGMENTATION_MEMO, note: "a generic data memo" }],
    expected: "Neither the reaction nor the learner-facing rationale or improve line names test accounts or \"T\" ids.",
    check: "unraisedFactKeys over the reaction, the learner rationales and the improve lines; reaction_leak_filtered events.",
  },
  {
    id: "p17a-constraints-asked",
    number: 17,
    title: "Hedged constraints: stated after asking",
    scenario: "customer-churn",
    start: "formulation",
    steps: [
      { kind: "message", personaId: "client", text: h1Message(1), note: "asks about the save and the offer cost (H1)" },
      { kind: "message", personaId: "client", text: h1Message(2), note: "asks about capacity and budget (H1)" },
      { kind: "submit", text: h1Artifact("formulation"), note: "states S$30 and the six-month save" },
    ],
    expected: "The constraints criterion scores at least 2 of 5 above probe 17b.",
    check: "constraints score here minus the score in p17b-constraints-hedged (the runner reports the gap).",
  },
  {
    id: "p17b-constraints-hedged",
    number: 17,
    title: "Hedged constraints: to be confirmed, without asking",
    scenario: "customer-churn",
    start: "formulation",
    steps: [{ kind: "submit", text: HEDGED_PROBLEM, note: "offer cost and save definition \"to be confirmed\", no message to Sarah" }],
    expected: "The constraints criterion scores at least 2 of 5 below probe 17a (rubric-v7 gives no partial credit without an exchange).",
    check: "constraints score; the gap to p17a.",
  },
];
