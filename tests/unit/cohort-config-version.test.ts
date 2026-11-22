import { describe, expect, it } from "vitest";
import { configVersion } from "@/lib/cohort/config-version";
import { DEFAULT_COHORT_CONFIG } from "@/lib/cohort/defaults";

describe("configVersion", () => {
  it("is stable for the same content whatever order the keys arrive in", () => {
    const reordered = {
      showcase: DEFAULT_COHORT_CONFIG.showcase,
      research: DEFAULT_COHORT_CONFIG.research,
      ui: DEFAULT_COHORT_CONFIG.ui,
      llm: DEFAULT_COHORT_CONFIG.llm,
      gates: DEFAULT_COHORT_CONFIG.gates,
      scenarios: DEFAULT_COHORT_CONFIG.scenarios,
      sandbox: DEFAULT_COHORT_CONFIG.sandbox,
      limits: DEFAULT_COHORT_CONFIG.limits,
    };
    expect(configVersion(reordered)).toBe(configVersion(DEFAULT_COHORT_CONFIG));
  });

  it("changes when any setting changes", () => {
    const before = configVersion(DEFAULT_COHORT_CONFIG);
    const gateOff = {
      ...DEFAULT_COHORT_CONFIG,
      gates: { ...DEFAULT_COHORT_CONFIG.gates, minScoreRatio: null },
    };
    const oneScenario = {
      ...DEFAULT_COHORT_CONFIG,
      scenarios: { allowed: ["customer-churn"] },
    };
    expect(configVersion(gateOff)).not.toBe(before);
    expect(configVersion(oneScenario)).not.toBe(before);
  });

  it("distinguishes scenario order, since the stored list keeps it", () => {
    const swapped = {
      ...DEFAULT_COHORT_CONFIG,
      scenarios: { allowed: [...DEFAULT_COHORT_CONFIG.scenarios.allowed].reverse() },
    };
    expect(configVersion(swapped)).not.toBe(configVersion(DEFAULT_COHORT_CONFIG));
  });

  it("gives the save precondition: only the tab whose base is current may write", () => {
    // Both tabs load the same config; one saves, so the stored fingerprint
    // moves and the other tab's base no longer matches (the 409 case).
    const loadedByBothTabs = configVersion(DEFAULT_COHORT_CONFIG);
    const savedByTabA = {
      ...DEFAULT_COHORT_CONFIG,
      llm: { ...DEFAULT_COHORT_CONFIG.llm, temperature: 0.9 },
    };
    const stored = configVersion(savedByTabA);
    expect(loadedByBothTabs).not.toBe(stored);
    // Tab A saves again from the version the API handed back: not stale.
    expect(stored).toBe(configVersion(savedByTabA));
  });
});
