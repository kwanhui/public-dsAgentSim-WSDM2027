// The end user's failed testing-stage turns in both round-5 agent runs
// (persona_failed, AI_NoObjectGeneratedError "response did not match
// schema", two attempts each). Priya's first testing replies ran past the
// 450-character reply limit, and the model closed the structured output
// after the reply without the required newFacts and releaseDatasets arrays.
// The round-2 server log holds a failed persona turn of this shape. The
// repair hook cut the reply but left the object invalid, so both attempts
// failed. The hook now also fills a missing array with an empty list.
//
// Run against the AI SDK's mock model in tool mode (the provider path the
// runs used) with the real generateObject, the persona schema and the
// end user's testing-stage prompt.

import { describe, expect, it } from "vitest";
import { MockLanguageModelV1 } from "ai/test";
import { buildPersonaSystemPrompt, PersonaReactionSchema, PersonaTurnSchema } from "@/lib/agents/persona";
import { replyLengthRepair } from "@/lib/agents/persona-style";
import { PERSONA_REPLY_MAX_CHARS } from "@/lib/agents/prompt-provenance";
import { generateObjectRobust, isNoObjectGeneratedError } from "@/lib/llm/structured";
import { loadScenario } from "@/lib/scenarios/load";

const scenario = await loadScenario("customer-churn");
const endUser = scenario.personas.find((p) => p.role === "end-user")!;

// A reply in Priya's voice, longer than the reply limit.
const LONG_REPLY =
  "My team works from phone calls only, about 300 a day across the four of us. A rank on its own does not help me. I need a plain reason on each row, because the script changes for a price complaint, a network complaint or a contract that is about to end. I also need to know how fresh the scores are. Half of the last agency's top risks had just renewed when we called them. Can each row say when its score was last refreshed, and can the list stay at a size my team can work through in a week?";

function toolModel(args: unknown) {
  const systems: string[] = [];
  const model = new MockLanguageModelV1({
    defaultObjectGenerationMode: "tool",
    doGenerate: async ({ prompt }) => {
      const sys = prompt.find((m) => m.role === "system");
      systems.push(sys && typeof sys.content === "string" ? sys.content : "");
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "tool-calls",
        usage: { promptTokens: 5400, completionTokens: 180 },
        toolCalls: [{ toolCallType: "function", toolCallId: "t1", toolName: "json", args: JSON.stringify(args) }],
      };
    },
  });
  return { model, systems };
}

const system = buildPersonaSystemPrompt({ scenario, persona: endUser, stage: "testing", worldFacts: [] });
const messages = [{ role: "user" as const, content: "Here is the proposed output shape. What does your team need on each row?" }];

describe("the end user's testing-stage turn (round-5 persona_failed)", () => {
  it("is a long reply with the arrays left out", () => {
    expect(LONG_REPLY.length).toBeGreaterThan(PERSONA_REPLY_MAX_CHARS);
    expect(system).toContain("Priya Nair");
  });

  it("failed validation when the repair only cut the reply (the old hook's behaviour)", async () => {
    const { model } = toolModel({ reply: LONG_REPLY });
    const lengthOnly = async ({ text }: { text: string }) => {
      const parsed = JSON.parse(text) as { reply: string };
      return JSON.stringify({ ...parsed, reply: parsed.reply.slice(0, PERSONA_REPLY_MAX_CHARS) });
    };
    const err = await generateObjectRobust(
      { model, schema: PersonaTurnSchema, system, messages, experimental_repairText: lengthOnly },
      { callSite: "persona.turn", retry: false },
    ).catch((e: unknown) => e);
    expect(isNoObjectGeneratedError(err)).toBe(true);
    expect((err as Error).message).toBe("No object generated: response did not match schema.");
  });

  it("now validates: the reply is cut and the missing arrays are empty", async () => {
    const { model } = toolModel({ reply: LONG_REPLY });
    const hook = replyLengthRepair();
    const r = await generateObjectRobust(
      { model, schema: PersonaTurnSchema, system, messages, experimental_repairText: hook.repair },
      { callSite: "persona.turn", retry: false },
    );
    expect(r.object.reply.length).toBeLessThanOrEqual(PERSONA_REPLY_MAX_CHARS);
    expect(r.object.reply.endsWith(".")).toBe(true);
    expect(r.object).toMatchObject({ newFacts: [], revealedWithheld: [], raisedFrictions: [], releaseDatasets: [] });
    // The cut reply still counts as too long, so the style rewrite runs.
    expect(hook.wasTruncated()).toBe(true);
  });

  it("validates a reply within the limit that leaves the arrays out", async () => {
    const { model } = toolModel({ reply: "Each row needs a plain reason.", newFacts: null });
    const hook = replyLengthRepair();
    const r = await generateObjectRobust(
      { model, schema: PersonaTurnSchema, system, messages, experimental_repairText: hook.repair },
      { callSite: "persona.turn", retry: false },
    );
    expect(r.object).toMatchObject({ reply: "Each row needs a plain reason.", newFacts: [], releaseDatasets: [] });
    expect(hook.wasTruncated()).toBe(false);
  });

  it("reads an array sent as a JSON string", async () => {
    const { model } = toolModel({
      reply: "We can make three kinds of offer.",
      newFacts: JSON.stringify(["The team can offer loyalty discounts."]),
      revealedWithheld: "offer-levers",
      releaseDatasets: [],
    });
    const r = await generateObjectRobust(
      { model, schema: PersonaTurnSchema, system, messages, experimental_repairText: replyLengthRepair().repair },
      { callSite: "persona.turn", retry: false },
    );
    expect(r.object.newFacts).toEqual(["The team can offer loyalty discounts."]);
    expect(r.object.revealedWithheld).toEqual(["offer-levers"]);
  });

  it("repairs the reaction schema the same way", async () => {
    const { model } = toolModel({ reply: LONG_REPLY });
    const r = await generateObjectRobust(
      { model, schema: PersonaReactionSchema, system, prompt: "React.", experimental_repairText: replyLengthRepair().repair },
      { callSite: "persona.reaction", retry: false },
    );
    expect(r.object).toMatchObject({ newFacts: [], revealedWithheld: [], raisedFrictions: [] });
  });
});
