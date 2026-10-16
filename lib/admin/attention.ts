// What needs the instructor's attention in one engagement, for the cohort
// table's "Needs attention" column and filter. Everything here is already
// stored (score rows, submissions, events); this reads it in one pass so an
// instructor with sixty learners does not have to open every monitor. Pure:
// the page does the queries and hands the rows in.
//
// Event type names are spelled out rather than imported from lib/agents so
// this module stays free of the database client.
//
// "Mark reviewed" (engagements.attention_reviewed_at): a flag raised at or
// before the review time no longer counts, so the filter works as a to-do
// list; a flag raised after it brings the engagement back. A submission that
// still needs rescoring is a live state rather than a past flag, so it counts
// until it is rescored. The monitor and the export keep every flag.

import { effectiveScore, type ScoreLike } from "@/lib/engagement/effective-score";

export type AttentionFlag =
  | "unverified"
  | "assessor-directed"
  | "audit-inconsistent"
  | "early-disclosure"
  | "model-failure"
  | "unscored-submission"
  | "budget-refused"
  | "message-cap"
  | "retries-exhausted";

export const ATTENTION_LABELS: Record<AttentionFlag, { one: string; many: string }> = {
  unverified: { one: "unverified result", many: "unverified results" },
  "assessor-directed": { one: "text addressed to the assessor", many: "texts addressed to the assessor" },
  "audit-inconsistent": { one: "audit inconsistency", many: "audit inconsistencies" },
  "early-disclosure": { one: "early disclosure", many: "early disclosures" },
  "model-failure": { one: "persona or judge failure", many: "persona or judge failures" },
  "unscored-submission": { one: "submission needs rescoring", many: "submissions need rescoring" },
  "budget-refused": { one: "budget refusal", many: "budget refusals" },
  "message-cap": { one: "message cap reached", many: "message cap refusals" },
  "retries-exhausted": { one: "advanced with retries exhausted", many: "advanced with retries exhausted" },
};

export const FLAG_ORDER: AttentionFlag[] = [
  "model-failure",
  "unscored-submission",
  "assessor-directed",
  "unverified",
  "retries-exhausted",
  "audit-inconsistent",
  "early-disclosure",
  "budget-refused",
  "message-cap",
];

export interface AttentionScoreRow extends ScoreLike {
  submissionId: string;
  unverifiedClaim: boolean | null;
  createdAt?: Date | string | null;
}

export interface AttentionSubmission {
  id: string;
  stage: string;
  status: string;
  attempt: number | null;
  assessorDirected: boolean | null;
  createdAt?: Date | string | null;
}

export interface AttentionEvent {
  type: string;
  detailJson: unknown;
  timestampIso?: string | null;
}

export interface EngagementAttention {
  /** Effective total over the standing (last scored) submission at each
   * stage, or null when nothing is scored. */
  total: { score: number; max: number } | null;
  /** Scored attempts at the stage the engagement is on now. */
  attemptsAtCurrentStage: number;
  /** Flags raised after the last review (all of them when never reviewed). */
  flags: Partial<Record<AttentionFlag, number>>;
  flagCount: number;
  /** Flags over the whole engagement, reviewed or not. */
  allFlagCount: number;
}

const FAILURE_EVENTS = new Set([
  "persona_failed",
  "submission_scoring_failed",
  "client_reaction_failed",
  "analyst_step_failed",
  "analyst_stage_failed",
]);

function detail(e: AttentionEvent): Record<string, unknown> {
  return e.detailJson && typeof e.detailJson === "object" ? (e.detailJson as Record<string, unknown>) : {};
}

function timeOf(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const t = (typeof value === "string" ? new Date(value) : value).getTime();
  return Number.isNaN(t) ? null : t;
}

export function engagementAttention(input: {
  currentStage: string;
  status: string;
  submissions: AttentionSubmission[];
  scores: AttentionScoreRow[];
  events: AttentionEvent[];
  reviewedAt?: Date | string | null;
}): EngagementAttention {
  const all = countFlags(input, null);
  const reviewed = timeOf(input.reviewedAt);
  const since = reviewed === null ? all : countFlags(input, reviewed);
  return { ...since, allFlagCount: all.flagCount };
}

function countFlags(
  input: {
    currentStage: string;
    status: string;
    submissions: AttentionSubmission[];
    scores: AttentionScoreRow[];
    events: AttentionEvent[];
  },
  reviewedAt: number | null,
): Omit<EngagementAttention, "allFlagCount"> {
  const flags: Partial<Record<AttentionFlag, number>> = {};
  const add = (flag: AttentionFlag, n = 1) => {
    if (n > 0) flags[flag] = (flags[flag] ?? 0) + n;
  };
  // A row with no time counts as new, so a missing timestamp never hides a flag.
  const isNew = (value: Date | string | null | undefined) => {
    if (reviewedAt === null) return true;
    const t = timeOf(value);
    return t === null || t > reviewedAt;
  };

  // Standing total: the last scored submission at each stage, in the order
  // the submissions were made.
  const scoresBySubmission = new Map<string, AttentionScoreRow[]>();
  for (const r of input.scores) {
    const list = scoresBySubmission.get(r.submissionId) ?? [];
    list.push(r);
    scoresBySubmission.set(r.submissionId, list);
  }
  const standing = new Map<string, string>();
  for (const s of input.submissions) {
    if (s.status === "scored" && scoresBySubmission.has(s.id)) standing.set(s.stage, s.id);
  }
  let total: EngagementAttention["total"] = null;
  for (const subId of standing.values()) {
    total ??= { score: 0, max: 0 };
    for (const r of scoresBySubmission.get(subId) ?? []) {
      total.score += effectiveScore(r);
      total.max += r.maxScore;
    }
  }

  const attemptsAtCurrentStage =
    input.status === "completed"
      ? 0
      : input.submissions.filter((s) => s.stage === input.currentStage && s.status === "scored").length;

  add("unverified", input.scores.filter((r) => r.unverifiedClaim === true && isNew(r.createdAt)).length);
  add("unscored-submission", input.submissions.filter((s) => s.status === "failed" || s.status === "pending").length);

  const flaggedSubmissions = new Set(
    input.submissions.filter((s) => s.assessorDirected === true && isNew(s.createdAt)).map((s) => s.id),
  );
  const submissionTime = new Map(input.submissions.map((s) => [s.id, s.createdAt]));
  for (const e of input.events) {
    if (!isNew(e.timestampIso)) continue;
    const d = detail(e);
    if (e.type === "submission_flagged" && typeof d.submissionId === "string") {
      if (isNew(submissionTime.get(d.submissionId))) flaggedSubmissions.add(d.submissionId);
    }
    else if (FAILURE_EVENTS.has(e.type)) add("model-failure");
    else if (e.type === "persona_consistency") {
      if (d.consistent === false) add("audit-inconsistent");
      // The auditor's early-disclosure verdict: the withheld fact ids the
      // persona gave before their reveal condition was met.
      if (Array.isArray(d.disclosedEarly)) add("early-disclosure", d.disclosedEarly.length);
      else if (d.earlyDisclosure === true) add("early-disclosure");
    } else if (e.type === "budget_refused") add("budget-refused");
    else if (e.type === "message_cap_reached") add("message-cap");
    else if (e.type === "submission_scored" && d.passed === false && d.advanced === true) add("retries-exhausted");
  }
  add("assessor-directed", flaggedSubmissions.size);

  const flagCount = Object.values(flags).reduce((a, b) => a + (b ?? 0), 0);
  return { total, attemptsAtCurrentStage, flags, flagCount };
}

/** "2 unverified results, 1 persona or judge failure", in FLAG_ORDER. */
export function attentionLine(flags: Partial<Record<AttentionFlag, number>>): string {
  return FLAG_ORDER.filter((f) => (flags[f] ?? 0) > 0)
    .map((f) => {
      const n = flags[f]!;
      return `${n} ${n === 1 ? ATTENTION_LABELS[f].one : ATTENTION_LABELS[f].many}`;
    })
    .join(", ");
}
