// A sandbox cohort has its own daily limit, counted over its own
// engagements, on top of the deployment's budget; a course cohort has only
// the global one. The refusal names the reset in the learner's local time,
// and the instructor's spend readout prices each run by its served model.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ db: {} }));

const { checkCohortBudget, recordedModels, readoutUsd, resetSpendCache, sandboxLimitUsd } = await import("@/lib/llm/budget");
const { budgetRefusalMessage, formatUsd, localBudgetRefusal, nextUtcMidnight } = await import("@/lib/llm/budget-format");
const { readoutPriceFor, PRICES } = await import("@/lib/llm/prices");
const { learnerMessageCap } = await import("@/lib/cohort/limits");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");

const MODELS = { persona: "claude-sonnet-5", judge: "claude-opus-4-8" };
// USD 2 at Sonnet 5 input prices.
const TWO_USD = { persona: { prompt: 1_000_000, completion: 0 }, judge: { prompt: 0, completion: 0 } };
const now = new Date("2026-09-29T12:00:00Z");

const sandbox = (dailyBudgetUsd: number | null = 2) => ({
  id: "sandbox",
  config: { sandbox: { openJoin: true, dailyBudgetUsd } },
});
const course = { id: "course", config: { sandbox: { openJoin: false, dailyBudgetUsd: 2 } } };

describe("per-cohort budget", () => {
  beforeEach(() => resetSpendCache());

  it("applies only to cohorts with open join", () => {
    expect(sandboxLimitUsd(sandbox())).toBe(2);
    expect(sandboxLimitUsd(sandbox(null))).toBeNull();
    expect(sandboxLimitUsd(course)).toBeNull();
  });

  it("refuses a sandbox cohort at its own limit while the global budget has room", async () => {
    const fetchCohortTotals = vi.fn(async () => [TWO_USD]);
    const fetchTotals = vi.fn(async () => TWO_USD);
    const result = await checkCohortBudget(sandbox(), {
      now, env: { NODE_ENV: "test", LLM_DAILY_BUDGET_USD: "5" }, models: () => MODELS, fetchCohortTotals, fetchTotals,
    });
    expect(result).toMatchObject({ ok: false, scope: "sandbox", limitUsd: 2 });
    expect(fetchCohortTotals).toHaveBeenCalledWith("sandbox", new Date("2026-09-29T00:00:00Z"));
  });

  it("never counts a course cohort against a sandbox limit", async () => {
    const fetchCohortTotals = vi.fn(async () => [TWO_USD]);
    const result = await checkCohortBudget(course, {
      now, env: { NODE_ENV: "test", LLM_DAILY_BUDGET_USD: "5" }, models: () => MODELS, fetchCohortTotals, fetchTotals: async () => TWO_USD,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchCohortTotals).not.toHaveBeenCalled();
  });

  it("still applies the global limit to a course cohort", async () => {
    const result = await checkCohortBudget(course, {
      now, env: { NODE_ENV: "test", LLM_DAILY_BUDGET_USD: "1" }, models: () => MODELS, fetchTotals: async () => TWO_USD,
    });
    expect(result).toMatchObject({ ok: false, scope: "global" });
  });
});

describe("refusal wording", () => {
  it("names the reset in the learner's own time and keeps the draft", () => {
    const body = { error: "daily-budget-exhausted", message: "x", resetsAtIso: nextUtcMidnight(now).toISOString() };
    expect(localBudgetRefusal("submit", body, "Asia/Singapore")).toBe(
      "The course's daily model budget is used up for everyone; this is not a limit on your account. Scoring resumes at 08:00 your time, and your draft is kept. Tell your instructor if this keeps happening.",
    );
    expect(localBudgetRefusal("chat", body, "Europe/London")).toBe(
      "The course's daily model budget is used up for everyone; this is not a limit on your account. Replies resume at 01:00 your time. Tell your instructor if this keeps happening.",
    );
    expect(localBudgetRefusal("chat", body, "Asia/Singapore", "sandbox")).toBe(
      "The demo's daily model budget is used up for everyone; this is not a limit on your seat. Replies resume at 08:00 your time.",
    );
  });

  it("falls back to the server's message for any other refusal", () => {
    expect(localBudgetRefusal("chat", { error: "message-limit", message: "You have used all 40 messages." })).toBe(
      "You have used all 40 messages.",
    );
  });

  it("is plain", () => {
    for (const k of ["chat", "submit", "agent"] as const) {
      expect(budgetRefusalMessage(k, null)).not.toMatch(/[—!]|demo/);
      expect(budgetRefusalMessage(k, null, "sandbox")).not.toMatch(/[—!]|instructor/);
    }
  });
});

describe("spend readout", () => {
  it("prices the mock at zero and a dated served id as its base model", () => {
    expect(readoutPriceFor("mock")).toEqual({ input: 0, output: 0 });
    expect(readoutPriceFor("claude-sonnet-5-20260901")).toEqual(PRICES["claude-sonnet-5"]);
    expect(readoutUsd(TWO_USD, { persona: "mock", judge: "mock" })).toBe(0);
  });

  it("has a price for the OpenAI default model", () => {
    expect(PRICES["gpt-4o-mini"]).toBeDefined();
  });

  it("takes each side's model from the events, served id first", () => {
    const models = recordedModels([
      { engagementId: "e1", type: "persona_turn", served: "claude-sonnet-5", configured: "mock", n: 3 },
      { engagementId: "e1", type: "submission_scored", served: null, configured: "claude-opus-4-8", n: 2 },
      { engagementId: "e2", type: "persona_turn", served: null, configured: "mock", n: 4 },
    ]);
    expect(models.get("e1")).toEqual({ persona: "claude-sonnet-5", judge: "claude-opus-4-8" });
    expect(models.get("e2")).toEqual({ persona: "mock" });
  });

  it("rounds to cents", () => {
    expect(formatUsd(0.4455)).toBe("USD 0.45");
    expect(formatUsd(0)).toBe("USD 0.00");
    expect(formatUsd(0.001)).toBe("under USD 0.01");
  });
});

describe("message cap for sandbox seats", () => {
  it("is the lower of the cohort cap and the sandbox cap for a sandbox seat only", () => {
    expect(learnerMessageCap(DEFAULT_COHORT_CONFIG, "sandbox")).toBe(40);
    expect(learnerMessageCap(DEFAULT_COHORT_CONFIG, "invite")).toBe(200);
    const low = { ...DEFAULT_COHORT_CONFIG, limits: { maxLearnerMessages: 10 } };
    expect(learnerMessageCap(low, "sandbox")).toBe(10);
  });
});

describe("persona model for runs recorded before the stamp", async () => {
  const { inferredPersonaModel } = await import("@/lib/llm/budget");
  it("follows the judge's provider, and says nothing for the mock", () => {
    expect(inferredPersonaModel("claude-opus-4-8")).toBe("claude-sonnet-5");
    expect(inferredPersonaModel("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(inferredPersonaModel("mock")).toBeNull();
    expect(inferredPersonaModel(undefined)).toBeNull();
  });
});
