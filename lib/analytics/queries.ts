// Aggregate queries for the instructor's cohort analytics. Grouping is done
// in SQL except for the criterion means (see criterionMeans). Learners appear
// only as pseudonymous hashes.

import { and, count, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { checkins, engagements, events, messages, rubricScores, submissions } from "@/lib/db/schema";
import { meanEffectiveScores, type CriterionMean } from "@/lib/engagement/effective-score";
import { isScriptedReplay } from "@/lib/admin/run-kind";
import type { CohortConfig } from "@/lib/cohort/defaults";

// Analyst-agent runs go through the same pipeline as learners and write the
// same rows, so left unfiltered they inflate the funnel and pull the rubric
// means toward the agent's work. Every query below reads human engagements
// only unless the caller asks for agent runs as well.
//
// Sandbox seats (learners who came in through the public /try link) are left
// out the same way unless the caller asks for them:
// strangers' runs must not sit in a class's funnel and means.
export interface AnalyticsScope {
  includeAgentRuns?: boolean;
  includeSandbox?: boolean;
}

// The engagement's learner seat was not created by the sandbox. The outer
// column is spelled out: inside a subquery drizzle would render it
// unqualified, where it binds to the subquery's own table.
export const notSandboxSeat: SQL = sql`not exists (
  select 1 from students s
  where s.id = "engagements"."student_id" and s.profile_json ->> 'kind' = 'sandbox'
)`;

export function inScope(cohortId: string, scope?: AnalyticsScope): SQL {
  const parts: SQL[] = [eq(engagements.cohortId, cohortId)];
  if (!scope?.includeAgentRuns) parts.push(eq(engagements.mode, "human"));
  if (!scope?.includeSandbox) parts.push(notSandboxSeat);
  return and(...parts) as SQL;
}

export interface ModeCounts {
  // Human engagements from invited learners.
  human: number;
  agent: number;
  // Human engagements from sandbox seats.
  sandbox: number;
}

// Engagement counts by provenance, so the analytics view can say how many
// runs the current filter is leaving out.
export async function modeCounts(cohortId: string): Promise<ModeCounts> {
  const rows = await db
    .select({
      mode: engagements.mode,
      sandbox: sql<boolean>`not ${notSandboxSeat}`,
      count: count(),
    })
    .from(engagements)
    .where(eq(engagements.cohortId, cohortId))
    .groupBy(engagements.mode, sql`2`);
  const out: ModeCounts = { human: 0, agent: 0, sandbox: 0 };
  for (const r of rows) {
    if (r.mode === "agent") out.agent += Number(r.count);
    else if (r.sandbox === true || (r.sandbox as unknown) === "t") out.sandbox += Number(r.count);
    else out.human += Number(r.count);
  }
  return out;
}

// Of the invited (non-sandbox) human engagements, how many are author
// replays (lib/admin/run-kind.ts). They are counted under ModeCounts.human
// and kept in the default scope, but are labelled as author replays rather
// than as invited learners.
export async function scriptedReplayCount(
  cohortId: string,
  showcase: Pick<CohortConfig["showcase"], "labels" | "scriptedReplays">,
): Promise<number> {
  const rows = await db
    .select({ id: engagements.id, mode: engagements.mode })
    .from(engagements)
    .where(and(eq(engagements.cohortId, cohortId), eq(engagements.mode, "human"), notSandboxSeat));
  return rows.filter((r) => isScriptedReplay(showcase, r)).length;
}

export interface StageFunnelRow {
  scenarioId: string;
  currentStage: string;
  status: string;
  count: number;
}

// How far the cohort's engagements have progressed, per scenario.
export async function stageFunnel(
  cohortId: string,
  scope?: AnalyticsScope,
): Promise<StageFunnelRow[]> {
  const rows = await db
    .select({
      scenarioId: engagements.scenarioId,
      currentStage: engagements.currentStage,
      status: engagements.status,
      count: count(),
    })
    .from(engagements)
    .where(inScope(cohortId, scope))
    .groupBy(engagements.scenarioId, engagements.currentStage, engagements.status);
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

export type CriterionMeanRow = CriterionMean;

// Mean effective rubric score (instructor override when present, otherwise
// the judge) per criterion, per stage, per scenario, across all scored
// submissions in the cohort (resubmissions included). Aggregated with the
// shared helper in lib/engagement/effective-score.ts so this figure agrees
// with the monitor and the CSV.
export async function criterionMeans(
  cohortId: string,
  scope?: AnalyticsScope,
): Promise<CriterionMeanRow[]> {
  const rows = await db
    .select({
      scenarioId: engagements.scenarioId,
      stage: submissions.stage,
      criterionId: rubricScores.criterionId,
      score: rubricScores.score,
      overrideScore: rubricScores.overrideScore,
      maxScore: rubricScores.maxScore,
    })
    .from(rubricScores)
    .innerJoin(submissions, eq(submissions.id, rubricScores.submissionId))
    .innerJoin(engagements, eq(engagements.id, rubricScores.engagementId))
    .where(inScope(cohortId, scope));
  return meanEffectiveScores(rows);
}

export interface EngagementActivityRow {
  engagementId: string;
  learnerMessages: number;
}

export interface ConsistencySummary {
  personaTurns: number;
  // Client reactions to a gate submission. They are persona replies too, and
  // every one is audited, so they belong in the denominator.
  reactions: number;
  audited: number;
  consistent: number;
  flagged: number;
  auditErrors: number;
}

// Role-consistency audit outcomes across the cohort: how many persona replies
// happened (chat turns and gate reactions), how many were audited, and the
// verdict split. The per-cohort rate is `consistent / (consistent + flagged)`.
export async function consistencySummary(
  cohortId: string,
  scope?: AnalyticsScope,
): Promise<ConsistencySummary> {
  // Joined through the engagement rather than read off events.cohortId: the
  // join is what makes the human/agent filter available here too.
  const rows = await db
    .select({ type: events.type, detailJson: events.detailJson })
    .from(events)
    .innerJoin(engagements, eq(engagements.id, events.engagementId))
    .where(inScope(cohortId, scope));
  const summary: ConsistencySummary = { personaTurns: 0, reactions: 0, audited: 0, consistent: 0, flagged: 0, auditErrors: 0 };
  for (const r of rows) {
    if (r.type === "persona_turn") summary.personaTurns++;
    if (r.type === "client_reaction") summary.reactions++;
    if (r.type === "persona_consistency") {
      summary.audited++;
      const verdict = (r.detailJson as { consistent?: boolean | null } | null)?.consistent;
      if (verdict === true) summary.consistent++;
      else if (verdict === false) summary.flagged++;
      else summary.auditErrors++;
    }
  }
  return summary;
}

export interface CheckinMeanRow {
  stage: string;
  kind: string; // start | complete
  mean: number;
  n: number;
}

// Mean confidence per pipeline stage at engagement start versus completion.
export async function checkinMeans(
  cohortId: string,
  scope?: AnalyticsScope,
): Promise<CheckinMeanRow[]> {
  const rows = await db
    .select({ kind: checkins.kind, answersJson: checkins.answersJson })
    .from(checkins)
    .innerJoin(engagements, eq(engagements.id, checkins.engagementId))
    .where(inScope(cohortId, scope));
  const acc = new Map<string, { total: number; n: number }>();
  for (const r of rows) {
    const answers = r.answersJson as Record<string, number>;
    for (const [stage, value] of Object.entries(answers)) {
      if (typeof value !== "number") continue;
      const key = `${stage}|${r.kind}`;
      const cur = acc.get(key) ?? { total: 0, n: 0 };
      cur.total += value;
      cur.n += 1;
      acc.set(key, cur);
    }
  }
  return [...acc.entries()].map(([key, { total, n }]) => {
    const [stage, kind] = key.split("|");
    return { stage, kind, mean: total / n, n };
  });
}

// Learner message volume per engagement (a cheap engagement-intensity proxy).
export async function learnerMessageCounts(
  cohortId: string,
  scope?: AnalyticsScope,
): Promise<EngagementActivityRow[]> {
  const rows = await db
    .select({
      engagementId: messages.engagementId,
      learnerMessages: count(),
    })
    .from(messages)
    .innerJoin(engagements, eq(engagements.id, messages.engagementId))
    .where(and(inScope(cohortId, scope), eq(messages.sender, "learner")))
    .groupBy(messages.engagementId);
  return rows.map((r) => ({ engagementId: r.engagementId, learnerMessages: Number(r.learnerMessages) }));
}
