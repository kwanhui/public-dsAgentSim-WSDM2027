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
import { groupLedger, scoreSubmission, RUBRIC_PROMPT_VERSION, unverifiedCap } from "@/lib/agents/rubric";

const scenario = await loadScenario("customer-churn");
const stage = scenario.stages[0];
const mockedGenerate = vi.mocked(generateObject);

describe("rubric judge post-processing", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  it("clamps scores to each criterion's bounds", async () => {
    mockedGenerate.mockResolvedValue({
      object: {
        scores: stage.gate.rubric.map((c) => ({
          criterionId: c.id,
          score: 99,
          rationale: "over-enthusiastic judge",
        })),
      },
    } as never);

    const result = await scoreSubmission({
      scenario,
      stage,
      submissionText: "a submission",
      ledger: [],
    });
    for (const s of result.scores) {
      expect(s.score).toBe(s.maxScore);
    }
    expect(result.promptVersion).toBe(RUBRIC_PROMPT_VERSION);
  });

  it("fills skipped criteria with zero and flags them for review", async () => {
    mockedGenerate.mockResolvedValue({
      object: {
        scores: [
          {
            criterionId: stage.gate.rubric[0].id,
            score: 3,
            rationale: "only scored the first",
          },
        ],
      },
    } as never);

    const result = await scoreSubmission({
      scenario,
      stage,
      submissionText: "a submission",
      ledger: [],
    });
    expect(result.scores).toHaveLength(stage.gate.rubric.length);
    expect(result.scores[0].score).toBe(3);
    for (const s of result.scores.slice(1)) {
      expect(s.score).toBe(0);
      expect(s.rationale).toContain("instructor review");
    }
  });

  it("carries world facts, including released-file profiles, into the judge's context", async () => {
    mockedGenerate.mockResolvedValue({ object: { scores: [] } } as never);
    const releaseFact =
      "The released file churn_extract.csv has 6000 data rows with columns: subscriber_id, tenure_months.";

    await scoreSubmission({
      scenario,
      stage,
      submissionText: "a submission citing the 6000-row extract",
      ledger: [{ fact: releaseFact, provenance: "release-profile" }],
    });

    // The submission is judged against the engagement record, so a row count
    // the learner read off a released file must be in that record.
    const system = (mockedGenerate.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain("Engagement record");
    expect(system).toContain(releaseFact);
  });

  it("reports the criteria the judge skipped", async () => {
    mockedGenerate.mockResolvedValue({
      object: { scores: [{ criterionId: stage.gate.rubric[0].id, score: 3, rationale: "one", improve: "x", unverifiedClaim: false }] },
    } as never);
    const result = await scoreSubmission({ scenario, stage, submissionText: "s", ledger: [] });
    expect(result.skippedCriteria).toEqual(stage.gate.rubric.slice(1).map((c) => c.id));
  });

  it("scores every criterion exactly once even with duplicate judge rows", async () => {
    mockedGenerate.mockResolvedValue({
      object: {
        scores: [
          { criterionId: stage.gate.rubric[0].id, score: 2, rationale: "first" },
          { criterionId: stage.gate.rubric[0].id, score: 5, rationale: "duplicate" },
          ...stage.gate.rubric.slice(1).map((c) => ({
            criterionId: c.id,
            score: 4,
            rationale: "ok",
          })),
        ],
      },
    } as never);

    const result = await scoreSubmission({
      scenario,
      stage,
      submissionText: "a submission",
      ledger: [],
    });
    const ids = result.scores.map((s) => s.criterionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(stage.gate.rubric.map((c) => c.id));
  });
});

describe("rubric-v10 prompt", () => {
  const ledger = [
    { fact: "Meridian Mobile has roughly 480,000 postpaid subscribers.", provenance: "seed" as const },
    { fact: "The released file churn_extract.csv has 8170 data rows with columns: subscriber_id, tenure_months.", provenance: "release-profile" as const },
    { fact: "The extract is one row per subscriber.", provenance: "persona" as const },
    { fact: 'The consultant delivered the problem-statement for the "Problem formulation" stage and the engagement moved on.', provenance: "system" as const },
  ];

  beforeEach(() => mockedGenerate.mockReset());

  async function system(): Promise<string> {
    mockedGenerate.mockResolvedValue({ object: { scores: [] } } as never);
    await scoreSubmission({ scenario, stage, submissionText: "s", ledger });
    return (mockedGenerate.mock.calls[0][0] as { system: string }).system;
  }

  it("groups the ledger by provenance", () => {
    const g = groupLedger(ledger);
    expect(g.established).toEqual([ledger[0].fact, ledger[3].fact]);
    expect(g.released).toEqual([ledger[1].fact]);
    expect(g.claims).toEqual([ledger[2].fact]);
  });

  it("puts persona facts under stakeholder statements, treated as claims", async () => {
    const text = await system();
    const part1 = text.indexOf("Engagement record, part 1. Established facts");
    const part2 = text.indexOf("Engagement record, part 2. The released data");
    const part3 = text.indexOf("Engagement record, part 3. Stakeholder statements");
    expect(part1).toBeGreaterThan(0);
    expect(part2).toBeGreaterThan(part1);
    expect(part3).toBeGreaterThan(part2);
    expect(text.indexOf(ledger[0].fact)).toBeGreaterThan(part1);
    expect(text.indexOf(ledger[0].fact)).toBeLessThan(part2);
    expect(text.indexOf(ledger[1].fact)).toBeGreaterThan(part2);
    expect(text.indexOf(ledger[1].fact)).toBeLessThan(part3);
    expect(text.indexOf(ledger[2].fact)).toBeGreaterThan(part3);
    expect(text).toContain("they are claims rather than verified ground truth");
  });

  it("instructs the judge on unverified analysis, unsupported fields and unestablished facts", async () => {
    const text = await system();
    expect(text).toContain("The platform can check only the counts in part 2.");
    expect(text).toContain("the result is unverified, however plausible its numbers");
    expect(text).toContain("Set unverifiedClaim to true on every criterion whose score draws on that result in any way");
    expect(text).toContain("name the result in unverifiedNote");
    expect(text).toContain("do not lower the score for it yourself");
    expect(text).toContain("Award the maximum only when the submission covers every element that the criterion names.");
    expect(text).toContain("name the missing element in the rationale");
    expect(text).toContain("Never name a figure, a defect, a constraint or any other fact");
    expect(text).toContain("needs a column or a grain the released files do not have");
    expect(text).toContain("If that fact does not appear in the engagement record, the learner was never told it");
    expect(text).toContain("Check every statement that the submission attributes to a stakeholder");
    expect(text).not.toContain("You do not see the conversations themselves");
    expect(text).toContain("rationale: 1 to 3 plain sentences");
    expect(text).toContain('do not use "genuinely", "exactly", "honest", "honestly" or "worth flagging"');
    expect(text).not.toContain("\u2014");
  });

  it("scores elicited constraints, gives to-be-confirmed partial credit only after an exchange, treats an unraised scope change as not applicable, and fixes sentence 1", async () => {
    const text = await system();
    expect(text).toContain("Constraints to elicit.");
    expect(text).toContain(
      "Partial credit when the submission names it as unknown and says that it will be confirmed, but only when the conversation record shows that the consultant exchanged messages with the stakeholder who owns the criterion",
    );
    expect(text).toContain("score a \"to be confirmed\" constraint as left out");
    expect(text).toContain("The absence of a conversation is not the absence of concerns.");
    expect(text).toContain("Do not call its problems seeded or planted");
    expect(text).toContain("Owner: Sarah Tan.");
    expect(text).toContain("Conversation record, computed by the platform");
    expect(text).toContain("When the record shows none, the criterion is not applicable: award the maximum");
    expect(text).toContain("Sentence 1 gives the main reason for the score");
    expect(text).toContain("and do not open with praise.");
    expect(text).not.toContain("strict but fair");
    // The formulation constraints criterion lists what the learner must elicit.
    expect(text).toContain("Constraints to elicit: the cost of one retention offer (about S$30)");
  });

  it("caps a criterion flagged as resting on an unverified claim", async () => {
    mockedGenerate.mockResolvedValue({
      object: {
        scores: stage.gate.rubric.map((c, i) => ({
          criterionId: c.id,
          score: c.maxScore,
          rationale: i === 0 ? "Reports a trained model with no numbers: unverified." : "fine",
          improve: i === 0 ? "To improve: Report the confusion matrix at the chosen threshold." : "",
          unverifiedClaim: i === 0,
        })),
      },
    } as never);
    const result = await scoreSubmission({ scenario, stage, submissionText: "s", ledger, mode: "agent" });
    expect(unverifiedCap(5)).toBe(2);
    expect(result.scores[0].score).toBe(unverifiedCap(result.scores[0].maxScore));
    expect(result.scores[0].unverifiedClaim).toBe(true);
    // The UI adds the label, so a label the model wrote is dropped.
    expect(result.scores[0].improve).toBe("Report the confusion matrix at the chosen threshold.");
    // Full marks carry no improve line.
    expect(result.scores[1].score).toBe(result.scores[1].maxScore);
    expect(result.scores[1].improve).toBeNull();
  });

  it("asks for an improve line in the structured output", async () => {
    mockedGenerate.mockResolvedValue({ object: { scores: [] } } as never);
    await scoreSubmission({ scenario, stage, submissionText: "s", ledger });
    const schema = (mockedGenerate.mock.calls[0][0] as unknown as { schema: { shape: { scores: { element: { shape: Record<string, unknown> } } } } }).schema;
    expect(Object.keys(schema.shape.scores.element.shape).sort()).toEqual(
      ["criterionId", "improve", "notRun", "rationale", "score", "unverifiedClaim", "unverifiedNote"],
    );
    expect(RUBRIC_PROMPT_VERSION).toBe("rubric-v10");
  });
});

describe("scenario rubric texts (rubric-v3 review fixes)", () => {
  it("do not require card facts, unsupportable checks, or how a fact was obtained", async () => {
    const { listScenarios } = await import("@/lib/scenarios/load");
    for (const { id } of await listScenarios()) {
      const s = await loadScenario(id);
      const criteria = s.stages.flatMap((st) => st.gate.rubric.map((c) => c.criterion)).join("\n");
      // A hidden card figure as a requirement.
      expect(criteria, id).not.toMatch(/300 calls\/day|S\$30\b|S\$2\.60|S\$4\.80|two-month/);
      // A check the released columns cannot support.
      expect(criteria, id).not.toMatch(/by month\)/);
      // The judge cannot see how a fact was obtained.
      expect(criteria, id).not.toMatch(/through questioning|elicited from|raised in conversation/);
    }
  });
});
