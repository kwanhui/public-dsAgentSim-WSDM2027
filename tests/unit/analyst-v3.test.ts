// analyst-v3: a retry after a failed gate sees the agent's own previous
// artifact for the stage and the feedback a learner sees, because blind
// retries produced near-identical data-audit memos; and the grounding rule
// covers chat messages, because an agent told a persona that a sample had
// been prepared and wrote of a trial that nobody agreed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const logEvent = vi.fn(async (..._args: unknown[]) => {});
let submissionRows: unknown[] = [];
let scoreRows: unknown[] = [];

const ENGAGEMENT = {
  id: "eng-1",
  cohortId: "cohort-1",
  studentId: "student-1",
  scenarioId: "customer-churn",
  currentStage: "data-collection",
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
  budgetRefusedDetail: () => ({}),
  checkCohortBudget: async () => ({ ok: true }),
}));
vi.mock("@/lib/engagement/state", () => ({
  getEngagement: async () => ({ ...ENGAGEMENT }),
  getChannels: async () => [
    { id: "chan-1", engagementId: "eng-1", personaId: "client", unlockedAt: new Date(), createdAt: new Date() },
  ],
  getMessages: async () => [],
  getEvents: async () => [],
  getSubmissions: async () => submissionRows,
  getRubricScores: async () => scoreRows,
  countLearnerMessages: async () => 0,
  createEngagement: async () => ({ ...ENGAGEMENT }),
  logEvent: (...args: unknown[]) => logEvent(...args),
}));
vi.mock("@/lib/agents/data-environment", () => ({ getReleasedFiles: async () => [] }));
vi.mock("@/lib/agents/dataset-profile", () => ({
  profileReleasedDatasets: async () => [],
  renderReleasedProfiles: () => "",
}));
vi.mock("@/lib/agents/orchestrator", () => ({ handleLearnerMessage: async () => {} }));
vi.mock("@/lib/agents/stage-gate", () => ({
  handleGateSubmission: async () => ({ advanced: false, engagementCompleted: false }),
}));

const { buildAnalystSystemPrompt, latestFailedAttempt, renderPreviousAttempt, runAnalystStep, ANALYST_PROMPT_VERSION } =
  await import("@/lib/agents/analyst");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");
const { loadScenario } = await import("@/lib/scenarios/load");
const scenario = await loadScenario("customer-churn");
const stage = scenario.stages.find((s) => s.id === "data-collection")!;
const [first, second] = stage.gate.rubric;

const MEMO = "Data audit memo. The extract has 8170 rows. Not run: any check of the duplicate rows.";

function failedSubmission(id: string, text: string, createdAt: string) {
  return { id, stage: "data-collection", status: "scored", contentText: text, gatePassed: false, createdAt };
}

function score(submissionId: string, criterionId: string, s: number, max: number, extra: Record<string, unknown> = {}) {
  return {
    submissionId,
    criterionId,
    score: s,
    maxScore: max,
    rationale: "Full rationale for the instructor.",
    learnerRationale: "Two risks are listed without a count from the file.",
    improve: "Give a count from the file for each risk in your second paragraph.",
    overrideScore: null,
    ...extra,
  };
}

describe("analyst-v3 retry view", () => {
  beforeEach(() => {
    generateObject.mockReset();
    submissionRows = [];
    scoreRows = [];
  });

  it("is the current analyst version", () => {
    expect(ANALYST_PROMPT_VERSION).toBe("analyst-v3");
  });

  it("has no retry section before any failed attempt", () => {
    const system = buildAnalystSystemPrompt({
      scenario,
      stageId: "data-collection",
      channels: [{ personaId: "client", unlocked: true }],
      transcripts: [],
      profilesText: "",
      turnsUsed: 0,
    });
    expect(system).not.toContain("# Your last attempt at this gate");
    expect(system).not.toMatch(/«[^»]+»/);
    expect(system).not.toMatch(/\n{3,}/);
  });

  it("gives a retry the latest failed artifact and the learner's feedback", () => {
    const attempt = latestFailedAttempt({
      stageId: "data-collection",
      submissions: [failedSubmission("s1", "An older memo.", "1"), failedSubmission("s2", MEMO, "2")],
      scores: [score("s1", first.id, 1, first.maxScore), score("s2", first.id, 2, first.maxScore), score("s2", second.id, second.maxScore, second.maxScore)],
      showScores: true,
    });
    expect(attempt?.text).toBe(MEMO);
    const section = renderPreviousAttempt(scenario, "data-collection", attempt);
    expect(section).toContain("# Your last attempt at this gate");
    expect(section).toContain(MEMO);
    expect(section).not.toContain("An older memo.");
    expect(section).toContain(`Score: ${2 + second.maxScore} of ${first.maxScore + second.maxScore}.`);
    // The learner's copy of the rationale, never the instructor's.
    expect(section).toContain("Two risks are listed without a count from the file.");
    expect(section).not.toContain("Full rationale for the instructor.");
    expect(section).toContain(`${first.learnerText.trim()} 2 of ${first.maxScore}.`);
    expect(section).toContain("To improve: Give a count from the file for each risk in your second paragraph.");
    // No improve line on full marks.
    expect(section.split("\n").find((l) => l.includes(`${second.maxScore} of ${second.maxScore}.`))).not.toContain("To improve");
    expect(section).toContain("Do not submit the same text again.");
  });

  it("uses an instructor's override as the standing score", () => {
    const attempt = latestFailedAttempt({
      stageId: "data-collection",
      submissions: [failedSubmission("s1", MEMO, "1")],
      scores: [score("s1", first.id, 2, first.maxScore, { overrideScore: 3 })],
      showScores: true,
    });
    expect(attempt?.scores?.[0].score).toBe(3);
  });

  it("shows no scores when the cohort hides them from learners", () => {
    const attempt = latestFailedAttempt({
      stageId: "data-collection",
      submissions: [failedSubmission("s1", MEMO, "1")],
      scores: [score("s1", first.id, 2, first.maxScore)],
      showScores: false,
    });
    const section = renderPreviousAttempt(scenario, "data-collection", attempt);
    expect(section).toContain("The assessor's scores are not shown in this cohort.");
    expect(section).not.toContain("Two risks are listed");
    expect(section).toContain(MEMO);
  });

  it("ignores attempts at other stages and unscored attempts", () => {
    expect(
      latestFailedAttempt({
        stageId: "data-collection",
        submissions: [
          { ...failedSubmission("s1", MEMO, "1"), stage: "formulation" },
          { ...failedSubmission("s2", MEMO, "2"), status: "failed" },
        ],
        scores: [],
        showScores: true,
      }),
    ).toBeNull();
  });

  it("reaches the analyst's system prompt on a retry step", async () => {
    submissionRows = [failedSubmission("s1", MEMO, "1")];
    scoreRows = [score("s1", first.id, 2, first.maxScore)];
    generateObject.mockResolvedValue({
      object: { reasoning: "revise", action: "submit", channelPersonaId: null, text: "Revised memo." },
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    await runAnalystStep({ engagement: ENGAGEMENT as never, scenario, config: DEFAULT_COHORT_CONFIG });
    const system = (generateObject.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain("# Your last attempt at this gate");
    expect(system).toContain(MEMO);
    expect(system).toContain("To improve: Give a count from the file");
  });
});

describe("analyst-v3 grounding rule for messages", () => {
  it("forbids claiming work, a sample or an agreement that no artifact or transcript shows", () => {
    const system = buildAnalystSystemPrompt({
      scenario,
      stageId: "testing",
      channels: [{ personaId: "end-user", unlocked: true }],
      transcripts: [],
      profilesText: "",
      turnsUsed: 0,
    });
    expect(system).toContain(
      "In messages as well as artifacts, never say that work has been done, that a sample, a list or a file has been sent or shown, or that a pilot, a format or a decision has been agreed, unless an artifact you submitted or a conversation above shows it.",
    );
    expect(system).toContain("- Messages: plain workplace chat, 1 to 4 sentences, one clear ask.");
    expect(system).not.toContain("—");
  });
});
