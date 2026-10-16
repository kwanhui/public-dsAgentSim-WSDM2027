import { NextResponse } from "next/server";
import { z } from "zod";
import { handleGateSubmission } from "@/lib/agents/stage-gate";
import { resolveLearnerContext } from "@/lib/engagement/request";
import {
  BUDGET_REFUSED_EVENT,
  budgetExceededResponse,
  budgetRefusedDetail,
  checkCohortBudget,
} from "@/lib/llm/budget";
import { logEvent } from "@/lib/engagement/state";

export const runtime = "nodejs";

const BodySchema = z.object({
  text: z.string().min(50).max(20000),
  reflection: z.string().max(5000).optional(),
});

// Submits the current stage's gate artifact: scores it against the rubric,
// applies the cohort's gate policy, and returns the outcome. The client
// persona's in-character reaction is posted before this returns, and
// `clientReacted` says whether it actually landed, so the result banner only
// points at the channel when there is something to read there.
export async function POST(req: Request) {
  const res = await resolveLearnerContext();
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 401 });
  const { engagement, scenario, cohort } = res.ctx;

  if (engagement.status !== "active") {
    return NextResponse.json({ error: "engagement-closed" }, { status: 409 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad-request", detail: "Submission must be between 50 and 20000 characters." },
      { status: 400 },
    );
  }

  // Scoring and the client reaction are model calls. A refusal is logged on
  // the engagement; the learner's draft stays in their browser.
  const budget = await checkCohortBudget({ id: cohort.cohortId, config: cohort.config });
  if (!budget.ok) {
    await logEvent(engagement.id, engagement.cohortId, BUDGET_REFUSED_EVENT, budgetRefusedDetail(budget, "submit", engagement.currentStage));
    return budgetExceededResponse("submit", new Date(), cohort.joinRoute === "sandbox" ? "sandbox" : "course");
  }

  try {
    const outcome = await handleGateSubmission({
      engagement,
      scenario,
      config: cohort.config,
      text: parsed.data.text,
      // Stored only while the cohort collects reflections.
      reflection: cohort.config.research.reflections
        ? parsed.data.reflection?.trim() || undefined
        : undefined,
    });
    const showScores = cohort.config.ui.showRubricScores;
    return NextResponse.json({
      submissionId: outcome.submissionId,
      passed: outcome.passed,
      reason: outcome.reason,
      advanced: outcome.advanced,
      engagementCompleted: outcome.engagementCompleted,
      newStage: outcome.newStage,
      attempt: outcome.attempt,
      clientReacted: outcome.clientReacted,
      scoreRatio: showScores ? outcome.scoreRatio : null,
      // The learner's view of each criterion (filtered rationale, no raw
      // score or unverified note), never the judge's full result.
      scores: showScores ? outcome.learnerScores : [],
    });
  } catch (err) {
    console.error("gate submission failed", err);
    return NextResponse.json({ error: "scoring-unavailable" }, { status: 502 });
  }
}
