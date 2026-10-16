// Guaranteed consistency telemetry. The paper's claim
// of ledger-kept persona consistency rests on persona_consistency events,
// but a purely sampled audit at the default 0.25 rate could leave a short
// run with zero of them. Each persona's first two turns per engagement are
// now always audited regardless of the rate; the sampled rate applies only
// after that.

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const auditPersonaTurn = vi.fn(async (..._args: unknown[]) => {});
const appendMessage = vi.fn();
const logEvent = vi.fn(async (..._args: unknown[]) => {});

const ENGAGEMENT = {
  id: "eng-1",
  cohortId: "cohort-1",
  studentId: "student-1",
  scenarioId: "customer-churn",
  currentStage: "formulation",
  status: "active",
  mode: "learner",
  createdAt: new Date("2026-08-25T09:00:00Z"),
  completedAt: null,
};

const CHANNEL = {
  id: "chan-1",
  engagementId: "eng-1",
  personaId: "client",
  unlockedAt: new Date("2026-08-25T09:00:00Z"),
  createdAt: new Date("2026-08-25T09:00:00Z"),
};

// Channel history handed to the orchestrator; tests set this per case.
let history: Array<{ id: number; sender: string; content: string; timestampIso: string }> = [];

function personaTurns(count: number) {
  const rows: typeof history = [];
  for (let i = 0; i < count; i++) {
    rows.push(
      {
        id: rows.length + 1,
        sender: "learner",
        content: `question ${i + 1}`,
        timestampIso: "2026-08-25T09:00:00Z",
      },
      {
        id: rows.length + 2,
        sender: "client",
        content: `answer ${i + 1}`,
        timestampIso: "2026-08-25T09:01:00Z",
      },
    );
  }
  return rows;
}

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
  RUBRIC_TEMPERATURE: 0,
}));
// Keep the real decision logic (shouldAuditTurn) but spy on the audit call
// itself, so these tests exercise the orchestrator's actual wiring.
vi.mock("@/lib/agents/consistency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/consistency")>();
  return { ...actual, auditPersonaTurn: (...a: unknown[]) => auditPersonaTurn(...a) };
});
vi.mock("@/lib/agents/data-environment", () => ({
  releasableDatasets: () => [],
  recordDataReleases: async () => [],
}));
vi.mock("@/lib/agents/dataset-profile", () => ({
  profileReleasedDatasets: async () => [],
  releaseWorldFact: () => "",
}));
vi.mock("@/lib/db/client", async () => {
  const { createElicitationDbStub } = await import("./support/elicitation-db-stub");
  return { db: createElicitationDbStub().db };
});
vi.mock("@/lib/engagement/state", () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  appendWorldFacts: async () => {},
  getMessages: async () => history,
  getLedger: async () => [],
  logEvent: (...a: unknown[]) => logEvent(...a),
}));

const { handleLearnerMessage } = await import("@/lib/agents/orchestrator");
const { GUARANTEED_AUDIT_TURNS, shouldAuditTurn } = await import("@/lib/agents/consistency");
const { loadScenario } = await import("@/lib/scenarios/load");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");

const scenario = await loadScenario("customer-churn");

function configWithRate(rate: number) {
  return {
    ...DEFAULT_COHORT_CONFIG,
    research: { ...DEFAULT_COHORT_CONFIG.research, consistencyAuditRate: rate },
  };
}

function sendMessage(rate: number) {
  return handleLearnerMessage({
    engagement: ENGAGEMENT as never,
    channel: CHANNEL as never,
    scenario,
    config: configWithRate(rate),
    text: "What does churn look like this quarter?",
  });
}

describe("shouldAuditTurn", () => {
  it("always audits each persona's first two turns, even at rate 0", () => {
    for (let prior = 0; prior < GUARANTEED_AUDIT_TURNS; prior++) {
      expect(shouldAuditTurn({ rate: 0, priorPersonaTurns: prior, roll: 0.99 })).toBe(true);
    }
  });

  it("applies the sampled rate once the guaranteed turns are spent", () => {
    expect(shouldAuditTurn({ rate: 0, priorPersonaTurns: 2, roll: 0.0 })).toBe(false);
    expect(shouldAuditTurn({ rate: 1, priorPersonaTurns: 2, roll: 0.99 })).toBe(true);
    // A 0.25 rate audits rolls under the rate and skips rolls over it.
    expect(shouldAuditTurn({ rate: 0.25, priorPersonaTurns: 5, roll: 0.1 })).toBe(true);
    expect(shouldAuditTurn({ rate: 0.25, priorPersonaTurns: 5, roll: 0.9 })).toBe(false);
  });
});

describe("orchestrator audit wiring", () => {
  beforeEach(() => {
    generateObject.mockReset();
    auditPersonaTurn.mockClear();
    appendMessage.mockReset();
    let savedId = 0;
    appendMessage.mockImplementation(async (row: { sender: string; content: string }) => ({
      id: ++savedId,
      sender: row.sender,
      content: row.content,
      timestampIso: "2026-08-25T09:05:00Z",
    }));
    generateObject.mockResolvedValue({
      object: { reply: "Churn is up this quarter.", newFacts: [], releaseDatasets: [] },
      usage: { promptTokens: 10, completionTokens: 5 },
    });
  });

  it("audits the persona's first and second turns even at rate 0", async () => {
    history = personaTurns(0);
    await sendMessage(0);
    expect(auditPersonaTurn).toHaveBeenCalledTimes(1);

    history = personaTurns(1);
    await sendMessage(0);
    expect(auditPersonaTurn).toHaveBeenCalledTimes(2);
  });

  it("stops auditing after the guaranteed turns when the rate is 0", async () => {
    history = personaTurns(2);
    await sendMessage(0);
    expect(auditPersonaTurn).not.toHaveBeenCalled();
  });

  it("keeps applying the sampled rate after the guaranteed turns", async () => {
    history = personaTurns(5);
    await sendMessage(1);
    expect(auditPersonaTurn).toHaveBeenCalledTimes(1);
  });

  it("counts only this persona's turns toward the guarantee, not the learner's", async () => {
    // Five learner messages but no persona reply yet: still the persona's
    // first turn, so the guarantee applies.
    history = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      sender: "learner",
      content: `unanswered ${i + 1}`,
      timestampIso: "2026-08-25T09:00:00Z",
    }));
    await sendMessage(0);
    expect(auditPersonaTurn).toHaveBeenCalledTimes(1);
  });

  it("stamps the persona prompt version on the persona_turn event", async () => {
    history = personaTurns(3);
    logEvent.mockClear();
    await sendMessage(0);
    const turn = logEvent.mock.calls.find((c) => c[2] === "persona_turn");
    expect(turn?.[3]).toMatchObject({ promptVersion: "persona-v8", personaId: "client" });
  });
});
