// rubric-v7: the judge reads a conversation record (message counts per
// stakeholder and the kept-back points shared), a criterion about what a
// stakeholder said is capped when the learner never messaged them, and a
// withheld value the artifact states without the trace showing it obtained
// is flagged for the instructor.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadScenario } from "@/lib/scenarios/load";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: {}, rubricModel: {} }),
  RUBRIC_TEMPERATURE: 0,
  DEFAULT_TEMPERATURE: 0.4,
  samplingParams: () => ({}),
}));

import { generateObject } from "ai";
import { groupLedger, NO_EXCHANGE_RATIONALE_NOTE, noExchangeCap, scoreSubmission } from "@/lib/agents/rubric";
import {
  countExchanges,
  renderConversationRecord,
  stageMessageCountFact,
  type ConversationRecord,
} from "@/lib/engagement/conversation-record";

const scenario = await loadScenario("customer-churn");
const mockedGenerate = vi.mocked(generateObject);

function turns(...pairs: [string, string][]) {
  return pairs.map(([personaId, stage]) => ({ type: "persona_turn", detailJson: { personaId, stage } }));
}

function record(stage: "formulation" | "testing", events: ReturnType<typeof turns>, obtained: string[] = []): ConversationRecord {
  return { stage, personas: countExchanges(scenario, events, stage), traceRecorded: true, obtainedFactIds: obtained };
}

function fullMarks(stageIndex: number) {
  return {
    object: {
      scores: scenario.stages[stageIndex].gate.rubric.map((c) => ({
        criterionId: c.id,
        score: c.maxScore,
        rationale: "Covers it.",
        improve: "",
        unverifiedClaim: false,
      })),
    },
  } as never;
}

describe("conversation record", () => {
  it("counts learner messages per stakeholder, in all and at the stage", () => {
    const r = record("testing", turns(["client", "formulation"], ["client", "testing"], ["data-owner", "data-collection"]));
    expect(r.personas.map((p) => [p.personaId, p.learnerMessages, p.learnerMessagesThisStage, p.unlocked])).toEqual([
      ["client", 2, 1, true],
      ["data-owner", 1, 0, true],
      ["end-user", 0, 0, true],
    ]);
  });

  it("writes the stage fact over the open channels", () => {
    const r = record("formulation", turns(["client", "formulation"], ["client", "formulation"]));
    expect(stageMessageCountFact(r.personas, "formulation")).toBe(
      'Messages at the "Problem formulation" stage: the consultant sent 2 to Sarah Tan (client sponsor).',
    );
  });

  it("renders counts and the shared points for the judge, or says the trace was not recorded", () => {
    const r = record("formulation", turns(["client", "formulation"]), ["offer-cost"]);
    const text = renderConversationRecord(scenario, r);
    expect(text).toContain("- Sarah Tan (client sponsor): 1 message from the consultant in all, 1 at this stage.");
    expect(text).toContain("shared with the consultant: A retention offer costs about S$30 to serve.");
    expect(text).toContain("Not shared: Finance counts a save only if the subscriber stays 6 more months.");
    expect(text).toContain("Marcus Wong (data owner): not yet reachable at this stage.");
    expect(renderConversationRecord(scenario, { ...r, traceRecorded: false })).toContain("not recorded for this run");
  });
});

describe("rubric-v7 scoring", () => {
  beforeEach(() => mockedGenerate.mockReset());

  it("caps a criterion that needs an exchange when the learner never messaged its owner", async () => {
    const testing = scenario.stages[4];
    mockedGenerate.mockResolvedValue(fullMarks(4));
    const noPriya = record("testing", turns(["client", "testing"]));
    const result = await scoreSubmission({
      scenario,
      stage: testing,
      submissionText: "Priya raised no concerns; the output is a monthly list of 6,000.",
      ledger: [],
      conversation: noPriya,
    });
    const concerns = result.scores.find((s) => s.criterionId === "concerns-captured")!;
    expect(concerns.score).toBe(noExchangeCap(5));
    expect(concerns.rawScore).toBe(5);
    expect(concerns.noExchangeCap).toBe(true);
    expect(concerns.rationale).toContain(NO_EXCHANGE_RATIONALE_NOTE);
    expect(concerns.learnerRationale).toContain(NO_EXCHANGE_RATIONALE_NOTE);
    expect(result.scores.find((s) => s.criterionId === "responsiveness")?.noExchangeCap).toBe(true);
    // output-spec does not need an exchange, so it keeps the judge's score.
    expect(result.scores.find((s) => s.criterionId === "output-spec")?.score).toBe(5);
    // The judge sees the rule and the owner line.
    const system = (mockedGenerate.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain("Needs an exchange with Priya Nair.");
    expect(system).toContain("Priya Nair (end user): 0 messages from the consultant in all, 0 at this stage.");
  });

  it("does not cap once the learner has messaged the owner", async () => {
    mockedGenerate.mockResolvedValue(fullMarks(4));
    const result = await scoreSubmission({
      scenario,
      stage: scenario.stages[4],
      submissionText: "memo",
      ledger: [],
      conversation: record("testing", turns(["end-user", "testing"])),
    });
    expect(result.scores.every((s) => !s.noExchangeCap)).toBe(true);
    expect(result.scores.find((s) => s.criterionId === "concerns-captured")?.score).toBe(5);
  });

  it("does not cap without a conversation record", async () => {
    mockedGenerate.mockResolvedValue(fullMarks(4));
    const result = await scoreSubmission({ scenario, stage: scenario.stages[4], submissionText: "memo", ledger: [] });
    expect(result.scores.find((s) => s.criterionId === "concerns-captured")?.score).toBe(5);
    expect(result.scores.every((s) => s.statedNotElicited === null)).toBe(true);
  });

  it("flags a stated withheld value that the trace does not show as obtained", async () => {
    mockedGenerate.mockResolvedValue(fullMarks(0));
    const memo = "Each offer costs S$30, and a save means the subscriber stays six more months.";
    const result = await scoreSubmission({
      scenario,
      stage: scenario.stages[0],
      submissionText: memo,
      ledger: [],
      conversation: record("formulation", turns(["client", "formulation"]), ["offer-cost"]),
    });
    expect(result.scores.find((s) => s.criterionId === "constraints")?.statedNotElicited).toEqual(["save-definition"]);
    expect(result.scores.find((s) => s.criterionId === "objective")?.statedNotElicited).toEqual([]);
    // The learner is not told.
    expect(result.scores.find((s) => s.criterionId === "constraints")?.learnerRationale).not.toContain("elicit");
  });

  it("reads elicited facts as established and detected facts as claims", () => {
    const g = groupLedger([
      { fact: "A retention offer costs about S$30 to serve.", provenance: "elicited" },
      { fact: "Sarah Tan asked whether the model could also flag customers the team could upsell.", provenance: "detected" },
    ]);
    expect(g.established).toEqual(["A retention offer costs about S$30 to serve."]);
    expect(g.claims).toEqual(["Sarah Tan asked whether the model could also flag customers the team could upsell."]);
  });
});
