// The learner routes that call a model refuse before calling it once the
// daily budget is spent (429 with the plain message), and chat also refuses
// past the cohort's per-engagement message cap.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COHORT_CONFIG } from "@/lib/cohort/defaults";

const handleLearnerMessage = vi.fn(async () => ({ ok: true }));
const handleGateSubmission = vi.fn();
const budget = vi.fn(async () => ({ ok: true }) as { ok: boolean; message?: string });
let learnerMessages = 0;
let config = DEFAULT_COHORT_CONFIG;

vi.mock("@/lib/engagement/request", () => ({
  resolveLearnerContext: async () => ({
    ok: true,
    ctx: {
      cohort: { config },
      engagement: { id: "e1", cohortId: "c1", status: "active" },
      scenario: {},
    },
  }),
}));
vi.mock("@/lib/engagement/state", () => ({
  getChannel: async () => ({ id: "ch1", engagementId: "e1", unlockedAt: new Date() }),
  getMessages: async () => [],
  countLearnerMessages: async () => learnerMessages,
  logEvent: (...a: unknown[]) => logEvent(...a),
}));
const logEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/agents/orchestrator", () => ({
  handleLearnerMessage: (...a: unknown[]) => handleLearnerMessage(...(a as [])),
}));
vi.mock("@/lib/agents/stage-gate", () => ({
  handleGateSubmission: (...a: unknown[]) => handleGateSubmission(...(a as [])),
}));
vi.mock("@/lib/llm/budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/budget")>();
  return { ...actual, checkDailyBudget: () => budget(), checkCohortBudget: () => budget() };
});
vi.mock("@/lib/db/client", () => ({ db: {} }));

const { POST: chat } = await import("@/app/api/chat/route");
const { POST: submit } = await import("@/app/api/engagement/submit/route");
const { BUDGET_MESSAGE } = await import("@/lib/llm/budget");

const chatRequest = () =>
  new Request("http://x/api/chat", {
    method: "POST",
    body: JSON.stringify({ channelId: "ch1", message: "hello" }),
  });

beforeEach(() => {
  handleLearnerMessage.mockClear();
  handleGateSubmission.mockClear();
  budget.mockImplementation(async () => ({ ok: true }));
  learnerMessages = 0;
  config = DEFAULT_COHORT_CONFIG;
});

describe("daily budget", () => {
  beforeEach(() => {
    budget.mockImplementation(async () => ({ ok: false, message: BUDGET_MESSAGE }));
  });

  it("stops a chat turn with 429 before the persona is called", async () => {
    const res = await chat(chatRequest());
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ message: BUDGET_MESSAGE });
    expect(handleLearnerMessage).not.toHaveBeenCalled();
  });

  it("stops a gate submission with 429 before the judge is called", async () => {
    const res = await submit(
      new Request("http://x", { method: "POST", body: JSON.stringify({ text: "x".repeat(60) }) }),
    );
    expect(res.status).toBe(429);
    expect(handleGateSubmission).not.toHaveBeenCalled();
  });
});

describe("per-engagement message cap", () => {
  it("lets a message through below the cap", async () => {
    learnerMessages = 199;
    const res = await chat(chatRequest());
    expect(res.status).toBe(200);
    expect(handleLearnerMessage).toHaveBeenCalledOnce();
  });

  it("refuses at the cap with 429 and says why", async () => {
    learnerMessages = 200;
    const res = await chat(chatRequest());
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "message-limit", messagesRemaining: 0 });
    expect(handleLearnerMessage).not.toHaveBeenCalled();
    expect(logEvent.mock.calls.at(-1)?.[2]).toBe("message_cap_reached");
  });

  it("follows the cohort's own cap", async () => {
    config = { ...DEFAULT_COHORT_CONFIG, limits: { maxLearnerMessages: 5 } };
    learnerMessages = 5;
    expect((await chat(chatRequest())).status).toBe(429);
  });
});
