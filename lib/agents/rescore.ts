// Instructor "Rescore" for a gate submission that never got a verdict: a row
// left pending by a crashed request, or marked failed because the judge call
// threw (a provider outage). Such rows do not count as attempts, and without
// this the only way forward was a force-advance that skipped the judge.
//
// The submission is scored with the current judge prompt against the
// engagement record as it stands now. When it belongs to the stage the
// engagement is still on, the cohort's gate policy is applied as it would
// have been at submission time, so a passing rescore advances the stage.
// When the engagement has moved on (a later submission passed, or an
// instructor forced the stage), the scores are stored for the record and the
// stage is left alone. The client sponsor does not react to a rescore.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { submissions } from "@/lib/db/schema";
import { scoreSubmission } from "@/lib/agents/rubric";
import {
  applyGateDecision,
  countScoredAttempts,
  markScoringFailed,
  recordRubricScores,
} from "@/lib/agents/stage-gate";
import { getEngagement, getLedger, logEvent } from "@/lib/engagement/state";
import { getConversationRecord } from "@/lib/engagement/elicitation";
import { loadScenario } from "@/lib/scenarios/load";
import type { CohortConfig } from "@/lib/cohort/defaults";
import type { StageId } from "@/lib/scenarios/types";

export const SUBMISSION_RESCORED_EVENT = "submission_rescored";

export type RescoreResult =
  | { status: "scored"; advanced: boolean }
  | { status: "not-found" | "already-scored" | "judge-failed" };

export async function rescoreSubmission(submissionId: string, config: CohortConfig): Promise<RescoreResult> {
  const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!submission) return { status: "not-found" };
  if (submission.status === "scored") return { status: "already-scored" };

  const engagement = await getEngagement(submission.engagementId);
  if (!engagement) return { status: "not-found" };
  const scenario = await loadScenario(engagement.scenarioId);
  const stageId = submission.stage as StageId;
  const stage = scenario.stages.find((s) => s.id === stageId);
  if (!stage) return { status: "not-found" };

  const ledger = await getLedger(engagement.id);
  let rubric;
  try {
    rubric = await scoreSubmission({
      scenario,
      stage,
      submissionText: submission.contentText,
      ledger,
      mode: engagement.mode === "agent" ? "agent" : "human",
      conversation: await getConversationRecord(engagement, scenario, stageId),
    });
  } catch (err) {
    await markScoringFailed(engagement, submission.id, stageId, err);
    return { status: "judge-failed" };
  }

  const attempt = (await countScoredAttempts(engagement.id, stageId)) + 1;
  await recordRubricScores(engagement, submission.id, stageId, rubric);

  const onCurrentStage = engagement.status === "active" && engagement.currentStage === stageId;
  await logEvent(engagement.id, engagement.cohortId, SUBMISSION_RESCORED_EVENT, {
    submissionId: submission.id,
    stage: stageId,
    previousStatus: submission.status,
    gateApplied: onCurrentStage,
  });
  if (!onCurrentStage) return { status: "scored", advanced: false };

  const gate = await applyGateDecision({
    engagement,
    scenario,
    config,
    stageId,
    submissionId: submission.id,
    attempt,
    rubric,
    extraDetail: { rescored: true },
  });
  return { status: "scored", advanced: gate.advanced };
}
