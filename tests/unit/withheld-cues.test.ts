// The exhibit's scripted learner asks the client sponsor "roughly what does
// one cost" about a retention offer. The offer-cost cue list had "does one
// offer cost" and "how much does" but no form without the noun, so the guard
// treated the question as not meeting the reveal condition and regenerated
// the reply without the cost. The widened cue lists cover that phrasing and
// the other natural forms below; the guard logic itself is unchanged.

import { describe, expect, it } from "vitest";
import { loadFixture } from "../../scripts/replay/fixture";
import { revealConditionMet } from "@/lib/agents/withheld-guard";
import { loadScenario } from "@/lib/scenarios/load";

const exhibit = loadFixture("scripts/replay/fixtures/fail-then-revise.json");
const churn = await loadScenario("customer-churn");
const segmentation = await loadScenario("customer-segmentation");
const demand = await loadScenario("demand-forecasting");
const factIn = (s: typeof churn, id: string) => s.personas.flatMap((p) => p.withheld).find((w) => w.id === id)!;

describe("withheld-fact cue lists", () => {
  it("count the exhibit's cost question as asking what an offer costs", () => {
    const question = exhibit.timeline.find((s) => s.index === 1)!.text!;
    expect(question).toContain("roughly what does one cost");
    expect(revealConditionMet(factIn(churn, "offer-cost"), question)).toBe(true);
    // The same message also asks when a contacted customer counts as saved.
    expect(revealConditionMet(factIn(churn, "save-definition"), question)).toBe(true);
  });

  it("count the live learner's question about a kept customer as asking for the save definition", () => {
    for (const q of [
      "How do they decide a customer was actually kept rather than just delayed?",
      "When does a customer count as kept?",
      "What counts as a successful save?",
      "How long do they stay before it counts as retained?",
    ]) {
      expect(revealConditionMet(factIn(churn, "save-definition"), q), q).toBe(true);
    }
  });

  it("cover the plain forms of the offer-cost question", () => {
    for (const q of [
      "What does one cost?",
      "Roughly, what one costs would help.",
      "Can you tell me what each costs?",
      "What is the cost of an offer?",
      "I need to know what an offer costs.",
    ]) {
      expect(revealConditionMet(factIn(churn, "offer-cost"), q), q).toBe(true);
    }
  });

  it("cover a natural phrasing for each other withheld fact", () => {
    const cases: [typeof churn, string, string][] = [
      [churn, "save-definition", "When is a customer considered saved?"],
      [churn, "duplicate-rows", "Can the same subscriber appear after a downgrade?"],
      [churn, "offer-levers", "What do your agents offer a customer who wants to leave?"],
      [segmentation, "first-use-timeline", "When do you want the segments ready?"],
      [segmentation, "past-vendor", "Has the team segmented members in the past?"],
      [segmentation, "test-accounts", "Are there any dummy or employee records in the member table?"],
      [segmentation, "segment-hopping", "How will you evaluate the campaign once segments are live?"],
      [demand, "error-costs", "How much do you lose on a loaf that goes unsold?"],
      [demand, "weather-adjustment", "How do managers decide how many loaves to bake?"],
      [demand, "pos-migration", "Was there a point of sale change at some outlets?"],
      [demand, "manager-blame", "What happens if the forecast is wrong?"],
    ];
    for (const [s, id, q] of cases) expect(revealConditionMet(factIn(s, id), q), `${id}: ${q}`).toBe(true);
  });

  it("still do not meet a condition from an unrelated question", () => {
    expect(revealConditionMet(factIn(churn, "offer-cost"), "Which columns describe tenure?")).toBe(false);
    expect(revealConditionMet(factIn(demand, "manager-blame"), "Which outlets are in the extract?")).toBe(false);
  });
});
