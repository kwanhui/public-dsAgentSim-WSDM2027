// The learner's copy of a judge rationale drops sentences that name a
// withheld fact the submission does not mention; the instructor keeps the
// full text.

import { describe, expect, it } from "vitest";
import {
  FILTERED_RATIONALE_FALLBACK,
  learnerRationale,
  learnerRationaleOf,
  unraisedFactKeys,
} from "@/lib/agents/rationale-filter";
import { loadScenario } from "@/lib/scenarios/load";

const seg = await loadScenario("customer-segmentation");
const churn = await loadScenario("customer-churn");

describe("learnerRationale", () => {
  it("removes a sentence naming an undocumented defect the learner never raised", () => {
    const full =
      "The memo lists refund-netted spend but misses other quirks. It does not mention the staff test accounts with \"T\" ids. Checks are generic.";
    expect(learnerRationale(full, seg, "We found negative monetary_90d values.")).toBe(
      "The memo lists refund-netted spend but misses other quirks. Checks are generic.",
    );
  });

  it("keeps the sentence when the submission already names the fact", () => {
    const full = "It does not quantify the staff test accounts.";
    expect(learnerRationale(full, seg, "We drop the test accounts before clustering.")).toBe(full);
  });

  it("removes a sentence naming a withheld constraint value", () => {
    const full = "The statement omits the operating constraints. It never uses the S$30 offer cost.";
    expect(learnerRationale(full, churn, "We target postpaid subscribers.")).toBe("The statement omits the operating constraints.");
  });

  it("falls back to a neutral line when every sentence is removed", () => {
    expect(learnerRationale("Finance's six more months rule is missing.", churn, "x")).toBe(FILTERED_RATIONALE_FALLBACK);
  });

  it("lists only unraised facts, and reads a stored row with or without the filtered copy", () => {
    const keys = unraisedFactKeys(churn, "Each offer costs about S$30.");
    expect(keys.some((k) => k.includes("$30"))).toBe(false);
    expect(learnerRationaleOf({ rationale: "full", learnerRationale: "filtered" })).toBe("filtered");
    expect(learnerRationaleOf({ rationale: "full", learnerRationale: null })).toBe("full");
  });
});

describe("assessment language in the learner's copy (rubric-v7)", () => {
  it("drops sentences that call the data's problems seeded or planted, or count them", async () => {
    const { assessmentLeak } = await import("@/lib/agents/rationale-filter");
    const full =
      "All four seeded issues are addressed. The report quantifies rows removed. It covers 3 of 4 issues well. The planted duplicates are handled.";
    expect(learnerRationale(full, churn, "rows removed")).toBe("The report quantifies rows removed.");
    expect(assessmentLeak("It covers three of the four issues.")).toBe(true);
    expect(assessmentLeak("the four known issues")).toBe(true);
    expect(assessmentLeak("The memo names the known issue with duplicates.")).toBe(false);
    expect(assessmentLeak("The memo lists two risks and a check for each.")).toBe(false);
  });

  it("replaces an improve line that counts the issues with the generic line", async () => {
    const { improveFor } = await import("@/lib/agents/rubric");
    const coverage = churn.stages[2].gate.rubric.find((c) => c.id === "coverage")!;
    const line = improveFor({
      criterion: coverage,
      score: 3,
      judgeImprove: "Address all four issues with a concrete action.",
      submissionText: "We dedupe.",
    });
    expect(line).not.toContain("four");
  });
});

describe("unraisedFactKeys with exemptions", () => {
  it("leaves out the facts the learner already obtained", () => {
    const all = unraisedFactKeys(churn, "");
    const some = unraisedFactKeys(churn, "", ["offer-cost"]);
    expect(some.length).toBe(all.length - 1);
  });
});
