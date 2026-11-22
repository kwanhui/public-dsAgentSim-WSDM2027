// The persona turn is one generateObject call, and a transient provider or
// schema failure on it used to reach the learner as a bare 502. One flaky
// turn in a session is the difference between "works" and "worked when I
// tried it". The orchestrator now retries once after a short pause, the same
// treatment the client reaction call got in stage-gate.ts. The truthful
// failure contract still holds: nothing is persisted until a turn succeeds,
// and a second failure still comes back from the route as 502 with an empty
// transcript, so the learner can resend without doubling anything up.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const appendMessage = vi.fn();
const appendWorldFacts = vi.fn(async (..._args: unknown[]) => {});
const logEvent = vi.fn(async (..._args: unknown[]) => {});
let learnerCount = 0;

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

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
}));
vi.mock("@/lib/agents/consistency", () => ({
  shouldAuditTurn: () => false,
  auditPersonaTurn: async () => {},
}));
vi.mock("@/lib/agents/data-environment", () => ({
  releasableDatasets: () => [],
  recordDataReleases: async () => [],
}));
vi.mock("@/lib/agents/dataset-profile", () => ({
  profileReleasedDatasets: async () => [],
  releaseWorldFact: () => "",
}));
vi.mock("@/lib/engagement/state", () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  appendWorldFacts: (...a: unknown[]) => appendWorldFacts(...a),
  getChannel: async () => CHANNEL,
  countLearnerMessages: async () => learnerCount,
  getMessages: async () => [],
  getLedger: async () => [],
  logEvent: (...a: unknown[]) => logEvent(...a),
}));
vi.mock("@/lib/llm/budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/budget")>()),
  checkDailyBudget: async () => ({ ok: true }),
  checkCohortBudget: async () => ({ ok: true }),
}));
vi.mock("@/lib/db/client", async () => {
  const { createElicitationDbStub } = await import("./support/elicitation-db-stub");
  return { db: createElicitationDbStub().db };
});
vi.mock("@/lib/engagement/request", () => ({
  resolveLearnerContext: async () => ({
    ok: true,
    ctx: {
      cohort: { config: DEFAULT_COHORT_CONFIG },
      engagement: ENGAGEMENT,
      scenario,
    },
  }),
}));

const { handleLearnerMessage, PERSONA_RETRY_DELAY_MS } = await import("@/lib/agents/orchestrator");
const { POST } = await import("@/app/api/chat/route");
const { loadScenario } = await import("@/lib/scenarios/load");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");

const scenario = await loadScenario("customer-churn");

const TURN = {
  reply: "Happy to walk you through the churn numbers.",
  newFacts: [],
  releaseDatasets: [],
};

const PROVIDER_ERROR = Object.assign(new Error("Overloaded: please retry."), {
  name: "AI_APICallError",
});

let savedId = 0;
function sendMessage() {
  return handleLearnerMessage({
    engagement: ENGAGEMENT as never,
    channel: CHANNEL as never,
    scenario,
    config: DEFAULT_COHORT_CONFIG,
    text: "What does churn look like this quarter?",
  });
}

describe("persona turn retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    generateObject.mockReset();
    appendMessage.mockReset();
    savedId = 0;
    appendMessage.mockImplementation(async (row: { sender: string; content: string }) => ({
      id: ++savedId,
      sender: row.sender,
      content: row.content,
      timestampIso: "2026-08-25T09:05:00Z",
    }));
    appendWorldFacts.mockClear();
    logEvent.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once after a pause and delivers the turn when the retry succeeds", async () => {
    generateObject
      .mockRejectedValueOnce(PROVIDER_ERROR)
      .mockResolvedValueOnce({ object: TURN, usage: { promptTokens: 10, completionTokens: 5 } });

    const pending = sendMessage();
    await vi.advanceTimersByTimeAsync(PERSONA_RETRY_DELAY_MS);
    const reply = await pending;

    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(reply.message.content).toBe(TURN.reply);
    // Both sides of the exchange reached the transcript, learner first.
    expect(appendMessage).toHaveBeenCalledTimes(2);
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ sender: "learner" });
    expect(appendMessage.mock.calls[1][0]).toMatchObject({ sender: "client" });
  });

  it("stamps the persona model and the served model on the persona_turn event", async () => {
    generateObject.mockResolvedValueOnce({
      object: TURN,
      usage: { promptTokens: 10, completionTokens: 5 },
      response: { modelId: "served-model-id" },
    });
    await sendMessage();
    const turnEvent = logEvent.mock.calls.find((c) => c[2] === "persona_turn");
    expect(turnEvent?.[3]).toMatchObject({ model: expect.any(String), servedModel: "served-model-id" });
    expect((turnEvent?.[3] as { model: string }).model.length).toBeGreaterThan(0);
  });

  it("persists nothing before the first attempt has failed and the retry succeeded", async () => {
    generateObject.mockImplementationOnce(async () => {
      // The first attempt is still the only one taken, and nothing may have
      // touched the transcript yet.
      expect(appendMessage).not.toHaveBeenCalled();
      throw PROVIDER_ERROR;
    });
    generateObject.mockResolvedValueOnce({ object: TURN, usage: undefined });

    const pending = sendMessage();
    await vi.advanceTimersByTimeAsync(PERSONA_RETRY_DELAY_MS);
    await pending;

    expect(appendMessage).toHaveBeenCalledTimes(2);
  });

  it("returns 502 from the route with nothing persisted when the retry also fails", async () => {
    generateObject.mockRejectedValue(PROVIDER_ERROR);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: CHANNEL.id, message: "Anyone there?" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(PERSONA_RETRY_DELAY_MS);
    const res = await pending;

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "persona-unavailable", messagesRemaining: 200 });
    // One attempt plus its one retry, and the truthful-failure contract
    // holds: neither the question nor a reply reached the transcript.
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(appendMessage).not.toHaveBeenCalled();
    expect(appendWorldFacts).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// Failed calls are metered and logged, and
// the learner sees how many messages remain.
describe("failed persona calls and the message cap", () => {
  const schemaFailure = (promptTokens: number, completionTokens: number) =>
    Object.assign(new Error("No object generated: response did not match schema."), {
      name: "AI_NoObjectGeneratedError",
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    });

  const post = (message = "Anyone there?") =>
    POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: CHANNEL.id, message }),
      }),
    );

  beforeEach(() => {
    vi.useFakeTimers();
    generateObject.mockReset();
    appendMessage.mockReset();
    appendMessage.mockImplementation(async (row: { sender: string; content: string }) => ({
      id: 1,
      sender: row.sender,
      content: row.content,
      timestampIso: "2026-08-25T09:05:00Z",
    }));
    logEvent.mockClear();
    learnerCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const failedEvents = () => logEvent.mock.calls.filter((c) => c[2] === "persona_failed").map((c) => c[3]);

  it("logs a recovered persona_failed with the failed attempt's tokens", async () => {
    generateObject
      .mockRejectedValueOnce(schemaFailure(1200, 900))
      .mockResolvedValueOnce({ object: TURN, usage: { promptTokens: 10, completionTokens: 5 } });
    const pending = sendMessage();
    await vi.advanceTimersByTimeAsync(PERSONA_RETRY_DELAY_MS);
    await pending;
    expect(failedEvents()).toEqual([
      expect.objectContaining({
        kind: "turn",
        recovered: true,
        attempts: 1,
        errorClass: "AI_NoObjectGeneratedError",
        promptTokens: 1200,
        completionTokens: 900,
      }),
    ]);
  });

  it("logs an unrecovered persona_failed with both attempts' tokens, and the route answers 502", async () => {
    generateObject.mockRejectedValueOnce(schemaFailure(1000, 800)).mockRejectedValueOnce(schemaFailure(1100, 850));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = post();
    await vi.advanceTimersByTimeAsync(PERSONA_RETRY_DELAY_MS);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(failedEvents()).toEqual([
      expect.objectContaining({ recovered: false, attempts: 2, promptTokens: 2100, completionTokens: 1650 }),
    ]);
    consoleError.mockRestore();
  });

  it("logs no persona_failed when the first attempt succeeds", async () => {
    generateObject.mockResolvedValueOnce({ object: TURN, usage: { promptTokens: 10, completionTokens: 5 } });
    await sendMessage();
    expect(failedEvents()).toEqual([]);
  });

  it("returns the messages left after a stored turn", async () => {
    learnerCount = 10;
    generateObject.mockResolvedValueOnce({ object: TURN, usage: { promptTokens: 10, completionTokens: 5 } });
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).messagesRemaining).toBe(DEFAULT_COHORT_CONFIG.limits.maxLearnerMessages - 11);
  });

  it("logs message_cap_reached and answers 429 with none left at the cap", async () => {
    learnerCount = DEFAULT_COHORT_CONFIG.limits.maxLearnerMessages;
    const res = await post();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "message-limit", messagesRemaining: 0 });
    expect(generateObject).not.toHaveBeenCalled();
    const cap = logEvent.mock.calls.find((c) => c[2] === "message_cap_reached");
    expect(cap?.[3]).toMatchObject({ cap: 200, sent: 200, personaId: "client" });
  });
});
