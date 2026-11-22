import { describe, expect, it, vi } from "vitest";
import {
  CohortConfigSchema,
  DEFAULT_COHORT_CONFIG,
  NEW_COHORT_CONFIG,
  parseCohortConfig,
} from "@/lib/cohort/defaults";
import { configVersion } from "@/lib/cohort/config-version";

// A config as the first release stored it: llm.provider present, no
// reflections, limits or sandbox keys, and check-ins switched on.
const LEGACY_CONFIG = {
  scenarios: { allowed: ["customer-churn"] },
  gates: { minScoreRatio: 0.6, maxRetries: 2 },
  llm: { provider: "anthropic", temperature: 0.4 },
  ui: { showRubricScores: true },
  research: { checkins: true, consistencyAuditRate: 0.25 },
};

describe("cohort config defaults", () => {
  it("keeps the research instruments off for new cohorts", () => {
    expect(DEFAULT_COHORT_CONFIG.research.checkins).toBe(false);
    expect(DEFAULT_COHORT_CONFIG.research.reflections).toBe(false);
  });

  it("closes the sandbox and caps learner messages by default", () => {
    expect(DEFAULT_COHORT_CONFIG.sandbox).toEqual({ openJoin: false, maxJoinsPerDay: 50, dailyBudgetUsd: 2, maxLearnerMessages: 40 });
    expect(DEFAULT_COHORT_CONFIG.limits.maxLearnerMessages).toBe(200);
  });

  it("has no per-cohort provider: the deployment decides", () => {
    expect(DEFAULT_COHORT_CONFIG.llm).toEqual({ temperature: 0.4 });
  });

  it("parses its own defaults unchanged", () => {
    expect(CohortConfigSchema.parse(DEFAULT_COHORT_CONFIG)).toEqual(DEFAULT_COHORT_CONFIG);
  });
});

describe("parseCohortConfig on a config saved before the new keys", () => {
  const parsed = parseCohortConfig(LEGACY_CONFIG);

  it("parses rather than falling back to the defaults", () => {
    expect(parsed.scenarios.allowed).toEqual(["customer-churn"]);
  });

  it("keeps a stored setting even where the default has changed", () => {
    // The cohort chose check-ins when they defaulted on; that choice stands.
    expect(parsed.research.checkins).toBe(true);
  });

  it("fills keys the stored config lacks from the defaults", () => {
    expect(parsed.research.reflections).toBe(false);
    expect(parsed.limits).toEqual({ maxLearnerMessages: 200 });
    expect(parsed.sandbox).toEqual({ openJoin: false, maxJoinsPerDay: 50, dailyBudgetUsd: 2, maxLearnerMessages: 40 });
    expect(parsed.showcase).toEqual({ comparePair: null, reviewerVisible: false, labels: {}, scriptedReplays: [], h1Patch: null });
  });

  it("drops the legacy llm.provider key", () => {
    expect(parsed.llm).toEqual({ temperature: 0.4 });
  });

  it("leaves the stored fingerprint alone, so the save precondition still matches", () => {
    // The config page hashes the stored JSON, and so does the PATCH handler;
    // parsing for display must not change what either of them sees.
    const before = configVersion(LEGACY_CONFIG);
    parseCohortConfig(LEGACY_CONFIG);
    expect(configVersion(LEGACY_CONFIG)).toBe(before);
  });
});

describe("parseCohortConfig on an invalid config", () => {
  it("falls back to the formative new-cohort config, never a hard gate, and logs it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseCohortConfig({ gates: "nonsense" })).toEqual(NEW_COHORT_CONFIG);
    expect(parseCohortConfig({ gates: "nonsense" }).gates.minScoreRatio).toBeNull();
    expect(parseCohortConfig(null)).toEqual(NEW_COHORT_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cohort config failed to parse; using the formative new-cohort config/));
    warn.mockRestore();
  });

  it("rejects an out-of-range message cap", () => {
    const bad = { ...DEFAULT_COHORT_CONFIG, limits: { maxLearnerMessages: 0 } };
    expect(CohortConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe("showcase.comparePair", () => {
  it("parses a pinned pair and keeps it", () => {
    const pair = { human: "55fd9659", agent: "1acba438" };
    const parsed = parseCohortConfig({ ...LEGACY_CONFIG, showcase: { comparePair: pair } });
    expect(parsed.showcase.comparePair).toEqual(pair);
  });

  it("rejects a pair with an empty id", () => {
    const bad = { ...DEFAULT_COHORT_CONFIG, showcase: { comparePair: { human: "", agent: "x" } } };
    expect(CohortConfigSchema.safeParse(bad).success).toBe(false);
  });
});
