// The persona-v6 withheld-fact guard (lib/agents/withheld-guard.ts): which
// of a persona's own withheld facts a reply may state, given what the
// learner has obtained and what the learner's current message asks.

import { describe, expect, it } from "vitest";
import { blockedWithheld, revealConditionMet, unmetWithheld, withheldLeakNote } from "@/lib/agents/withheld-guard";
import { loadScenario } from "@/lib/scenarios/load";

const churn = await loadScenario("customer-churn");
const sponsor = churn.personas.find((p) => p.role === "client-sponsor")!;
const dataOwner = churn.personas.find((p) => p.role === "data-owner")!;
const fact = (id: string) => churn.personas.flatMap((p) => p.withheld).find((w) => w.id === id)!;

// Probe 17b: the reaction that stated both of the sponsor's facts.
const PROBE_17B =
  "An offer costs about S$30 to serve, so that's your economics figure. Finance only counts a save if the subscriber stays six more months, use that for the save definition.";

describe("revealConditionMet", () => {
  it("is never met in a reaction (no learner message)", () => {
    expect(revealConditionMet(fact("offer-cost"), null, ["offer-cost"])).toBe(false);
  });

  it("is met by the questions the scenario's conditions describe", () => {
    const met: [string, string][] = [
      ["offer-cost", "What does one offer cost, and what is a save worth to you?"],
      ["offer-cost", "And how much does it cost to make one retention offer?"],
      ["save-definition", "What does a successful save look like from Finance's point of view?"],
      ["save-definition", "At what point do you count a contacted customer as saved?"],
      ["save-definition", "How do you want success measured?"],
      ["duplicate-rows", "170 subscriber_ids appear twice and differ only in plan_monthly_fee. Why?"],
      ["duplicate-rows", "Can the same subscriber_id appear more than once?"],
      ["offer-levers", "What offers can you actually put on the table for each?"],
    ];
    for (const [id, message] of met) expect(revealConditionMet(fact(id), message), `${id}: ${message}`).toBe(true);
  });

  it("is not met by a broad or unrelated message", () => {
    const unmet: [string, string][] = [
      ["offer-cost", "What does churn actually mean for you?"],
      ["save-definition", "Who signs off on the campaign?"],
      ["duplicate-rows", "Anything I should know about the file?"],
      // A scope request that states the granularity does not ask about it.
      ["duplicate-rows", "I need account, contract and usage fields, one row per subscriber, for retention targeting."],
      ["offer-levers", "Are the reasons clear enough to use in a retention call?"],
    ];
    for (const [id, message] of unmet) expect(revealConditionMet(fact(id), message), `${id}: ${message}`).toBe(false);
  });

  it("falls back to the persona's report for a fact without cues", () => {
    const bare = { ...fact("offer-cost"), askCues: [] };
    expect(revealConditionMet(bare, "Anything else?", ["offer-cost"])).toBe(true);
    expect(revealConditionMet(bare, "Anything else?", [])).toBe(false);
  });
});

describe("blockedWithheld", () => {
  it("blocks both of the sponsor's facts in the probe-17b reaction, reported or not", () => {
    const blocked = blockedWithheld(sponsor, PROBE_17B, {
      obtained: [],
      learnerMessage: null,
      reportedIds: ["offer-cost", "save-definition"],
    });
    expect(blocked.map((w) => w.id)).toEqual(["offer-cost", "save-definition"]);
  });

  it("lets through a fact the learner has obtained", () => {
    const blocked = blockedWithheld(sponsor, PROBE_17B, { obtained: ["offer-cost"], learnerMessage: null });
    expect(blocked.map((w) => w.id)).toEqual(["save-definition"]);
  });

  it("only looks at the speaking persona's own facts", () => {
    expect(blockedWithheld(dataOwner, PROBE_17B, { obtained: [], learnerMessage: null })).toEqual([]);
  });

  it("lets a chat reply state the fact the message asks for, and blocks the other", () => {
    const blocked = blockedWithheld(sponsor, PROBE_17B, {
      obtained: [],
      learnerMessage: "What does one offer cost you?",
    });
    expect(blocked.map((w) => w.id)).toEqual(["save-definition"]);
  });
});

describe("unmetWithheld and the corrective line", () => {
  it("lists every unobtained fact for a reaction", () => {
    expect(unmetWithheld(sponsor, { obtained: ["save-definition"], learnerMessage: null }).map((w) => w.id)).toEqual([
      "offer-cost",
    ]);
  });

  it("names each fact by its reveal condition, not by its content", () => {
    const note = withheldLeakNote([fact("offer-cost")]);
    expect(note).toContain("the point you share only when the consultant asks what an offer costs");
    expect(note).not.toContain("30");
  });
});

describe("shipped scenarios", () => {
  it("give every withheld fact reveal cues", async () => {
    for (const id of ["customer-churn", "customer-segmentation", "demand-forecasting"]) {
      const scenario = await loadScenario(id);
      for (const w of scenario.personas.flatMap((p) => p.withheld)) {
        expect(w.askCues.length, `${id}/${w.id}`).toBeGreaterThan(0);
      }
    }
  });
});
