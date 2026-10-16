// Shared request-context resolution for learner API routes: cookie ->
// cohort/student -> active engagement (+ scenario). Routes get back either
// a full context or a typed reason they can map to a response.

import { resolveCohortFromRequest, type ResolvedCohort } from "@/lib/cohort/resolve";
import { getCurrentEngagement, loadScenarioFor, type Engagement } from "@/lib/engagement/state";
import type { Scenario } from "@/lib/scenarios/types";

export interface LearnerContext {
  cohort: ResolvedCohort;
  engagement: Engagement;
  scenario: Scenario;
}

export type LearnerContextResult =
  | { ok: true; ctx: LearnerContext }
  | { ok: false; reason: "no-cohort" | "no-engagement"; cohort?: ResolvedCohort };

// Resolves to the learner's active engagement, falling back to their most
// recent one so completed engagements stay reviewable (read paths allow any
// status; write paths must check engagement.status themselves).
export async function resolveLearnerContext(): Promise<LearnerContextResult> {
  const cohort = await resolveCohortFromRequest();
  if (!cohort) return { ok: false, reason: "no-cohort" };
  const engagement = await getCurrentEngagement(cohort.studentId);
  if (!engagement) return { ok: false, reason: "no-engagement", cohort };
  const scenario = await loadScenarioFor(engagement);
  return { ok: true, ctx: { cohort, engagement, scenario } };
}
