// The offline mock provider must keep producing schema-valid persona
// output under persona-v3 (revealedWithheld, the reply length limit), and it
// exercises the identity answer and the elicitation trace offline.

import { generateObject } from "ai";
import { describe, expect, it } from "vitest";
import { buildPersonaSystemPrompt, PersonaReactionSchema, PersonaTurnSchema } from "@/lib/agents/persona";
import { findStyleViolations } from "@/lib/agents/persona-style";
import { PERSONA_IDENTITY_SENTENCE } from "@/lib/agents/prompt-provenance";
import { createMockModel } from "@/lib/llm/mock";
import { loadScenario } from "@/lib/scenarios/load";

const scenario = await loadScenario("customer-churn");
const client = scenario.personas.find((p) => p.role === "client-sponsor")!;
const dataOwner = scenario.personas.find((p) => p.role === "data-owner")!;

async function turn(persona: typeof client, stage: "formulation" | "data-collection", text: string) {
  const { object } = await generateObject({
    model: createMockModel(),
    schema: PersonaTurnSchema,
    system: buildPersonaSystemPrompt({ scenario, persona, stage, worldFacts: [] }),
    messages: [{ role: "user", content: text }],
  });
  return object;
}

describe("mock persona under persona-v3", () => {
  it("returns schema-valid, style-clean replies", async () => {
    for (const [persona, stage, text] of [
      [client, "formulation", "What decision should this support?"],
      [dataOwner, "data-collection", "I need the subscriber extract for the retention analysis, one row per subscriber."],
      [dataOwner, "data-collection", "Hello"],
    ] as const) {
      const o = await turn(persona, stage, text);
      expect(o.revealedWithheld).toEqual([]);
      expect(findStyleViolations(o.reply), o.reply).toEqual([]);
    }
  });

  it("answers a sincere identity question with the fixed sentence", async () => {
    const o = await turn(client, "formulation", "Honest question: am I talking to a real person or an AI system?");
    expect(o.reply.startsWith(PERSONA_IDENTITY_SENTENCE)).toBe(true);
  });

  it("reveals a withheld fact on a matching question and reports its id", async () => {
    const o = await turn(dataOwner, "data-collection", "Are there duplicate rows for the same subscriber?");
    expect(o.revealedWithheld).toEqual(["duplicate-rows"]);
    expect(o.reply).toContain("double-counts subscribers");
  });

  it("returns a schema-valid gate reaction", async () => {
    const { object } = await generateObject({
      model: createMockModel(),
      schema: PersonaReactionSchema,
      system: buildPersonaSystemPrompt({ scenario, persona: client, stage: "formulation", worldFacts: [] }),
      prompt: "The consultant has just sent you their problem statement for problem formulation. Here it is:",
    });
    expect(object.revealedWithheld).toEqual([]);
    expect(findStyleViolations(object.reply)).toEqual([]);
  });
});
