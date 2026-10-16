// The offline mock speaks the current protocols: the reaction that opens a
// stage raises the sponsor's pressure, the judge's rationale rewrite returns
// rationale text only, and the auditor's verdict carries an empty
// early-disclosure list.

import { generateObject } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { frictionsRaisedIn } from "@/lib/agents/frictions";
import { buildPersonaSystemPrompt, buildReactionPrompt, PersonaReactionSchema } from "@/lib/agents/persona";
import { findStyleViolations } from "@/lib/agents/persona-style";
import { RUBRIC_STYLE_RETRY_SYSTEM } from "@/lib/agents/prompt-provenance";
import { createMockModel } from "@/lib/llm/mock";
import { loadScenario } from "@/lib/scenarios/load";

const scenario = await loadScenario("customer-churn");
const client = scenario.personas.find((p) => p.role === "client-sponsor")!;

describe("mock under the round-3 prompts", () => {
  it("raises the sponsor's pressure in the reaction that opens its stage", async () => {
    const { object } = await generateObject({
      model: createMockModel(),
      schema: PersonaReactionSchema,
      system: buildPersonaSystemPrompt({ scenario, persona: client, stage: "cleaning", worldFacts: [], frictionStage: "modelling" }),
      prompt: buildReactionPrompt({
        artifactKind: "cleaning-report",
        stageTitle: "Data cleaning",
        submissionExcerpt: "report",
        recentTurns: [],
        outcome: "advanced",
        raiseFriction: true,
      }),
    });
    expect(frictionsRaisedIn(object.reply, client.frictions)).toEqual(client.frictions);
    expect(findStyleViolations(object.reply)).toEqual([]);
  });

  it("does not raise it otherwise", async () => {
    const { object } = await generateObject({
      model: createMockModel(),
      schema: PersonaReactionSchema,
      system: buildPersonaSystemPrompt({ scenario, persona: client, stage: "formulation", worldFacts: [] }),
      prompt: buildReactionPrompt({
        artifactKind: "problem-statement",
        stageTitle: "Problem formulation",
        submissionExcerpt: "memo",
        recentTurns: [],
        outcome: "advanced",
      }),
    });
    expect(frictionsRaisedIn(object.reply, client.frictions)).toEqual([]);
  });

  it("rewrites flagged rationales without the flagged phrasing", async () => {
    const { object } = await generateObject({
      model: createMockModel(),
      schema: z.object({ rationales: z.array(z.object({ criterionId: z.string(), rationale: z.string() })) }),
      system: RUBRIC_STYLE_RETRY_SYSTEM,
      prompt: "Writing rules these rationales break: x.\n\n- objective: Honestly, it names the decision, not the owner.",
    });
    expect(object.rationales).toEqual([{ criterionId: "objective", rationale: "It names the decision." }]);
  });
});
