// The H1 replay patch (scripts/replay/patches/h1-current-scenario.json)
// brings the reference run's six artifacts in line with the current churn
// scenario and fixes its offer-cost arithmetic. These tests apply it to the
// fixture and check what the regenerated H1 will submit.
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { DEFAULT_H1_PATCH, applyPatch, loadFixture, loadPatch, type ReplayPatch } from "../../scripts/replay/fixture";

const fixture = loadFixture("scripts/replay/fixtures/human-reference.json");
const loaded = loadPatch(DEFAULT_H1_PATCH);
const { timeline, applied } = applyPatch(fixture, fixture.timeline, loaded.patch);
const all = timeline.map((s) => s.text).join("\n");
const artifact = (stage: string) => timeline.find((s) => s.kind === "submit" && s.stage === stage)!.text;

// S$ amounts as numbers: "S$180,000" -> 180000.
const sgd = (text: string) => Number(text.replace(/[S$,]/g, ""));

const scenario = yaml.load(readFileSync("configs/scenarios/customer-churn.yaml", "utf8")) as {
  worldFactsSeed: string[];
  personas: { id: string; withheld?: { id: string; fact: string }[] }[];
};
const seedBudget = sgd(scenario.worldFactsSeed.join(" ").match(/quarterly campaign budget is (S\$[\d,]+)/)![1]);
const seedOffers = Number(scenario.worldFactsSeed.join(" ").match(/roughly ([\d,]+) retention offers per month/)![1].replace(/,/g, ""));
const offerCost = sgd(
  scenario.personas.flatMap((p) => p.withheld ?? []).find((w) => w.id === "offer-cost")!.fact.match(/S\$[\d,]+/)![0],
);

describe("H1 replay patch", () => {
  it("is a documented patch for the H1 fixture, every entry with a stage, old and new text and a reason", () => {
    expect(loaded.patch.format).toBe("agenticpracticum-replay-patch");
    expect(loaded.patch.fixtureEngagementId).toBe(fixture.source.engagementId);
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const e of loaded.patch.entries) {
      expect(e.stage).toBeTruthy();
      expect(e.old).not.toBe(e.new);
      expect(e.reason.length).toBeGreaterThan(20);
    }
    // One change per entry, and the fixture itself is not modified.
    expect(applied).toHaveLength(loaded.patch.entries.length);
    expect(fixture.timeline.map((s) => s.text).join("\n")).toMatch(/S\$180,000 quarterly/);
  });

  it("touches only the six artifacts, never a learner message", () => {
    const changed = timeline.filter((s, i) => s.text !== fixture.timeline[i].text);
    expect(changed.every((s) => s.kind === "submit")).toBe(true);
    expect(new Set(changed.map((s) => s.stage))).toEqual(
      new Set(["formulation", "data-collection", "cleaning", "modelling", "deployment"]),
    );
  });

  it("leaves no old-scenario figure: no S$180,000 quarterly budget, no S$60,000 run rate, no March outage", () => {
    expect(all).not.toMatch(/180,000 quarterly/);
    expect(all).not.toMatch(/S\$60,000/);
    expect(all).not.toMatch(/March/);
    expect(all).not.toMatch(/S\$18,000\b/);
    expect(all).not.toMatch(/S\$72\b/);
    // Every remaining S$180,000 is a monthly figure.
    for (const m of all.matchAll(/S\$180,000[^.;]{0,40}/g)) expect(m[0]).toMatch(/a month|monthly|in offer spend/);
    // Every quarterly budget named is the scenario's.
    for (const m of all.matchAll(/(S\$[\d,]+) quarterly/g)) expect(sgd(m[1])).toBe(seedBudget);
    expect(all).toMatch(/May mediation/);
  });

  it("makes the offer-cost arithmetic consistent with the scenario", () => {
    expect(seedOffers * offerCost * 3).toBe(seedBudget);
    const model = artifact("modelling");
    const m = model.match(/At (S\$[\d,]+) per offer that is (S\$[\d,]+) a month, the whole of the (S\$[\d,]+) monthly run rate of the (S\$[\d,]+) quarterly budget/);
    expect(m).not.toBeNull();
    const [, perOffer, month, runRate, quarter] = m!.map((x) => (x.startsWith("S$") ? sgd(x) : 0));
    expect(perOffer).toBe(offerCost);
    expect(month).toBe(seedOffers * offerCost);
    expect(runRate).toBe(quarter / 3);
    expect(quarter).toBe(seedBudget);

    const final = artifact("deployment");
    const spend = sgd(final.match(/a full ([\d,]+)-offer month costs (S\$[\d,]+) in offer spend/)![2]);
    expect(spend).toBe(seedOffers * offerCost);
    const saves = Number(final.match(/about ([\d,]+) saves a month at roughly (S\$[\d,]+) of offer cost per save/)![1]);
    const perSave = sgd(final.match(/about ([\d,]+) saves a month at roughly (S\$[\d,]+) of offer cost per save/)![2]);
    expect(perSave).toBe(spend / saves);
    expect(sgd(final.match(/the (S\$[\d,]+) quarterly retention budget/)![1])).toBe(seedBudget);
  });

  it("refuses a patch whose old text is not found exactly once", () => {
    const bad: ReplayPatch = {
      ...loaded.patch,
      entries: [{ stage: "formulation", artifact: "problem-statement", old: "no such text", new: "x", reason: "test" }],
    };
    expect(() => applyPatch(fixture, fixture.timeline, bad)).toThrow(/found 0 times/);
    const twice: ReplayPatch = {
      ...loaded.patch,
      entries: [{ stage: "formulation", artifact: "problem-statement", old: "S$180,000", new: "x", reason: "test" }],
    };
    expect(() => applyPatch(fixture, fixture.timeline, twice)).toThrow(/found 2 times/);
    const other: ReplayPatch = { ...loaded.patch, fixtureEngagementId: "someone-else" };
    expect(() => applyPatch(fixture, fixture.timeline, other)).toThrow(/patch is for engagement/);
  });
});

describe("showcase.h1Patch in the cohort config", () => {
  it("records the patch by file and sha256, and older configs parse with null", async () => {
    const { CohortConfigSchema, DEFAULT_COHORT_CONFIG, parseCohortConfig } = await import("@/lib/cohort/defaults");
    const withPatch = {
      ...DEFAULT_COHORT_CONFIG,
      showcase: { ...DEFAULT_COHORT_CONFIG.showcase, h1Patch: { file: DEFAULT_H1_PATCH, sha256: loaded.sha256 } },
    };
    expect(CohortConfigSchema.parse(withPatch).showcase.h1Patch).toEqual({ file: DEFAULT_H1_PATCH, sha256: loaded.sha256 });
    expect(parseCohortConfig({ ...DEFAULT_COHORT_CONFIG, showcase: { reviewerVisible: true } }).showcase.h1Patch).toBeNull();
    const bad = { ...withPatch, showcase: { ...withPatch.showcase, h1Patch: { file: "x", sha256: "not-a-hash" } } };
    expect(CohortConfigSchema.safeParse(bad).success).toBe(false);
  });
});
