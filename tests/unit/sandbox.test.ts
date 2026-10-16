import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COHORT_CONFIG, type CohortConfig } from "@/lib/cohort/defaults";

const createSandboxLearner = vi.fn(async (_cohortId: string, _hash?: string | null) => ({
  studentId: "s-new",
  cookieToken: "cookie-new",
  cookieExpiresAt: new Date("2027-01-01T00:00:00Z"),
}));
let openCohort: { id: string; slug: string; name: string; config: CohortConfig } | null = null;
let joinsToday = 0;
let budgetOk = true;
let existingCohortId: string | null = null;
let addressJoins = 0;

vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/cohort/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cohort/sandbox")>();
  return {
    ...actual,
    findOpenJoinCohort: async () => openCohort,
    countSandboxJoinsToday: async () => joinsToday,
    countAddressJoinsToday: async () => addressJoins,
    createSandboxLearner: (id: string, hash?: string | null) => createSandboxLearner(id, hash),
  };
});
vi.mock("@/lib/llm/budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/budget")>()),
  checkDailyBudget: async () => (budgetOk ? { ok: true } : { ok: false, message: "limit" }),
  checkCohortBudget: async () => (budgetOk ? { ok: true } : { ok: false, message: "limit" }),
}));
vi.mock("@/lib/cohort/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cohort/resolve")>()),
  resolveCohortFromRequest: async () => (existingCohortId ? { cohortId: existingCohortId } : null),
}));

const {
  addressHash,
  clientAddress,
  inMemoryAddressJoins,
  noteAddressJoin,
  openJoinCohorts,
  openJoinWarning,
  pickOpenJoinCohort,
  pickSandboxCohort,
  resetAddressCounts,
  SANDBOX_JOINS_PER_IP_PER_DAY,
  sandboxJoinRefusal,
} = await import("@/lib/cohort/sandbox");
const { handleSandboxJoin } = await import("@/lib/cohort/sandbox-route");
const { STUDENT_COOKIE_NAME } = await import("@/lib/cohort/resolve");
const { NextRequest } = await import("next/server");

const open = (overrides: Partial<CohortConfig["sandbox"]> = {}): CohortConfig => ({
  ...DEFAULT_COHORT_CONFIG,
  sandbox: { openJoin: true, maxJoinsPerDay: 50, dailyBudgetUsd: 2, maxLearnerMessages: 40, ...overrides },
});

const row = (id: string, configJson: unknown, archivedAt: Date | null = null) => ({
  id,
  slug: `${id}-slug`,
  name: id,
  configJson,
  archivedAt,
  createdAt: new Date(),
});

describe("the sandbox cohort", () => {
  it("is the only open, unarchived cohort", () => {
    const picked = pickOpenJoinCohort([
      row("newest-closed", DEFAULT_COHORT_CONFIG),
      row("newest-open-archived", open(), new Date()),
      row("open", open()),
    ]);
    expect(picked?.id).toBe("open");
  });

  it("is none when two cohorts are open and none is configured, rather than the newest", () => {
    const rows = [row("newer", open()), row("older", open())];
    expect(pickSandboxCohort(openJoinCohorts(rows))).toBeNull();
    expect(pickSandboxCohort(openJoinCohorts(rows), "older-slug")?.id).toBe("older");
  });

  it("is none when SANDBOX_COHORT_SLUG names a cohort that is not open", () => {
    expect(pickSandboxCohort(openJoinCohorts([row("a", open())]), "other")).toBeNull();
  });

  it("is found by slug for /try/<slug> whatever else is open", () => {
    const rows = [row("newer", open()), row("older", open())];
    expect(pickOpenJoinCohort(rows, "older-slug")?.id).toBe("older");
    expect(pickOpenJoinCohort(rows, "closed-slug")).toBeNull();
  });

  it("finds nothing when no cohort has opted in", () => {
    expect(pickOpenJoinCohort([row("a", DEFAULT_COHORT_CONFIG)])).toBeNull();
  });

  it("warns the admin when more than one cohort has open join", () => {
    expect(openJoinWarning([{ name: "A", slug: "a" }])).toBeNull();
    const two = [
      { name: "A", slug: "a" },
      { name: "B", slug: "b" },
    ];
    expect(openJoinWarning(two)).toMatch(/2 cohorts have open join: A \(a\), B \(b\)\. The landing page shows no sandbox link/);
    expect(openJoinWarning(two, "b")).toMatch(/use b \(SANDBOX_COHORT_SLUG\)/);
  });
});

describe("sandboxJoinRefusal", () => {
  const cohort = { id: "c", slug: "c", name: "c", config: open({ maxJoinsPerDay: 2 }) };

  it("refuses when no cohort is open", () => {
    expect(sandboxJoinRefusal({ cohort: null, budgetOk: true, joinsToday: 0 })).toBe("sandbox-closed");
  });

  it("refuses when the daily budget is spent", () => {
    expect(sandboxJoinRefusal({ cohort, budgetOk: false, joinsToday: 0 })).toBe("usage-limit");
  });

  it("refuses when no spend budget is set", () => {
    expect(sandboxJoinRefusal({ cohort, budgetOk: true, budgetSet: false, joinsToday: 0 })).toBe(
      "sandbox-no-budget",
    );
  });

  it("refuses an address that has taken its seats for the day", () => {
    const at = (n: number) =>
      sandboxJoinRefusal({ cohort: { ...cohort, config: open() }, budgetOk: true, joinsToday: 0, joinsFromAddressToday: n });
    expect(at(SANDBOX_JOINS_PER_IP_PER_DAY - 1)).toBeNull();
    expect(at(SANDBOX_JOINS_PER_IP_PER_DAY)).toBe("sandbox-ip-limit");
  });

  it("refuses at the daily join cap", () => {
    expect(sandboxJoinRefusal({ cohort, budgetOk: true, joinsToday: 1 })).toBeNull();
    expect(sandboxJoinRefusal({ cohort, budgetOk: true, joinsToday: 2 })).toBe("sandbox-full");
  });
});

describe("per-address throttle", () => {
  beforeEach(() => resetAddressCounts());

  it("reads the first forwarded address, then x-real-ip", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe("203.0.113.5");
    expect(clientAddress(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientAddress(new Headers())).toBeNull();
  });

  it("stores only a salted hash of the address", () => {
    const h = addressHash("203.0.113.5", "salt");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain("203");
    expect(addressHash("203.0.113.5", "other-salt")).not.toBe(h);
  });

  it("counts joins in memory per UTC day", () => {
    const day = new Date("2026-09-30T10:00:00Z");
    noteAddressJoin("h", day);
    noteAddressJoin("h", day);
    expect(inMemoryAddressJoins("h", day)).toBe(2);
    expect(inMemoryAddressJoins("h", new Date("2026-10-01T00:00:01Z"))).toBe(0);
  });
});

describe("GET /try", () => {
  beforeEach(() => {
    process.env.LLM_DAILY_BUDGET_USD = "5";
    process.env.PSEUDONYM_SALT = "test-salt-long-enough-for-the-32-character-rule";
    addressJoins = 0;
    openCohort = { id: "c1", slug: "sandbox", name: "Sandbox", config: open() };
    joinsToday = 0;
    budgetOk = true;
    existingCohortId = null;
    createSandboxLearner.mockClear();
  });

  const get = () => handleSandboxJoin(new NextRequest("http://localhost:3000/try"));

  it("refuses an address over its daily seats", async () => {
    addressJoins = SANDBOX_JOINS_PER_IP_PER_DAY;
    const res = await handleSandboxJoin(
      new NextRequest("http://localhost:3000/try", { headers: { "x-forwarded-for": "203.0.113.5" } }),
    );
    expect(res.headers.get("location")).toBe("http://localhost:3000/join/error?reason=sandbox-ip-limit");
    expect(createSandboxLearner).not.toHaveBeenCalled();
  });

  it("lets the offline mock provider join without a budget", async () => {
    delete process.env.LLM_DAILY_BUDGET_USD;
    process.env.LLM_PROVIDER = "mock";
    try {
      const res = await get();
      expect(res.headers.get("location")).toBe("http://localhost:3000/workspace");
    } finally {
      delete process.env.LLM_PROVIDER;
    }
  });

  it("creates a learner, sets the session cookie and lands in the workspace", async () => {
    const res = await get();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/workspace");
    expect(res.cookies.get(STUDENT_COOKIE_NAME)?.value).toBe("cookie-new");
    expect(createSandboxLearner).toHaveBeenCalledWith("c1", null);
  });

  it("records a hash of the visitor's address on the new seat", async () => {
    await handleSandboxJoin(new NextRequest("http://localhost:3000/try", { headers: { "x-forwarded-for": "203.0.113.5" } }));
    const hash = createSandboxLearner.mock.calls[0][1];
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a visitor who already has a seat in the cohort to it", async () => {
    existingCohortId = "c1";
    const res = await get();
    expect(res.headers.get("location")).toBe("http://localhost:3000/workspace");
    expect(createSandboxLearner).not.toHaveBeenCalled();
  });

  it.each([
    ["no open cohort", () => (openCohort = null), "sandbox-closed"],
    ["the budget is spent", () => (budgetOk = false), "usage-limit"],
    ["the daily cap is reached", () => (joinsToday = 50), "sandbox-full"],
    ["no budget is set", () => delete process.env.LLM_DAILY_BUDGET_USD, "sandbox-no-budget"],
  ])("sends the visitor to the error page when %s", async (_name, setup, reason) => {
    setup();
    const res = await get();
    expect(res.headers.get("location")).toBe(`http://localhost:3000/join/error?reason=${reason}`);
    expect(createSandboxLearner).not.toHaveBeenCalled();
  });
});
