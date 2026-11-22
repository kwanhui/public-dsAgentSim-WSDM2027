// The analyst agent's failure path. A stage run that throws (typically when the
// structured-output call comes back unparseable, AI_NoObjectGeneratedError)
// must stop the run, log an event, and hand the caller something to show. A
// silent failure looks exactly like a successful run on screen, which is the
// one outcome a live demo cannot afford.

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const logEvent = vi.fn(async (..._args: unknown[]) => {});
const handleLearnerMessage = vi.fn(async (..._args: unknown[]) => {});
const handleGateSubmission = vi.fn(async (..._args: unknown[]) => ({
  submissionId: "sub-1",
  scoreRatio: 0.8,
  advanced: true,
  engagementCompleted: false,
}));

const ENGAGEMENT = {
  id: "eng-1",
  cohortId: "cohort-1",
  studentId: "student-1",
  scenarioId: "customer-churn",
  currentStage: "formulation",
  status: "active",
  mode: "agent",
  createdAt: new Date("2026-08-20T09:00:00Z"),
  completedAt: null,
};

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));

vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  DEFAULT_TEMPERATURE: 0.4,
  samplingParams: () => ({}),
}));

vi.mock("@/lib/engagement/state", () => ({
  getEngagement: async () => ({ ...ENGAGEMENT }),
  getChannels: async () => [
    {
      id: "chan-1",
      engagementId: ENGAGEMENT.id,
      personaId: "client",
      unlockedAt: new Date("2026-08-20T09:00:00Z"),
      createdAt: new Date("2026-08-20T09:00:00Z"),
    },
  ],
  getMessages: async () => [],
  getEvents: async () => [],
  getSubmissions: async () => [],
  getRubricScores: async () => [],
  countLearnerMessages: async () => 0,
  createEngagement: async () => ({ ...ENGAGEMENT }),
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

vi.mock("@/lib/agents/data-environment", () => ({ getReleasedFiles: async () => [] }));

vi.mock("@/lib/agents/dataset-profile", () => ({
  profileReleasedDatasets: async () => [],
  renderProfile: () => "",
  renderReleasedProfiles: () => "",
}));

vi.mock("@/lib/agents/orchestrator", () => ({
  handleLearnerMessage: (...args: unknown[]) => handleLearnerMessage(...args),
}));

vi.mock("@/lib/agents/stage-gate", () => ({
  handleGateSubmission: (...args: unknown[]) => handleGateSubmission(...args),
}));

const {
  runAnalystStage,
  describeError,
  ANALYST_FAILURE_EVENT,
  ANALYST_REASONING_MAX_CHARS,
} = await import("@/lib/agents/analyst");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");

function noObjectError(): Error {
  const err = new Error("No object generated: response did not match schema.");
  err.name = "AI_NoObjectGeneratedError";
  return err;
}

describe("analyst stage failures", () => {
  beforeEach(() => {
    generateObject.mockReset();
    logEvent.mockClear();
    handleLearnerMessage.mockClear();
    handleGateSubmission.mockClear();
  });

  it("returns the failure instead of throwing, and does not advance", async () => {
    generateObject.mockRejectedValue(noObjectError());

    const result = await runAnalystStage(ENGAGEMENT.id, DEFAULT_COHORT_CONFIG);

    expect(result.advanced).toBe(false);
    expect(result.failure?.errorClass).toBe("AI_NoObjectGeneratedError");
    expect(result.failure?.stage).toBe("formulation");
    expect(result.failure?.message).toContain("No object generated");
  });

  it("logs a failure event carrying the error class and stage", async () => {
    generateObject.mockRejectedValue(noObjectError());

    await runAnalystStage(ENGAGEMENT.id, DEFAULT_COHORT_CONFIG);

    const failureCalls = logEvent.mock.calls.filter((c) => c[2] === ANALYST_FAILURE_EVENT);
    expect(failureCalls).toHaveLength(1);
    const detail = failureCalls[0][3] as Record<string, unknown>;
    expect(detail.errorClass).toBe("AI_NoObjectGeneratedError");
    expect(detail.stage).toBe("formulation");
    expect(detail.model).toBeTruthy();
    expect(detail.promptVersion).toBeTruthy();
  });

  it("meters the failed step's tokens on analyst_step_failed", async () => {
    expect(ANALYST_FAILURE_EVENT).toBe("analyst_step_failed");
    // The step's schema failure is retried once (lib/llm/structured.ts), so
    // the event carries the tokens of both attempts.
    generateObject
      .mockRejectedValueOnce(
        Object.assign(noObjectError(), { usage: { promptTokens: 5000, completionTokens: 3500, totalTokens: 8500 } }),
      )
      .mockRejectedValueOnce(
        Object.assign(noObjectError(), { usage: { promptTokens: 5100, completionTokens: 3400, totalTokens: 8500 } }),
      );
    await runAnalystStage(ENGAGEMENT.id, DEFAULT_COHORT_CONFIG);
    const detail = logEvent.mock.calls.find((c) => c[2] === ANALYST_FAILURE_EVENT)![3] as Record<string, unknown>;
    expect(detail).toMatchObject({ promptTokens: 10100, completionTokens: 6900 });
  });

  it("stops at the first failing step rather than burning the step budget", async () => {
    generateObject.mockRejectedValue(noObjectError());

    const result = await runAnalystStage(ENGAGEMENT.id, DEFAULT_COHORT_CONFIG);

    expect(result.steps).toBe(1);
    // One step: the call and its single schema retry.
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("keeps running after a successful step and reports a later failure", async () => {
    generateObject
      .mockResolvedValueOnce({
        object: {
          reasoning: "Ask the sponsor which decision the churn score will actually drive.",
          action: "message",
          channelPersonaId: "client",
          text: "Which decision does the churn score feed?",
        },
        usage: { promptTokens: 10, completionTokens: 5 },
      })
      .mockRejectedValueOnce(noObjectError());

    const result = await runAnalystStage(ENGAGEMENT.id, DEFAULT_COHORT_CONFIG);

    expect(handleLearnerMessage).toHaveBeenCalledTimes(1);
    expect(result.steps).toBe(2);
    expect(result.failure?.step).toBe(2);
  });

  it("truncates stored reasoning on a word boundary with an ellipsis", async () => {
    const longReasoning = "clarify the churn decision with the sponsor ".repeat(40);
    generateObject.mockResolvedValueOnce({
      object: {
        reasoning: longReasoning,
        action: "message",
        channelPersonaId: "client",
        text: "Which decision does the churn score feed?",
      },
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    generateObject.mockRejectedValueOnce(noObjectError());

    await runAnalystStage(ENGAGEMENT.id, DEFAULT_COHORT_CONFIG);

    const stepCall = logEvent.mock.calls.find((c) => c[2] === "analyst_step");
    const reasoning = (stepCall?.[3] as { reasoning: string }).reasoning;
    expect(reasoning.length).toBeLessThanOrEqual(ANALYST_REASONING_MAX_CHARS + 1);
    expect(reasoning.endsWith("…")).toBe(true);
    // What is kept is a prefix of the original that ends where a word ends,
    // never part-way through one.
    const body = reasoning.slice(0, -1);
    expect(longReasoning.startsWith(body)).toBe(true);
    expect(longReasoning[body.length]).toBe(" ");
  });
});

describe("analyst step logging order", () => {
  beforeEach(() => {
    generateObject.mockReset();
    logEvent.mockClear();
    handleLearnerMessage.mockClear();
    handleGateSubmission.mockClear();
  });

  it("logs the message step before the persona turn runs, so the event log reads in causal order", async () => {
    generateObject
      .mockResolvedValueOnce({
        object: {
          reasoning: "Ask the sponsor which decision the churn score will actually drive.",
          action: "message",
          channelPersonaId: "client",
          text: "Which decision does the churn score feed?",
        },
        usage: { promptTokens: 10, completionTokens: 5 },
      })
      .mockRejectedValueOnce(noObjectError());

    await runAnalystStage(ENGAGEMENT.id, DEFAULT_COHORT_CONFIG);

    const stepIndex = logEvent.mock.calls.findIndex((c) => c[2] === "analyst_step");
    expect(stepIndex).toBeGreaterThanOrEqual(0);
    expect((logEvent.mock.calls[stepIndex][3] as { action: string }).action).toBe("message");
    expect(handleLearnerMessage).toHaveBeenCalledTimes(1);
    // The analyst's stated purpose is logged before the persona pipeline
    // writes its reply and any data_released events.
    expect(logEvent.mock.invocationCallOrder[stepIndex]).toBeLessThan(
      handleLearnerMessage.mock.invocationCallOrder[0],
    );
  });

  it("logs the submit step before the gate runs, so the event log reads in causal order", async () => {
    generateObject.mockResolvedValueOnce({
      object: {
        reasoning: "The brief is clear enough to deliver the artifact.",
        action: "submit",
        channelPersonaId: null,
        text: "Stage artifact.",
      },
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    await runAnalystStage(ENGAGEMENT.id, DEFAULT_COHORT_CONFIG);

    const stepIndex = logEvent.mock.calls.findIndex((c) => c[2] === "analyst_step");
    expect(stepIndex).toBeGreaterThanOrEqual(0);
    expect((logEvent.mock.calls[stepIndex][3] as { action: string }).action).toBe("submit");
    expect(handleGateSubmission).toHaveBeenCalledTimes(1);
    // The decision to submit is logged before the gate pipeline writes its
    // submission_scored / stage_advanced events.
    expect(logEvent.mock.invocationCallOrder[stepIndex]).toBeLessThan(
      handleGateSubmission.mock.invocationCallOrder[0],
    );
  });
});

describe("describeError", () => {
  it("names the error class of a thrown Error", () => {
    expect(describeError(noObjectError()).errorClass).toBe("AI_NoObjectGeneratedError");
    expect(describeError(new TypeError("bad")).errorClass).toBe("TypeError");
  });

  it("survives a thrown non-Error", () => {
    const described = describeError("provider timed out");
    expect(described.errorClass).toBe("string");
    expect(described.message).toBe("provider timed out");
  });
});
