// scoreSubmission's optional judgeModel. getLLM() binds the rubric model once
// per process, so a caller passes an explicit model id to score with a
// different judge. Without it every call is unchanged.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadScenario } from "@/lib/scenarios/load";

const RUBRIC_STUB = { id: "deployment-rubric-model" };

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: {}, rubricModel: RUBRIC_STUB }),
  languageModelFor: (id: string) => ({ id: `explicit:${id}` }),
  RUBRIC_TEMPERATURE: 0,
  DEFAULT_TEMPERATURE: 0.4,
  samplingParams: () => ({}),
}));

import { generateObject } from "ai";
import { scoreSubmission } from "@/lib/agents/rubric";
import { rubricModelName } from "@/lib/llm/model-names";

const scenario = await loadScenario("customer-churn");
const stage = scenario.stages[0];
const mockedGenerate = vi.mocked(generateObject);

beforeEach(() => {
  mockedGenerate.mockReset().mockResolvedValue({
    object: {
      scores: stage.gate.rubric.map((c) => ({
        criterionId: c.id,
        score: 1,
        rationale: "Names the target but gives no cost figure.",
        improve: "State the cost figure.",
        unverifiedClaim: false,
      })),
    },
    usage: { promptTokens: 5, completionTokens: 2 },
  } as never);
});

describe("scoreSubmission judgeModel", () => {
  it("uses the deployment's rubric model and records its name when no judgeModel is given", async () => {
    const result = await scoreSubmission({ scenario, stage, submissionText: "a submission", ledger: [] });
    expect(mockedGenerate.mock.calls[0][0]).toMatchObject({ model: RUBRIC_STUB });
    expect(result.judgeModel).toBe(rubricModelName());
  });

  it("calls the named model and records it when judgeModel is given", async () => {
    const result = await scoreSubmission({
      scenario,
      stage,
      submissionText: "a submission",
      ledger: [],
      judgeModel: "claude-haiku-4-5",
    });
    expect(mockedGenerate.mock.calls[0][0]).toMatchObject({ model: { id: "explicit:claude-haiku-4-5" } });
    expect(result.judgeModel).toBe("claude-haiku-4-5");
  });
});
