import { describe, expect, it } from "vitest";
import {
  effectiveScore,
  formatTotals,
  meanEffectiveScores,
  submissionTotals,
} from "@/lib/engagement/effective-score";
import { attemptNumbers, attemptsUsed } from "@/lib/engagement/attempts";

describe("effective score", () => {
  it("is the override when present, otherwise the judge", () => {
    expect(effectiveScore({ score: 4, maxScore: 5, overrideScore: 2 })).toBe(2);
    expect(effectiveScore({ score: 4, maxScore: 5, overrideScore: null })).toBe(4);
    expect(effectiveScore({ score: 4, maxScore: 5, overrideScore: 0 })).toBe(0);
  });

  it("totals a submission and says when it was adjusted", () => {
    const totals = submissionTotals([
      { score: 4, maxScore: 5, overrideScore: 2 },
      { score: 4, maxScore: 5, overrideScore: null },
      { score: 4, maxScore: 5, overrideScore: null },
      { score: 4, maxScore: 5, overrideScore: null },
    ]);
    expect(totals).toEqual({ effective: 14, judge: 16, max: 20, adjusted: true });
    expect(formatTotals(totals)).toBe("14/20, instructor-adjusted; judge 16/20");
  });

  it("does not call an override equal to the judge an adjustment", () => {
    const totals = submissionTotals([{ score: 3, maxScore: 5, overrideScore: 3 }]);
    expect(totals.adjusted).toBe(false);
    expect(formatTotals(totals)).toBe("3/5");
  });

  it("averages effective scores per scenario, stage and criterion", () => {
    const means = meanEffectiveScores([
      { scenarioId: "s", stage: "a", criterionId: "c1", score: 4, maxScore: 5, overrideScore: 2 },
      { scenarioId: "s", stage: "a", criterionId: "c1", score: 4, maxScore: 5, overrideScore: null },
      { scenarioId: "s", stage: "a", criterionId: "c2", score: 1, maxScore: 5, overrideScore: null },
    ]);
    expect(means).toEqual([
      { scenarioId: "s", stage: "a", criterionId: "c1", meanScore: 3, maxScore: 5, n: 2 },
      { scenarioId: "s", stage: "a", criterionId: "c2", meanScore: 1, maxScore: 5, n: 1 },
    ]);
  });
});

describe("attempt numbering", () => {
  const subs = [
    { id: "1", stage: "formulation", status: "failed" },
    { id: "2", stage: "formulation", status: "scored" },
    { id: "3", stage: "formulation", status: "pending" },
    { id: "4", stage: "formulation", status: "scored" },
    { id: "5", stage: "data-collection", status: "scored" },
  ];

  it("numbers only scored submissions, per stage", () => {
    const n = attemptNumbers(subs);
    expect([...n.entries()]).toEqual([
      ["2", 1],
      ["4", 2],
      ["5", 1],
    ]);
  });

  it("counts only scored attempts at a stage", () => {
    expect(attemptsUsed(subs, "formulation")).toBe(2);
    expect(attemptsUsed(subs, "cleaning")).toBe(0);
  });
});
