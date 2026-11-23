// The per-network seat limit is a cohort setting, and an optional dated
// event window raises it and the sandbox's daily budget for a live
// demonstration, falling back to the ordinary limits outside the window.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ db: {} }));

const { CohortConfigSchema, DEFAULT_COHORT_CONFIG, parseCohortConfig } = await import("@/lib/cohort/defaults");
const { effectiveSandboxLimits, eventWindowActive, eventWindowValid } = await import("@/lib/cohort/sandbox-limits");
const { sandboxJoinRefusal } = await import("@/lib/cohort/sandbox");
const { checkCohortBudget, resetSpendCache, sandboxLimitUsd } = await import("@/lib/llm/budget");
const { sandboxLine } = await import("@/lib/landing-copy");

// The WSDM 2027 conference week in Hong Kong time (UTC+8), end excluded.
const WINDOW = {
  startsAt: "2027-02-15T00:00:00+08:00",
  endsAt: "2027-02-20T00:00:00+08:00",
  maxJoinsPerAddressPerDay: 50,
  dailyBudgetUsd: 30,
};
const BEFORE = new Date("2027-02-14T15:59:59Z"); // 23:59:59 HKT on 14 Feb
const FIRST = new Date("2027-02-14T16:00:00Z"); // 00:00 HKT on 15 Feb
const LAST = new Date("2027-02-19T15:59:59Z"); // 23:59:59 HKT on 19 Feb
const AFTER = new Date("2027-02-19T16:00:00Z"); // 00:00 HKT on 20 Feb

const sandbox = (overrides: Partial<(typeof DEFAULT_COHORT_CONFIG)["sandbox"]> = {}) => ({
  ...DEFAULT_COHORT_CONFIG.sandbox,
  openJoin: true,
  dailyBudgetUsd: 8,
  ...overrides,
});

describe("sandbox.maxJoinsPerAddressPerDay", () => {
  it("defaults to 5, the limit that was fixed in code, for stored configs without it", () => {
    // A config as stored before the setting existed (the hosted sandbox
    // cohort's shape: open join, USD 8, no per-address key, no window).
    const stored = {
      ...DEFAULT_COHORT_CONFIG,
      sandbox: { openJoin: true, maxJoinsPerDay: 50, dailyBudgetUsd: 8, maxLearnerMessages: 40 },
    };
    const parsed = parseCohortConfig(stored);
    expect(parsed.sandbox.openJoin).toBe(true);
    expect(parsed.sandbox.maxJoinsPerAddressPerDay).toBe(5);
    expect(parsed.sandbox.eventWindow).toBeNull();
  });

  it("is what the join route refuses at", () => {
    const cohort = { id: "c", slug: "c", name: "c", config: { ...DEFAULT_COHORT_CONFIG, sandbox: sandbox({ maxJoinsPerAddressPerDay: 12 }) } };
    const at = (n: number) => sandboxJoinRefusal({ cohort, budgetOk: true, joinsToday: 0, joinsFromAddressToday: n });
    expect(at(11)).toBeNull();
    expect(at(12)).toBe("sandbox-ip-limit");
  });

  it("rejects a limit below 1 or not a whole number", () => {
    const bad = (v: number) =>
      CohortConfigSchema.safeParse({ ...DEFAULT_COHORT_CONFIG, sandbox: sandbox({ maxJoinsPerAddressPerDay: v }) }).success;
    expect(bad(0)).toBe(false);
    expect(bad(2.5)).toBe(false);
    expect(bad(1)).toBe(true);
  });
});

describe("event window", () => {
  it("is in force from its start (inclusive) to its end (exclusive)", () => {
    expect(eventWindowActive(WINDOW, BEFORE)).toBe(false);
    expect(eventWindowActive(WINDOW, FIRST)).toBe(true);
    expect(eventWindowActive(WINDOW, LAST)).toBe(true);
    expect(eventWindowActive(WINDOW, AFTER)).toBe(false);
  });

  it("raises the per-network limit and the budget inside the window and falls back outside it", () => {
    const s = sandbox({ eventWindow: WINDOW });
    expect(effectiveSandboxLimits(s, BEFORE)).toEqual({ maxJoinsPerAddressPerDay: 5, dailyBudgetUsd: 8, eventActive: false });
    expect(effectiveSandboxLimits(s, FIRST)).toEqual({ maxJoinsPerAddressPerDay: 50, dailyBudgetUsd: 30, eventActive: true });
    expect(effectiveSandboxLimits(s, AFTER)).toEqual({ maxJoinsPerAddressPerDay: 5, dailyBudgetUsd: 8, eventActive: false });
  });

  it("never applies when its end is not after its start", () => {
    const backwards = { ...WINDOW, startsAt: WINDOW.endsAt, endsAt: WINDOW.startsAt };
    expect(eventWindowValid(backwards)).toBe(false);
    expect(effectiveSandboxLimits(sandbox({ eventWindow: backwards }), FIRST).eventActive).toBe(false);
  });

  it("stores times only as ISO 8601 with an offset, and a bad window leaves the rest of the config valid to the schema", () => {
    const withWindow = (w: unknown) =>
      CohortConfigSchema.safeParse({ ...DEFAULT_COHORT_CONFIG, sandbox: { ...sandbox(), eventWindow: w } }).success;
    expect(withWindow(WINDOW)).toBe(true);
    expect(withWindow(null)).toBe(true);
    expect(withWindow({ ...WINDOW, startsAt: "15 Feb 2027" })).toBe(false);
  });

  it("lets more seats from one address through the join route only inside the window", () => {
    const cohort = { id: "c", slug: "c", name: "c", config: { ...DEFAULT_COHORT_CONFIG, sandbox: sandbox({ eventWindow: WINDOW }) } };
    const refusal = (now: Date) =>
      sandboxJoinRefusal({ cohort, budgetOk: true, joinsToday: 0, joinsFromAddressToday: 20, now });
    expect(refusal(BEFORE)).toBe("sandbox-ip-limit");
    expect(refusal(FIRST)).toBeNull();
    expect(refusal(AFTER)).toBe("sandbox-ip-limit");
  });

  it("sets the sandbox budget the guard applies", () => {
    const cohort = { id: "c", config: { sandbox: sandbox({ eventWindow: WINDOW }) } };
    expect(sandboxLimitUsd(cohort, BEFORE)).toBe(8);
    expect(sandboxLimitUsd(cohort, FIRST)).toBe(30);
    expect(sandboxLimitUsd(cohort, AFTER)).toBe(8);
    expect(sandboxLimitUsd({ id: "course", config: { sandbox: { ...sandbox({ eventWindow: WINDOW }), openJoin: false } } }, FIRST)).toBeNull();
  });

  describe("budget guard", () => {
    beforeEach(() => resetSpendCache());
    // USD 10 of Sonnet 5 input: over the ordinary 8, under the event's 30.
    const TEN_USD = { persona: { prompt: 5_000_000, completion: 0 }, judge: { prompt: 0, completion: 0 } };
    const deps = (now: Date) => ({
      now,
      env: { NODE_ENV: "test", LLM_DAILY_BUDGET_USD: "100" } as NodeJS.ProcessEnv,
      models: () => ({ persona: "claude-sonnet-5", judge: "claude-opus-4-8" }),
      fetchCohortTotals: async () => [TEN_USD],
      fetchTotals: async () => TEN_USD,
    });
    const cohort = { id: "event-cohort", config: { sandbox: sandbox({ eventWindow: WINDOW }) } };

    it("refuses at the ordinary budget before the window", async () => {
      expect((await checkCohortBudget(cohort, deps(BEFORE))).ok).toBe(false);
    });

    it("allows the same spend inside the window", async () => {
      expect((await checkCohortBudget(cohort, deps(FIRST))).ok).toBe(true);
    });
  });
});

describe("landing page seat line", () => {
  it("states the limit it is given", () => {
    expect(sandboxLine(["Customer churn"], 5)).toBe(
      ": opens a sandbox seat in one scenario, Customer churn. No invite needed; up to 5 seats per network each day.",
    );
    expect(sandboxLine(["A", "B", "C"], 50)).toMatch(/one of 3 scenarios\. No invite needed; up to 50 seats per network each day\.$/);
    expect(sandboxLine([], 1)).toMatch(/up to 1 seat per network each day\.$/);
  });
});
