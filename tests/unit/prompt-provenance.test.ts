// Prompt provenance. The rubric and consistency
// prompt templates are shown read-only in the admin console; these tests pin
// the contract that keeps the displayed text honest: the builders fill the
// exact exported template constants, so executed and displayed prompts
// cannot drift apart.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
  RUBRIC_TEMPERATURE: 0,
}));
vi.mock("@/lib/engagement/state", () => ({
  logEvent: async () => {},
}));

import { generateObject } from "ai";
import {
  CONSISTENCY_PROMPT_TEMPLATE,
  CONSISTENCY_PROMPT_VERSION,
  CONSISTENCY_REPLY_TEMPLATE,
  CONSISTENCY_SYSTEM_TEMPLATE,
  fillPromptTemplate,
  RUBRIC_PROMPT_TEMPLATE,
  RUBRIC_PROMPT_VERSION,
  RUBRIC_STYLE_RETRY_SYSTEM,
  RUBRIC_STYLE_RETRY_TEMPLATE,
  RUBRIC_SUBMISSION_TEMPLATE,
  RUBRIC_SYSTEM_TEMPLATE,
  SUBMISSION_FLAGGED_EVENT,
} from "@/lib/agents/prompt-provenance";
import { auditPersonaTurn } from "@/lib/agents/consistency";
import { scoreSubmission } from "@/lib/agents/rubric";
import { loadScenario } from "@/lib/scenarios/load";

const scenario = await loadScenario("customer-churn");
const stage = scenario.stages[0];
const persona = scenario.personas[0];
const mockedGenerate = vi.mocked(generateObject);

const ENGAGEMENT = {
  id: "eng-1",
  cohortId: "cohort-1",
} as never;

describe("exported template constants", () => {
  it("exposes the full templates with readable placeholders and stable names", () => {
    expect(RUBRIC_PROMPT_VERSION).toBe("rubric-v10");
    expect(CONSISTENCY_PROMPT_VERSION).toBe("consistency-v6");
    expect(SUBMISSION_FLAGGED_EVENT).toBe("submission_flagged");

    expect(RUBRIC_PROMPT_TEMPLATE).toContain("«submission text»");
    expect(RUBRIC_PROMPT_TEMPLATE).toContain("«stakeholder claims»");
    expect(RUBRIC_PROMPT_TEMPLATE).toContain("«rubric criteria»");
    expect(CONSISTENCY_PROMPT_TEMPLATE).toContain("«persona reply»");
    expect(CONSISTENCY_PROMPT_TEMPLATE).toContain("«engagement record»");
    expect(CONSISTENCY_PROMPT_TEMPLATE).toContain("«held-back facts»");
    expect(CONSISTENCY_PROMPT_TEMPLATE).toContain("«consultant message»");
  });

  it("composes each full template from the parts the builders execute", () => {
    expect(RUBRIC_PROMPT_TEMPLATE.startsWith([RUBRIC_SYSTEM_TEMPLATE, RUBRIC_SUBMISSION_TEMPLATE].join("\n\n"))).toBe(true);
    expect(RUBRIC_PROMPT_TEMPLATE).toContain(RUBRIC_STYLE_RETRY_SYSTEM);
    expect(RUBRIC_PROMPT_TEMPLATE).toContain(RUBRIC_STYLE_RETRY_TEMPLATE);
    expect(CONSISTENCY_PROMPT_TEMPLATE).toBe(
      [CONSISTENCY_SYSTEM_TEMPLATE, CONSISTENCY_REPLY_TEMPLATE].join("\n\n"),
    );
  });
});

describe("fillPromptTemplate", () => {
  it("substitutes placeholders and rejects unwired ones", () => {
    expect(fillPromptTemplate("Reply by «persona name»:", { "persona name": "Dana" })).toBe("Reply by Dana:");
    expect(() => fillPromptTemplate("«missing»", {})).toThrow(/«missing»/);
  });

  it("does not re-scan substituted values for further placeholders", () => {
    expect(fillPromptTemplate("«a»", { a: "«b»" })).toBe("«b»");
  });
});

describe("builders execute the exported templates", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  it("the rubric judge sends the filled rubric template", async () => {
    mockedGenerate.mockResolvedValue({
      object: { scores: [] },
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);

    await scoreSubmission({
      scenario,
      stage,
      submissionText: "the submitted artifact",
      ledger: [{ fact: "The client agreed the scope is postpaid only.", provenance: "persona" }],
    });

    const call = mockedGenerate.mock.calls[0][0] as { system: string; prompt: string };
    expect(call.system).toBe(
      fillPromptTemplate(RUBRIC_SYSTEM_TEMPLATE, {
        "scenario title": scenario.title,
        "scenario task": scenario.task,
        "stage title": stage.title,
        "submission instructions": stage.gate.instructions.trim(),
        "rubric criteria": stage.gate.rubric
          .map(
            (c) =>
              `- ${c.id} (max ${c.maxScore}): ${c.criterion}\n  Learner wording: ${c.learnerText}` +
              (c.owner ? `\n  Owner: ${scenario.personas.find((p) => p.id === c.owner)!.name}.` : "") +
              (c.owner && c.requiresExchange
                ? `\n  Needs an exchange with ${scenario.personas.find((p) => p.id === c.owner)!.name}.`
                : "") +
              (c.constraints.length > 0 ? `\n  Constraints to elicit: ${c.constraints.join("; ")}.` : ""),
          )
          .join("\n"),
        "established facts": "(none)",
        "released data": "(no files released yet)",
        "stakeholder claims": "- The client agreed the scope is postpaid only.",
        "conversation record": "(not available)",
        "stakeholder transcripts": "(not available)",
        "not run statements": "(none)",
      }),
    );
    expect(call.prompt).toBe("Learner submission:\n\nthe submitted artifact");
    // Nothing unfilled reaches the model.
    expect(call.system).not.toMatch(/«[^»]+»/);
    expect(call.prompt).not.toMatch(/«[^»]+»/);
  });

  it("the consistency auditor sends the filled consistency template", async () => {
    mockedGenerate.mockResolvedValue({
      object: { consistent: true, contradiction: null },
    } as never);

    await auditPersonaTurn({
      engagement: ENGAGEMENT,
      persona,
      reply: "Happy to walk you through the numbers.",
      ledger: [{ fact: "The client agreed the scope is postpaid only.", provenance: "persona" }],
    });

    const call = mockedGenerate.mock.calls[0][0] as { system: string; prompt: string };
    expect(call.system).toBe(
      fillPromptTemplate(CONSISTENCY_SYSTEM_TEMPLATE, {
        "persona name": persona.name,
        "persona title": persona.title,
        "persona role": persona.role,
        "persona card": persona.card.trim(),
        "held-back facts": persona.withheld
          .map((w) => `- [${w.id}] ${w.fact.trim()} Condition: ${w.revealWhen.trim().replace(/\.$/, "")}.`)
          .join("\n"),
        "data dictionary": "(no data files are in play yet)",
        "release profile": "(no files released yet)",
        "engagement record": "- The client agreed the scope is postpaid only.",
      }),
    );
    expect(call.prompt).toBe(
      `The consultant's message that this reply answers:\n\n(not available)\n\nReply by ${persona.name}:\n\nHappy to walk you through the numbers.`,
    );
    expect(call.system).not.toMatch(/«[^»]+»/);
  });
});
