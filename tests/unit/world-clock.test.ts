// The engagement's in-world clock: a seeded fact fixing "today" shortly
// after the newest date in the scenario's data, so the data owner can vouch
// for her extract's coverage window instead of treating its end date as a
// suspicious cutoff no stakeholder can explain.

import { describe, expect, it } from "vitest";
import { profileCsv } from "@/lib/agents/dataset-profile";
import { loadScenario } from "@/lib/scenarios/load";
import {
  scenarioWorldClockFacts,
  worldClockFacts,
  worldDateFromCoverage,
  WORLD_DATE_OFFSET_DAYS,
} from "@/lib/engagement/world-clock";

describe("date columns in the deterministic profile", () => {
  it("records the coverage window of an ISO date column", () => {
    const p = profileCsv(
      "sales.csv",
      ["date,units", "2025-01-03,4", "2024-12-30,2", "2025-01-01,5"].join("\n"),
    );
    const date = p.columns.find((c) => c.name === "date")!;
    expect(date.dateMin).toBe("2024-12-30");
    expect(date.dateMax).toBe("2025-01-03");
  });

  it("does not mistake ordinary text or numbers for dates", () => {
    const p = profileCsv("plain.csv", ["id,amount", "A1,10", "A2,20"].join("\n"));
    for (const c of p.columns) {
      expect(c.dateMin).toBeUndefined();
      expect(c.dateMax).toBeUndefined();
    }
  });
});

describe("worldClockFacts", () => {
  const dated = profileCsv(
    "sales.csv",
    ["date,units", "2026-06-29,4", "2026-06-30,2", "2024-09-01,5"].join("\n"),
  );

  it("sets today a fixed offset after the newest date and states the coverage window", () => {
    expect(WORLD_DATE_OFFSET_DAYS).toBe(14);
    const facts = worldClockFacts([dated]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain("Today's date in this engagement is 2026-07-14.");
    expect(facts[0]).toContain("sales.csv covers 2024-09-01 to 2026-06-30");
    // The clause that lets the data owner vouch for her own cutoff.
    expect(facts[0]).toContain("not a sign of missing data");
  });

  it("stays deterministic: the same data always yields the same clock", () => {
    expect(worldClockFacts([dated])).toEqual(worldClockFacts([dated]));
  });

  it("seeds nothing for a cross-sectional extract with no date column", () => {
    const undated = profileCsv("members.csv", ["id,age", "M1,30", "M2,41"].join("\n"));
    expect(worldClockFacts([undated])).toEqual([]);
  });

  it("crosses month and year boundaries correctly", () => {
    expect(worldDateFromCoverage("2026-12-25")).toBe("2027-01-08");
  });
});

describe("scenarioWorldClockFacts against the committed scenarios", () => {
  it("derives the demand-forecasting clock from the committed extract", async () => {
    const facts = await scenarioWorldClockFacts(await loadScenario("demand-forecasting"));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain("Today's date in this engagement is 2026-07-14.");
    expect(facts[0]).toContain("daily_sales.csv covers 2024-09-01 to 2026-06-30");
  });

  it("seeds no clock for the scenarios whose extracts carry no dates", async () => {
    for (const id of ["customer-churn", "customer-segmentation"]) {
      expect(await scenarioWorldClockFacts(await loadScenario(id))).toEqual([]);
    }
  });
});
