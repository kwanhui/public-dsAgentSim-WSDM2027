// What the learner routes return about a score: the filtered rationale and
// none of the instructor-only fields (raw score, unverified flag and note).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COHORT_CONFIG } from "@/lib/cohort/defaults";
import { loadScenario } from "@/lib/scenarios/load";

const scenario = await loadScenario("customer-churn");
const handleGateSubmission = vi.fn();

vi.mock("@/lib/engagement/request", () => ({
  resolveLearnerContext: async () => ({
    ok: true,
    ctx: {
      cohort: {
        cohortId: "c1",
        learnerHash: "h".repeat(20),
        cohortName: "C",
        joinRoute: "invite",
        config: DEFAULT_COHORT_CONFIG,
      },
      engagement: { id: "e1", cohortId: "c1", status: "active", currentStage: "formulation", scenarioId: "customer-churn" },
      scenario,
    },
  }),
}));
vi.mock("@/lib/agents/stage-gate", () => ({
  handleGateSubmission: (...a: unknown[]) => handleGateSubmission(...a),
}));
vi.mock("@/lib/llm/budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/budget")>()),
  checkCohortBudget: async () => ({ ok: true }),
}));
vi.mock("@/lib/agents/data-environment", () => ({ getReleasedFiles: async () => [] }));
vi.mock("@/lib/engagement/state", () => ({
  logEvent: async () => {},
  getChannels: async () => [],
  getCheckins: async () => [],
  getChannelMessageCounts: async () => new Map(),
  countLearnerMessages: async () => 0,
  getSubmissions: async () => [
    { id: "s1", stage: "formulation", kind: "problem-statement", status: "scored", createdAt: new Date(), contentText: "x", reflectionText: null },
  ],
  getRubricScores: async () => [
    {
      submissionId: "s1",
      criterionId: "c1",
      score: 2,
      maxScore: 5,
      overrideScore: null,
      rationale: "Full text naming the duplicate subscriber ids.",
      learnerRationale: "The statement does not yet name the data checks.",
      improve: null,
      rawScore: 4,
      unverifiedClaim: true,
      unverifiedNote: "AUC not in any profile",
    },
  ],
}));
vi.mock("@/lib/db/client", () => ({ db: {} }));

const { POST: submit } = await import("@/app/api/engagement/submit/route");
const { GET: me } = await import("@/app/api/engagement/me/route");

beforeEach(() => handleGateSubmission.mockReset());

describe("learner score view", () => {
  it("submit returns the learner scores, not the judge's full result", async () => {
    handleGateSubmission.mockResolvedValue({
      submissionId: "s1",
      passed: false,
      reason: "below",
      advanced: false,
      engagementCompleted: false,
      newStage: null,
      attempt: 1,
      clientReacted: true,
      scoreRatio: 0.4,
      rubric: {
        scores: [{ criterionId: "c1", score: 2, maxScore: 5, rationale: "full", rawScore: 4, unverifiedClaim: true, unverifiedNote: "note" }],
      },
      learnerScores: [{ criterionId: "c1", score: 2, maxScore: 5, rationale: "filtered", improve: null }],
    });
    const res = await submit(
      new Request("http://x/api/engagement/submit", { method: "POST", body: JSON.stringify({ text: "y".repeat(80) }) }),
    );
    const body = await res.json();
    expect(body.scores).toEqual([{ criterionId: "c1", score: 2, maxScore: 5, rationale: "filtered", improve: null }]);
    expect(JSON.stringify(body)).not.toMatch(/rawScore|unverified|full/);
  });

  it("the workspace bundle carries the filtered rationale and no instructor-only field", async () => {
    const body = await (await me()).json();
    const [score] = body.submissions[0].scores;
    expect(score.rationale).toBe("The statement does not yet name the data checks.");
    expect(JSON.stringify(body.submissions)).not.toMatch(/rawScore|unverified|duplicate subscriber/);
    // No override and no review yet: the learner sees the judge's score.
    expect(score).toMatchObject({ score: 2, judgeScore: 2, adjusted: false, overrideNote: null });
    expect(body.submissions[0].reviewed).toBe(false);
  });
});
