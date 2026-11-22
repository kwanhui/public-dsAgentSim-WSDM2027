// rubric-v4: the judge reads each
// criterion's learner wording; a capped criterion keeps its pre-cap score
// and says "unverified"; improve lines never hand over a fact the
// submission does not already contain, and below 40% they are generic.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadScenario } from "@/lib/scenarios/load";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: {}, rubricModel: {} }),
  RUBRIC_TEMPERATURE: 0,
  samplingParams: () => ({}),
}));

import { generateObject } from "ai";
import {
  formatCriterionForJudge,
  AGENT_NOT_RUN_IMPROVE,
  GENERIC_IMPROVE_LINE,
  genericImprove,
  improveFor,
  improveOwner,
  improveLeaksFact,
  scoreAfterUnverifiedRule,
  scoreSubmission,
  UNVERIFIED_RATIONALE_NOTE,
} from "@/lib/agents/rubric";

const scenario = await loadScenario("customer-churn");
const formulation = scenario.stages[0];
const dataStage = scenario.stages[1];
const mockedGenerate = vi.mocked(generateObject);

function judged(
  stage: typeof formulation,
  per: (
    id: string,
    max: number,
  ) => { score: number; rationale?: string; improve?: string; unverifiedClaim?: boolean; unverifiedNote?: string },
) {
  return {
    object: {
      scores: stage.gate.rubric.map((c) => {
        const p = per(c.id, c.maxScore);
        return {
          criterionId: c.id,
          score: p.score,
          rationale: p.rationale ?? "fine",
          improve: p.improve ?? "",
          unverifiedClaim: p.unverifiedClaim ?? false,
          ...(p.unverifiedNote ? { unverifiedNote: p.unverifiedNote } : {}),
        };
      }),
    },
  } as never;
}

describe("the judge's view of a criterion", () => {
  it("shows the full text and the learner wording, keeping the id line shape", async () => {
    const c = formulation.gate.rubric[2];
    expect(formatCriterionForJudge(c)).toBe(
      `- ${c.id} (max ${c.maxScore}): ${c.criterion}\n  Learner wording: ${c.learnerText}\n  Constraints to elicit: ${c.constraints.join("; ")}.`,
    );
    const plain = formulation.gate.rubric[0];
    expect(formatCriterionForJudge(plain)).toBe(
      `- ${plain.id} (max ${plain.maxScore}): ${plain.criterion}\n  Learner wording: ${plain.learnerText}`,
    );
    mockedGenerate.mockResolvedValue({ object: { scores: [] } } as never);
    await scoreSubmission({ scenario, stage: formulation, submissionText: "s", ledger: [] });
    const system = (mockedGenerate.mock.calls.at(-1)![0] as { system: string }).system;
    expect(system).toContain("Each criterion is followed by the wording the learner sees");
    for (const r of formulation.gate.rubric) expect(system).toContain(`Learner wording: ${r.learnerText}`);
  });
});

describe("unverified results", () => {
  beforeEach(() => mockedGenerate.mockReset());

  it("on an analyst-agent run, stores the pre-cap score, caps every flagged criterion and names it in the rationale", async () => {
    mockedGenerate.mockResolvedValue(
      judged(dataStage, (id, max) =>
        id === "quality-risks"
          ? { score: max, unverifiedClaim: true, rationale: "Cites an AUC of 0.91 the platform cannot check." }
          : id === "planned-checks"
            ? { score: 4, unverifiedClaim: true, rationale: "The reported AUC of 0.91 is unverified." }
            : { score: max },
      ),
    );
    const r = await scoreSubmission({ scenario, stage: dataStage, submissionText: "AUC 0.91", ledger: [], mode: "agent" });
    const risks = r.scores.find((s) => s.criterionId === "quality-risks")!;
    const checks = r.scores.find((s) => s.criterionId === "planned-checks")!;
    const label = r.scores.find((s) => s.criterionId === "label-understanding")!;
    expect(risks).toMatchObject({ score: 2, rawScore: 5, unverifiedClaim: true });
    expect(risks.rationale).toContain(UNVERIFIED_RATIONALE_NOTE);
    expect(checks).toMatchObject({ score: 2, rawScore: 4, unverifiedClaim: true });
    // The judge already said "unverified", so nothing is appended.
    expect(checks.rationale).toBe("The reported AUC of 0.91 is unverified.");
    expect(label).toMatchObject({ score: 5, rawScore: 5, unverifiedClaim: false, improve: null });
  });

  it("on a human run (X1), keeps the judge's score, flags the criterion and leaves the rationale alone", async () => {
    mockedGenerate.mockResolvedValue(
      judged(dataStage, (id, max) =>
        id === "quality-risks"
          ? { score: max, unverifiedClaim: true, rationale: "Ties each risk to the file.", unverifiedNote: "the reported AUC of 0.91" }
          : { score: max },
      ) as never,
    );
    for (const mode of ["human", undefined] as const) {
      const r = await scoreSubmission({ scenario, stage: dataStage, submissionText: "AUC 0.91", ledger: [], mode });
      const risks = r.scores.find((s) => s.criterionId === "quality-risks")!;
      expect(risks).toMatchObject({ score: 5, rawScore: 5, unverifiedClaim: true, unverifiedNote: "the reported AUC of 0.91" });
      // Nothing in what the learner reads says that the criterion was flagged.
      expect(risks.rationale).toBe("Ties each risk to the file.");
      expect(risks.improve).toBeNull();
      expect(r.mode).toBe("human");
    }
  });

  it("scoreAfterUnverifiedRule caps only an agent run's flagged criterion", () => {
    expect(scoreAfterUnverifiedRule({ mode: "agent", bounded: 5, maxScore: 5, unverified: true })).toEqual({ score: 2, capped: true });
    expect(scoreAfterUnverifiedRule({ mode: "agent", bounded: 5, maxScore: 5, unverified: false })).toEqual({ score: 5, capped: false });
    expect(scoreAfterUnverifiedRule({ mode: "human", bounded: 5, maxScore: 5, unverified: true })).toEqual({ score: 5, capped: false });
    expect(scoreAfterUnverifiedRule({ mode: "agent", bounded: 1, maxScore: 5, unverified: true })).toEqual({ score: 1, capped: true });
  });

  it("names the agent's unverified result in the capped rationale", async () => {
    mockedGenerate.mockResolvedValue(
      judged(dataStage, (id, max) =>
        id === "quality-risks" ? { score: max, unverifiedClaim: true, rationale: "Good.", unverifiedNote: "the reported AUC of 0.91" } : { score: max },
      ) as never,
    );
    const r = await scoreSubmission({ scenario, stage: dataStage, submissionText: "AUC 0.91", ledger: [], mode: "agent" });
    const risks = r.scores.find((s) => s.criterionId === "quality-risks")!;
    expect(risks.rationale).toBe(`Good. ${UNVERIFIED_RATIONALE_NOTE} The unverified result: the reported AUC of 0.91.`);
  });

  it("stores null rawScore for a criterion the judge skipped", async () => {
    mockedGenerate.mockResolvedValue({ object: { scores: [] } } as never);
    const r = await scoreSubmission({ scenario, stage: dataStage, submissionText: "s", ledger: [] });
    expect(r.scores.every((s) => s.rawScore === null && s.unverifiedClaim === false)).toBe(true);
  });
});

describe("improve lines", () => {
  const constraints = formulation.gate.rubric.find((c) => c.id === "constraints")!;

  it("uses the generic line at a low score only when the judge's line names a fact the submission lacks", () => {
    const line = improveFor({
      criterion: constraints,
      score: 1,
      judgeImprove: "State the offer capacity of roughly 6,000 per month and the S$540,000 budget.",
      submissionText: "It will be good.",
    });
    expect(line).toBe(genericImprove());
    expect(line).toBe(GENERIC_IMPROVE_LINE);
    // A low score keeps a judge line that names only the kind of gap.
    expect(
      improveFor({ criterion: constraints, score: 1, judgeImprove: "Name each constraint the client gave and say which are unconfirmed.", submissionText: "x" }),
    ).toBe("Name each constraint the client gave and say which are unconfirmed.");
  });

  it("does not restate the criterion wording in the generic line", () => {
    const line = genericImprove();
    expect(line).not.toMatch(/^Rework this part so that it/);
    for (const st of scenario.stages) {
      for (const c of st.gate.rubric) expect(line.toLowerCase()).not.toContain(c.learnerText.toLowerCase().replace(/\.$/, ""));
    }
  });

  it("points a low score at the stakeholder who owns the gap, by area and not by fact", () => {
    const owner = improveOwner(scenario.personas, constraints);
    expect(owner).toEqual({ name: "Sarah Tan", topic: "the business goal, the retention budget and what an offer costs" });
    const line = improveFor({ criterion: constraints, score: 1, judgeImprove: "", submissionText: "x", owner });
    expect(line).toBe(`${GENERIC_IMPROVE_LINE} Ask Sarah Tan about the business goal, the retention budget and what an offer costs.`);
    expect(line).not.toMatch(/\d/);
    // A data-stage criterion points at the data owner.
    const dataStage = scenario.stages.find((st) => st.id === "data-collection")!;
    const risks = dataStage.gate.rubric.find((c) => c.id === "quality-risks")!;
    expect(improveOwner(scenario.personas, risks)?.name).toBe("Marcus Wong");
    // A criterion the learner closes with their own work names nobody.
    const checks = dataStage.gate.rubric.find((c) => c.id === "planned-checks")!;
    expect(improveOwner(scenario.personas, checks)).toBeNull();
  });

  it("never asks for a fact the elicitation trace shows as obtained", () => {
    // The offer cost was obtained, so the owner's offer-cost area is not named.
    const owner = improveOwner(scenario.personas, constraints, ["offer-cost"]);
    expect(owner).toEqual({ name: "Sarah Tan", topic: null });
    const line = improveFor({ criterion: constraints, score: 1, judgeImprove: "", submissionText: "x", owner });
    expect(line).toBe(`${GENERIC_IMPROVE_LINE} Check it against what Sarah Tan has already told you.`);
    expect(line).not.toMatch(/offer costs?/i);
    // A fact not yet obtained still leaves the area named.
    expect(improveOwner(scenario.personas, constraints, ["save-definition"])?.topic).toBe(
      "the business goal, the retention budget and what an offer costs",
    );
  });

  it("asks an agent run's not-run criterion for what the result would change, not to run it", () => {
    const validation = scenario.stages.find((st) => st.id === "modelling")!.gate.rubric.find((c) => c.id === "validation")!;
    const judgeImprove = "Run the proposed split and cross-validation and report the fold-level metrics.";
    const agent = improveFor({ criterion: validation, score: 2, judgeImprove, submissionText: "x", mode: "agent", notRunCapped: true });
    expect(agent).toBe(AGENT_NOT_RUN_IMPROVE);
    expect(agent).not.toMatch(/\b(run|report)\b/i);
    // A learner keeps the judge's line; an uncapped agent criterion too.
    expect(improveFor({ criterion: validation, score: 2, judgeImprove, submissionText: "x", mode: "human", notRunCapped: true })).toBe(judgeImprove);
    expect(improveFor({ criterion: validation, score: 2, judgeImprove, submissionText: "x", mode: "agent", notRunCapped: false })).toBe(judgeImprove);
  });

  it("falls back to the generic line when the judge names a figure the submission lacks", () => {
    const line = improveFor({
      criterion: constraints,
      score: 3,
      judgeImprove: "State the offer capacity of roughly 6,000 per month.",
      submissionText: "We will target postpaid subscribers within the budget.",
    });
    expect(line).toBe(genericImprove());
  });

  it("keeps a judge line that names only what the submission already mentions", () => {
    const line = improveFor({
      criterion: constraints,
      score: 3,
      judgeImprove: "Say how the 6,000 monthly offers constrain the list size.",
      submissionText: "Campaign staff can make 6000 offers a month.",
    });
    expect(line).toBe("Say how the 6,000 monthly offers constrain the list size.");
  });

  it("keeps a line that names only the kind of gap", () => {
    expect(
      improveFor({
        criterion: constraints,
        score: 3,
        judgeImprove: "To improve: Quantify each data risk you list with a count from the file.",
        submissionText: "x",
      }),
    ).toBe("Quantify each data risk you list with a count from the file.");
  });

  it("is empty on full marks", () => {
    expect(improveFor({ criterion: constraints, score: 5, judgeImprove: "More.", submissionText: "x" })).toBeNull();
  });

  it("detects field names and quoted terms as facts too", () => {
    expect(improveLeaksFact("Dedupe on subscriber_id before counting.", "we remove duplicates")).toBe(true);
    expect(improveLeaksFact('Exclude the "T" accounts.', "we drop staff rows")).toBe(true);
    expect(improveLeaksFact("Name the checks for each risk.", "anything")).toBe(false);
  });

  it("reaches the stored score through scoreSubmission", async () => {
    mockedGenerate.mockResolvedValue(
      judged(formulation, (id) =>
        id === "constraints"
          ? { score: 1, improve: "State the S$30 offer cost." }
          : { score: 3, improve: "State the S$30 offer cost." },
      ),
    );
    const r = await scoreSubmission({ scenario, stage: formulation, submissionText: "A short memo.", ledger: [] });
    for (const s of r.scores) {
      const c = formulation.gate.rubric.find((x) => x.id === s.criterionId)!;
      expect(s.improve).toBe(genericImprove(improveOwner(scenario.personas, c)));
      expect(s.improve).not.toContain("S$30");
    }
  });
});

describe("rubric-v6 rationales", () => {
  beforeEach(() => mockedGenerate.mockReset());

  it("rewrites a rationale that trips the style check once, keeping every score", async () => {
    mockedGenerate
      .mockResolvedValueOnce(
        judged(formulation, (id) =>
          id === "objective"
            ? { score: 3, rationale: "Good memo. It names the decision, not the owner." }
            : { score: 4, rationale: "The statement defines the target." },
        ) as never,
      )
      .mockResolvedValueOnce({
        object: { rationales: [{ criterionId: "objective", rationale: "The memo names the decision but leaves out who owns it." }] },
        usage: { promptTokens: 7, completionTokens: 3 },
      } as never);
    const r = await scoreSubmission({ scenario, stage: formulation, submissionText: "A memo.", ledger: [] });
    const objective = r.scores.find((s) => s.criterionId === "objective")!;
    expect(objective.rationale).toBe("The memo names the decision but leaves out who owns it.");
    expect(objective.score).toBe(3);
    expect(r.scores.find((s) => s.criterionId === "target-definition")?.rationale).toBe("The statement defines the target.");
    expect(r.styleRetry).toMatchObject({
      hits: [{ criterionId: "objective", patterns: ["verdict-opener", "not-contrast"] }],
      after: [{ criterionId: "objective", patterns: [] }],
    });
    // The rewrite is a separate call with its own system message, and its
    // tokens count as judge tokens.
    expect((mockedGenerate.mock.calls[1][0] as { system: string }).system).toContain("Rewrite assessor rationales");
    expect(r.promptTokens).toBeGreaterThanOrEqual(7);
  });

  it("keeps the judge's text when the rewrite call fails", async () => {
    mockedGenerate
      .mockResolvedValueOnce(judged(formulation, () => ({ score: 3, rationale: "Honestly, the memo is thin." })) as never)
      .mockRejectedValueOnce(new Error("down"));
    const r = await scoreSubmission({ scenario, stage: formulation, submissionText: "A memo.", ledger: [] });
    expect(r.scores[0].rationale).toBe("Honestly, the memo is thin.");
    expect(r.styleRetry?.after).toBeNull();
  });

  it("makes no second call when the rationales are clean", async () => {
    mockedGenerate.mockResolvedValueOnce(judged(formulation, () => ({ score: 3, rationale: "The memo omits the owner." })) as never);
    const r = await scoreSubmission({ scenario, stage: formulation, submissionText: "A memo.", ledger: [] });
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(r.styleRetry).toBeUndefined();
  });

  it("gives the learner a copy without sentences that name a withheld fact the submission lacks", async () => {
    mockedGenerate.mockResolvedValueOnce(
      judged(formulation, (id) =>
        id === "constraints"
          ? { score: 2, rationale: "The statement omits the operating constraints. It never states the S$30 offer cost." }
          : { score: 3, rationale: "The memo omits the owner." },
      ) as never,
    );
    const r = await scoreSubmission({ scenario, stage: formulation, submissionText: "A memo about postpaid.", ledger: [] });
    const c = r.scores.find((s) => s.criterionId === "constraints")!;
    expect(c.rationale).toContain("S$30");
    expect(c.learnerRationale).toBe("The statement omits the operating constraints.");
  });
});
