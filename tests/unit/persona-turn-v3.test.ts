// A chat turn under persona-v3: the style check rewrites a reply
// once and logs persona_style_retry; an over-long reply is cut rather than
// failing validation; a revealed withheld fact is logged as fact_elicited
// with the learner-message count.

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const appendMessage = vi.fn();
const logEvent = vi.fn(async (..._args: unknown[]) => {});

const ENGAGEMENT = {
  id: "eng-1",
  cohortId: "cohort-1",
  studentId: "student-1",
  scenarioId: "customer-churn",
  currentStage: "data-collection",
  status: "active",
  mode: "learner",
  createdAt: new Date("2026-08-25T09:00:00Z"),
  completedAt: null,
};

const CHANNEL = {
  id: "chan-2",
  engagementId: "eng-1",
  personaId: "data-owner",
  unlockedAt: new Date("2026-08-25T09:00:00Z"),
  createdAt: new Date("2026-08-25T09:00:00Z"),
};

const HISTORY = [
  { id: 1, sender: "learner", content: "Hello Marcus.", timestampIso: "t" },
  { id: 2, sender: "data-owner", content: "Hello.", timestampIso: "t" },
];

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
}));
vi.mock("@/lib/agents/consistency", () => ({ shouldAuditTurn: () => false, auditPersonaTurn: async () => {} }));
vi.mock("@/lib/agents/data-environment", () => ({ releasableDatasets: () => [], recordDataReleases: async () => [] }));
vi.mock("@/lib/agents/dataset-profile", () => ({ profileReleasedDatasets: async () => [], releaseWorldFact: () => "" }));
vi.mock("@/lib/db/client", async () => {
  const { createElicitationDbStub } = await import("./support/elicitation-db-stub");
  return { db: createElicitationDbStub().db };
});
vi.mock("@/lib/engagement/state", () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  appendWorldFacts: async () => {},
  countLearnerMessages: async () => 5,
  getEvents: async () => [],
  getMessages: async () => HISTORY,
  getLedger: async () => [],
  logEvent: (...a: unknown[]) => logEvent(...a),
}));

const { handleLearnerMessage, PERSONA_RETRY_DELAY_MS } = await import("@/lib/agents/orchestrator");
const { resetElicitationDbStubs } = await import("./support/elicitation-db-stub");
const { loadScenario } = await import("@/lib/scenarios/load");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");
const scenario = await loadScenario("customer-churn");

function turn(reply: string, revealedWithheld: string[] = []) {
  return {
    object: { reply, newFacts: [], revealedWithheld, releaseDatasets: [] },
    usage: { promptTokens: 10, completionTokens: 4 },
  };
}

function send(text = "Can a subscriber appear twice? I see duplicate rows.") {
  return handleLearnerMessage({
    engagement: ENGAGEMENT as never,
    channel: CHANNEL as never,
    scenario,
    config: DEFAULT_COHORT_CONFIG,
    text,
  });
}

describe("persona-v3 chat turn", () => {
  beforeEach(() => {
    generateObject.mockReset();
    logEvent.mockClear();
    resetElicitationDbStubs();
    let id = 10;
    appendMessage.mockReset().mockImplementation(async (row: { sender: string; content: string }) => ({
      id: ++id,
      sender: row.sender,
      content: row.content,
      timestampIso: "t",
    }));
    expect(PERSONA_RETRY_DELAY_MS).toBeGreaterThan(0);
  });

  it("keeps a clean reply and logs no style retry", async () => {
    generateObject.mockResolvedValue(turn("Yes. Plan changes mid-month create a second row."));
    const out = await send();
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(out.message.content).toBe("Yes. Plan changes mid-month create a second row.");
    expect(logEvent.mock.calls.find((c) => c[2] === "persona_style_retry")).toBeUndefined();
  });

  it("rewrites once on a banned pattern, keeps the rewrite, and meters both calls", async () => {
    generateObject
      .mockResolvedValueOnce(turn("Good catch, that's exactly the plan-change quirk."))
      .mockResolvedValueOnce(turn("Yes. Plan changes mid-month create a second row."));
    const out = await send();
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect((generateObject.mock.calls[1][0] as { system: string }).system).toContain("# Rewrite your last draft");
    expect(out.message.content).toBe("Yes. Plan changes mid-month create a second row.");
    expect(appendMessage.mock.calls[1][0]).toMatchObject({ promptTokens: 20, completionTokens: 8 });
    const retry = logEvent.mock.calls.find((c) => c[2] === "persona_style_retry");
    expect(retry?.[3]).toMatchObject({
      personaId: "data-owner",
      kind: "turn",
      patterns: ["verdict-opener", "exactly", "comma-splice"],
      resolved: true,
      promptVersion: "persona-v8",
    });
    const personaTurn = logEvent.mock.calls.find((c) => c[2] === "persona_turn");
    expect(personaTurn?.[3]).toMatchObject({ styleRetry: true, promptVersion: "persona-v8" });
  });

  it("compares the reply with the persona's earlier replies and rewrites a repeated refusal (persona-v7)", async () => {
    HISTORY.push(
      { id: 3, sender: "learner", content: "Should I drop the blank total_charges rows?", timestampIso: "t" },
      { id: 4, sender: "data-owner", content: "That choice is yours to make.", timestampIso: "t" },
    );
    try {
      generateObject
        .mockResolvedValueOnce(turn("Those are your cleaning decisions to make."))
        .mockResolvedValueOnce(turn("Blank means the subscriber joined in the extract month."));
      const out = await send("And the tenure 0 rows?");
      expect(generateObject).toHaveBeenCalledTimes(2);
      expect(out.message.content).toBe("Blank means the subscriber joined in the extract month.");
      const retry = logEvent.mock.calls.find((c) => c[2] === "persona_style_retry");
      expect(retry?.[3]).toMatchObject({ patterns: ["repeat-refusal"], resolved: true });
    } finally {
      HISTORY.splice(2);
    }
  });

  it("keeps the data owner from volunteering the undocumented defect (persona-v7)", async () => {
    generateObject
      .mockResolvedValueOnce(
        turn("That states purpose and fields clearly. The extract is not guaranteed one row per subscriber."),
      )
      .mockResolvedValueOnce(turn("Noted on purpose and fields."));
    const out = await send("I need subscriber_id, tenure, usage and churn, one row per subscriber, to rank retention targets.");
    expect(out.message.content).toBe("Noted on purpose and fields.");
    expect(logEvent.mock.calls.find((c) => c[2] === "withheld_leak_blocked")?.[3]).toMatchObject({
      factId: "duplicate-rows",
      personaId: "data-owner",
      regenerated: true,
      removed: false,
    });
  });

  it("keeps the draft when the rewrite call fails", async () => {
    generateObject
      .mockResolvedValueOnce(turn("Go ahead and dedupe it."))
      .mockRejectedValue(new Error("down"));
    vi.useFakeTimers();
    const pending = send();
    await vi.advanceTimersByTimeAsync(PERSONA_RETRY_DELAY_MS + 10);
    const out = await pending;
    vi.useRealTimers();
    expect(out.message.content).toBe("Go ahead and dedupe it.");
    const retry = logEvent.mock.calls.find((c) => c[2] === "persona_style_retry");
    expect(retry?.[3]).toMatchObject({ patterns: ["go-ahead", "method-words"], patternsAfterRetry: null, resolved: false });
  });

  it("passes a repair hook so an over-long reply is cut, then asks for a shorter one", async () => {
    generateObject.mockImplementation(async (args: { experimental_repairText?: (i: { text: string }) => Promise<string | null> }) => {
      // Simulate the SDK: validation fails on length, the hook repairs it.
      const long = JSON.stringify({ reply: "A plain sentence. ".repeat(40), newFacts: [], revealedWithheld: [], releaseDatasets: [] });
      const repaired = await args.experimental_repairText!({ text: long });
      return { object: JSON.parse(repaired!), usage: { promptTokens: 1, completionTokens: 1 } };
    });
    const out = await send();
    expect(out.message.content.length).toBeLessThanOrEqual(450);
    const retry = logEvent.mock.calls.find((c) => c[2] === "persona_style_retry");
    expect(retry?.[3]).toMatchObject({ patterns: ["too-long"] });
  });

  it("logs fact_elicited for a revealed withheld fact, with the learner-message count", async () => {
    generateObject.mockResolvedValue(turn("Yes. Plan changes mid-month create a second row.", ["duplicate-rows", "offer-cost"]));
    await send();
    const elicited = logEvent.mock.calls.filter((c) => c[2] === "fact_elicited");
    // offer-cost belongs to the client sponsor, so only the data owner's own
    // fact is recorded.
    expect(elicited.map((c) => c[3])).toEqual([
      {
        factId: "duplicate-rows",
        persona: "data-owner",
        turnIndex: 2,
        learnerMessagesSoFar: 5,
        verified: true,
        matchedKey: "plan change",
        detection: "reported",
      },
    ]);
    const personaTurn = logEvent.mock.calls.find((c) => c[2] === "persona_turn");
    expect(personaTurn?.[3]).toMatchObject({ revealedWithheld: ["duplicate-rows"] });
  });
});
