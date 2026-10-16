import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ db: {} }));

const {
  BUDGET_MESSAGE,
  SPEND_CACHE_MS,
  checkDailyBudget,
  dailyBudgetUsd,
  resetSpendCache,
  spendUsd,
  todaysSpendUsd,
  totalsFromRows,
  utcDayStart,
  budgetExceededResponse,
} = await import("@/lib/llm/budget");
const { PRICES, guardPriceFor, priceFor, readoutPriceFor, isMockModel } = await import("@/lib/llm/prices");

const base: NodeJS.ProcessEnv = { NODE_ENV: "test" };
const MODELS = { persona: "claude-sonnet-5", judge: "claude-opus-4-8" };
// USD for ONE_MILLION: 1M Sonnet input tokens plus 1M Opus output tokens,
// read from the price table so a price change does not break the tests.
const ONE_MILLION_USD = PRICES["claude-sonnet-5"].input + PRICES["claude-opus-4-8"].output;
const ONE_MILLION = {
  persona: { prompt: 1_000_000, completion: 0 },
  judge: { prompt: 0, completion: 1_000_000 },
};

describe("dailyBudgetUsd", () => {
  it("is unlimited when unset or blank", () => {
    expect(dailyBudgetUsd(base)).toBeNull();
    expect(dailyBudgetUsd({ ...base, LLM_DAILY_BUDGET_USD: " " })).toBeNull();
  });

  it("reads a number, including zero as a hard stop", () => {
    expect(dailyBudgetUsd({ ...base, LLM_DAILY_BUDGET_USD: "5" })).toBe(5);
    expect(dailyBudgetUsd({ ...base, LLM_DAILY_BUDGET_USD: "0" })).toBe(0);
  });

  it("ignores a value that is not a non-negative number", () => {
    expect(dailyBudgetUsd({ ...base, LLM_DAILY_BUDGET_USD: "five" })).toBeNull();
    expect(dailyBudgetUsd({ ...base, LLM_DAILY_BUDGET_USD: "-1" })).toBeNull();
  });
});

describe("utcDayStart", () => {
  it("is midnight UTC of the same UTC day", () => {
    expect(utcDayStart(new Date("2026-09-29T23:59:59Z")).toISOString()).toBe("2026-09-29T00:00:00.000Z");
    // 07:30 in Singapore on the 30th is still the 29th in UTC.
    expect(utcDayStart(new Date("2026-09-30T07:30:00+08:00")).toISOString()).toBe(
      "2026-09-29T00:00:00.000Z",
    );
  });
});

describe("prices", () => {
  // The baseline scripts' use of the same table is checked in
  // baseline-prices.test.ts, which stays out of the public snapshot with them.
  it("are the dated list prices", () => {
    expect(PRICES["claude-sonnet-5"]).toEqual({ input: 2, output: 10 });
    expect(PRICES["claude-opus-4-8"]).toEqual({ input: 5, output: 25 });
  });

  it("price the mock as the default persona model and an unknown model at the highest price", () => {
    expect(guardPriceFor("mock")).toEqual(PRICES["claude-sonnet-5"]);
    expect(guardPriceFor("some-new-model")).toEqual(PRICES["claude-opus-4-8"]);
    expect(() => priceFor("some-new-model")).toThrow(/lib\/llm\/prices\.ts/);
  });
});

describe("spend", () => {
  it("prices each side by its own model", () => {
    // 1M Sonnet input tokens (USD 2) plus 1M Opus output tokens (USD 25).
    expect(spendUsd(ONE_MILLION, MODELS)).toBeCloseTo(ONE_MILLION_USD, 6);
    expect(ONE_MILLION_USD).toBe(27);
  });

  it("sorts metered tokens into persona and judge sides", () => {
    const totals = totalsFromRows({ prompt: "100", completion: "50" }, [
      { type: "analyst_step", prompt: 10, completion: 5, judgePrompt: 0, judgeCompletion: 0 },
      { type: "persona_consistency", prompt: 7, completion: 3, judgePrompt: 0, judgeCompletion: 0 },
      { type: "submission_scored", prompt: 0, completion: 0, judgePrompt: "20", judgeCompletion: "4" },
    ]);
    expect(totals).toEqual({
      persona: { prompt: 110, completion: 55 },
      judge: { prompt: 27, completion: 7 },
      // The analyst's share of the persona side, priced at its own model in
      // the instructor readout.
      analyst: { prompt: 10, completion: 5 },
    });
  });

  it("prices the analyst's calls at the analyst model in the readout (A2: Haiku analyst, Sonnet personas)", async () => {
    const { readoutUsd } = await import("@/lib/llm/budget");
    // A2 in the committed showcase: persona messages and failed persona turns,
    // analyst steps, audits and judge calls, from the committed snapshot.
    const totals = {
      persona: { prompt: 323_831 + 20_454 + 139_828, completion: 10_602 + 673 + 18_387 },
      analyst: { prompt: 139_828, completion: 18_387 },
      judge: { prompt: 83_430 + 53_315, completion: 1_680 + 5_576 },
    };
    const usd = readoutUsd(totals, { persona: "claude-sonnet-5", analyst: "claude-haiku-4-5", judge: "claude-opus-4-8" });
    expect(usd).toBeCloseTo(1.898208, 6);
    // Without a recorded analyst model the analyst is priced as a persona.
    expect(readoutUsd(totals, { persona: "claude-sonnet-5", judge: "claude-opus-4-8" })).toBeCloseTo(1.898208 + 0.231763, 5);
  });
});

describe("checkDailyBudget", () => {
  beforeEach(() => resetSpendCache());

  const now = new Date("2026-09-29T12:00:00Z");
  const deps = (limit: string | undefined, fetchTotals = vi.fn(async () => ONE_MILLION)) => ({
    now,
    env: { ...base, LLM_DAILY_BUDGET_USD: limit },
    fetchTotals,
    models: () => MODELS,
  });

  it("never queries when no limit is set", async () => {
    const d = deps(undefined);
    expect(await checkDailyBudget(d)).toEqual({ ok: true });
    expect(d.fetchTotals).not.toHaveBeenCalled();
  });

  it("allows calls under the limit", async () => {
    expect((await checkDailyBudget(deps("30"))).ok).toBe(true);
  });

  it("refuses once today's spend reaches the limit", async () => {
    const result = await checkDailyBudget(deps(String(ONE_MILLION_USD)));
    expect(result).toMatchObject({ ok: false, message: BUDGET_MESSAGE, limitUsd: ONE_MILLION_USD });
  });

  it("counts from 00:00 UTC", async () => {
    const d = deps("5");
    await checkDailyBudget(d);
    expect(d.fetchTotals).toHaveBeenCalledWith(new Date("2026-09-29T00:00:00Z"));
  });

  it("caches the spend within the window and recomputes after it", async () => {
    const fetchTotals = vi.fn(async () => ONE_MILLION);
    const common = { env: base, fetchTotals, models: () => MODELS };
    await todaysSpendUsd({ ...common, now });
    await todaysSpendUsd({ ...common, now: new Date(now.getTime() + SPEND_CACHE_MS - 1) });
    expect(fetchTotals).toHaveBeenCalledTimes(1);
    await todaysSpendUsd({ ...common, now: new Date(now.getTime() + SPEND_CACHE_MS) });
    expect(fetchTotals).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh count on a new UTC day even inside the cache window", async () => {
    const fetchTotals = vi.fn(async () => ONE_MILLION);
    const common = { env: base, fetchTotals, models: () => MODELS };
    await todaysSpendUsd({ ...common, now: new Date("2026-09-29T23:59:50Z") });
    await todaysSpendUsd({ ...common, now: new Date("2026-09-30T00:00:05Z") });
    expect(fetchTotals).toHaveBeenCalledTimes(2);
  });
});

describe("budgetExceededResponse", () => {
  it("is a 429 carrying the learner-facing message and the reset instant", async () => {
    const res = budgetExceededResponse("chat", new Date("2026-09-29T13:00:00Z"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "daily-budget-exhausted",
      message: BUDGET_MESSAGE,
      resetsAtIso: "2026-09-30T00:00:00.000Z",
    });
  });

  it("says why, when, and whom to tell, in plain wording", () => {
    expect(BUDGET_MESSAGE).toBe(
      "The course's daily model budget is used up for everyone; this is not a limit on your account. Replies resume at 00:00 UTC. Tell your instructor if this keeps happening.",
    );
    expect(BUDGET_MESSAGE).not.toMatch(/[\u2014!]|demo/);
  });

  it("names no instructor to a sandbox visitor", async () => {
    const res = budgetExceededResponse("chat", new Date("2026-09-29T13:00:00Z"), "sandbox");
    const body = await res.json();
    expect(body.message).toMatch(/^The demo's daily model budget is used up for everyone/);
    expect(body.message).not.toMatch(/instructor/);
  });
});

describe("mock pricing", () => {
  it("prices the mock at zero in readouts under both of its names", () => {
    // "mock-model-id" is the id the AI SDK mock reports as the served model;
    // it used to fall through to the most expensive listed model.
    expect(isMockModel("mock")).toBe(true);
    expect(isMockModel("mock-model-id")).toBe(true);
    expect(readoutPriceFor("mock")).toEqual({ input: 0, output: 0 });
    expect(readoutPriceFor("mock-model-id")).toEqual({ input: 0, output: 0 });
    // The guard still counts mock tokens, so the limits can be tested.
    expect(guardPriceFor("mock-model-id")).toEqual(PRICES["claude-sonnet-5"]);
  });
});
