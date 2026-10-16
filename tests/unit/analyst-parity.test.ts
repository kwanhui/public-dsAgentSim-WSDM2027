// The analyst agent passes the checks a learner's chat message passes: the
// cohort's daily budget before each action, and the engagement's message
// cap before each message. Its stage events name the analyst model.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const logEvent = vi.fn(async (..._args: unknown[]) => {});
const handleLearnerMessage = vi.fn(async (..._args: unknown[]) => {});
const handleGateSubmission = vi.fn(async (..._args: unknown[]) => ({ advanced: true, engagementCompleted: false }));
const checkCohortBudget = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as unknown);
let sent = 0;

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
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub", analystModel: "analyst-stub" }),
  DEFAULT_TEMPERATURE: 0.4,
  samplingParams: () => ({}),
}));
vi.mock("@/lib/llm/budget", () => ({
  BUDGET_REFUSED_EVENT: "budget_refused",
  budgetRefusedDetail: (_c: unknown, route: string, stage: string) => ({ route, stage }),
  checkCohortBudget: (...a: unknown[]) => checkCohortBudget(...a),
}));
vi.mock("@/lib/engagement/state", () => ({
  getEngagement: async () => ({ ...ENGAGEMENT }),
  getChannels: async () => [
    { id: "chan-1", engagementId: "eng-1", personaId: "client", unlockedAt: new Date(), createdAt: new Date() },
  ],
  getMessages: async () => [],
  getEvents: async () => [],
  getSubmissions: async () => [],
  getRubricScores: async () => [],
  countLearnerMessages: async () => sent,
  createEngagement: async () => ({ ...ENGAGEMENT }),
  logEvent: (...args: unknown[]) => logEvent(...args),
}));
vi.mock("@/lib/agents/data-environment", () => ({ getReleasedFiles: async () => [] }));
vi.mock("@/lib/agents/dataset-profile", () => ({
  profileReleasedDatasets: async () => [],
  renderReleasedProfiles: () => "",
}));
vi.mock("@/lib/agents/orchestrator", () => ({
  handleLearnerMessage: (...args: unknown[]) => handleLearnerMessage(...args),
}));
vi.mock("@/lib/agents/stage-gate", () => ({
  handleGateSubmission: (...args: unknown[]) => handleGateSubmission(...args),
}));

const { runAnalystStep, runAnalystStage, analystStageEventDetail, ANALYST_FAILURE_EVENT } = await import(
  "@/lib/agents/analyst"
);
const { loadScenario } = await import("@/lib/scenarios/load");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");
const scenario = await loadScenario("customer-churn");

function message() {
  return {
    object: { reasoning: "ask", action: "message", channelPersonaId: "client", text: "What decision does this support?" },
    usage: { promptTokens: 3, completionTokens: 2 },
  };
}

describe("analyst parity with a learner", () => {
  beforeEach(() => {
    generateObject.mockReset();
    logEvent.mockClear();
    handleLearnerMessage.mockClear();
    checkCohortBudget.mockReset().mockResolvedValue({ ok: true });
    sent = 0;
  });

  afterEach(() => vi.unstubAllEnvs());

  it("checks the cohort budget before every action", async () => {
    generateObject.mockResolvedValue(message());
    await runAnalystStep({ engagement: ENGAGEMENT as never, scenario, config: DEFAULT_COHORT_CONFIG });
    await runAnalystStep({ engagement: ENGAGEMENT as never, scenario, config: DEFAULT_COHORT_CONFIG });
    expect(checkCohortBudget).toHaveBeenCalledTimes(2);
    expect(checkCohortBudget.mock.calls[0][0]).toMatchObject({ id: "cohort-1" });
  });

  it("stops the stage with a UsageLimit failure when the budget refuses, before any model call", async () => {
    checkCohortBudget.mockResolvedValue({ ok: false, message: "x", spendUsd: 3, limitUsd: 2, scope: "sandbox" });
    const result = await runAnalystStage("eng-1", DEFAULT_COHORT_CONFIG);
    expect(generateObject).not.toHaveBeenCalled();
    expect(result.failure?.errorClass).toBe("UsageLimit");
    expect(logEvent.mock.calls.find((c) => c[2] === "budget_refused")?.[3]).toMatchObject({ route: "agent" });
    expect(logEvent.mock.calls.some((c) => c[2] === ANALYST_FAILURE_EVENT)).toBe(true);
  });

  it("refuses a message once the engagement's message cap is spent, as the chat route does", async () => {
    sent = DEFAULT_COHORT_CONFIG.limits.maxLearnerMessages;
    generateObject.mockResolvedValue(message());
    const result = await runAnalystStep({ engagement: ENGAGEMENT as never, scenario, config: DEFAULT_COHORT_CONFIG });
    expect(result.status).toBe("rejected");
    expect(handleLearnerMessage).not.toHaveBeenCalled();
    expect(logEvent.mock.calls.find((c) => c[2] === "message_cap_reached")?.[3]).toMatchObject({ via: "agent", sent });
    expect(logEvent.mock.calls.find((c) => c[2] === "analyst_step_rejected")?.[3]).toMatchObject({
      reason: "message-cap-reached",
    });
    // With the cap spent, the analyst is told to submit.
    expect((generateObject.mock.calls[0][0] as { system: string }).system).toContain("MUST submit");
  });

  it("names the analyst model on stage events and steps", async () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("LLM_PERSONA_MODEL", "persona-x");
    vi.stubEnv("LLM_ANALYST_MODEL", "analyst-y");
    expect(analystStageEventDetail("modelling")).toMatchObject({
      stage: "modelling",
      model: "analyst-y",
      personaModel: "persona-x",
    });
    generateObject.mockResolvedValue(message());
    await runAnalystStep({ engagement: ENGAGEMENT as never, scenario, config: DEFAULT_COHORT_CONFIG });
    expect(logEvent.mock.calls.find((c) => c[2] === "analyst_step")?.[3]).toMatchObject({ model: "analyst-y" });
  });
});
