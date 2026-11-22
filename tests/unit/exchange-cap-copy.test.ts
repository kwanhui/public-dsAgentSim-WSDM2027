import { describe, expect, it } from "vitest";
import { applyRubricVisibility } from "@/lib/engagement/rubric-visibility";
import { exchangeCapCopy } from "@/lib/engagement/gate-policy";
import { loadScenario } from "@/lib/scenarios/load";
import { toPublicScenario } from "@/lib/scenarios/public";

describe("exchange cap line in the gate box", () => {
  const personas = [
    { id: "client", name: "Sarah Tan" },
    { id: "end-user", name: "Priya Nair" },
  ];

  it("names the stakeholder and the cap for each criterion that needs an exchange", () => {
    expect(exchangeCapCopy([{ maxScore: 5, exchangeWith: "end-user" }, { maxScore: 5 }], personas)).toEqual([
      "The criterion that needs Priya Nair's input is capped at 2 of 5 if you have exchanged no messages with Priya Nair.",
    ]);
    expect(
      exchangeCapCopy(
        [
          { maxScore: 5, exchangeWith: "end-user" },
          { maxScore: 5, exchangeWith: "end-user" },
        ],
        personas,
      ),
    ).toEqual([
      "Criteria that need Priya Nair's input are capped at 2 of 5 if you have exchanged no messages with Priya Nair.",
    ]);
  });

  it("says nothing when no criterion needs an exchange", () => {
    expect(exchangeCapCopy([{ maxScore: 5 }, { maxScore: 3 }], personas)).toEqual([]);
  });

  it("reaches the learner view for the churn modelling stage", async () => {
    const view = applyRubricVisibility(toPublicScenario(await loadScenario("customer-churn")), []);
    const modelling = view.stages.find((s) => s.id === "modelling")!;
    expect(exchangeCapCopy(modelling.gate.rubric, view.personas)).toEqual([
      "The criterion that needs Priya Nair's input is capped at 2 of 5 if you have exchanged no messages with Priya Nair.",
    ]);
    const formulation = view.stages.find((s) => s.id === "formulation")!;
    expect(exchangeCapCopy(formulation.gate.rubric, view.personas)).toEqual([]);
  });
});
