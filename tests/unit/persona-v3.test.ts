// persona-v3: the sincere
// identity answer, staged frictions, one owner per question, the data
// owner's scope rule, withheld ids, the reaction fact filter and the reply
// length limit.

import { describe, expect, it } from "vitest";
import {
  activeFrictions,
  buildPersonaSystemPrompt,
  buildStyleRetrySystem,
  filterReactionFacts,
  PersonaReactionSchema,
  PersonaTurnSchema,
  validRevealedIds,
} from "@/lib/agents/persona";
import { findStyleViolations } from "@/lib/agents/persona-style";
import {
  PERSONA_EXAMPLE_REPLY,
  PERSONA_IDENTITY_SENTENCE,
  PERSONA_PROMPT_VERSION,
  PERSONA_REPLY_MAX_CHARS,
} from "@/lib/agents/prompt-provenance";
import { loadScenario } from "@/lib/scenarios/load";

const scenario = await loadScenario("customer-churn");
const client = scenario.personas.find((p) => p.role === "client-sponsor")!;
const dataOwner = scenario.personas.find((p) => p.role === "data-owner")!;
const prompt = (persona = client, stage: Parameters<typeof buildPersonaSystemPrompt>[0]["stage"] = "formulation") =>
  buildPersonaSystemPrompt({ scenario, persona, stage, worldFacts: [] });

describe("persona-v8", () => {
  it("is the current persona version", () => {
    expect(PERSONA_PROMPT_VERSION).toBe("persona-v8");
  });
});

describe("sincere identity questions", () => {
  it("answers in one fixed sentence, then carries on in role", () => {
    const p = prompt();
    expect(p).toContain("# If you are asked what you are");
    expect(p).toContain(`answer truthfully in one sentence: "${PERSONA_IDENTITY_SENTENCE}"`);
    expect(p).toContain("Then carry on in role");
    expect(p).toContain("Never claim to be human, and never invent a shared history");
    expect(PERSONA_IDENTITY_SENTENCE).toBe("I'm a simulated stakeholder for this course exercise.");
  });

  it("tells banter apart from a sincere question", () => {
    expect(prompt()).toContain("Banter or a figure of speech about the work");
    expect(prompt()).toContain("is not a sincere question; answer it in character");
  });
});

describe("staged frictions", () => {
  it("keeps the sponsor's scope request out until modelling", () => {
    for (const stage of ["formulation", "data-collection", "cleaning"] as const) {
      expect(activeFrictions(client, stage)).toEqual([]);
      expect(prompt(client, stage)).not.toContain("also flag customers we could upsell");
      expect(prompt(client, stage)).not.toContain("# Pressures you bring");
    }
    for (const stage of ["modelling", "testing", "deployment"] as const) {
      expect(prompt(client, stage)).toContain("# Pressures you bring at this point in the work");
      expect(prompt(client, stage)).toContain("also flag customers we could upsell");
    }
  });
});

describe("one owner per question", () => {
  it("lists every persona's topics, with the speaker as You", () => {
    const p = prompt(client, "data-collection");
    expect(p).toContain("# Who answers what");
    expect(p).toContain("- You (client sponsor): the business goal");
    expect(p).toContain("- Marcus Wong (data owner): what is in the extract");
    expect(p).toContain("why the extract's churn rate differs from the reported figure");
    expect(p).toContain("- Priya Nair (end user):");
    expect(p).toContain("say so once and name them");
    expect(p).toContain("Do not send the consultant back and forth");
  });
});

describe("data owner scope and disclosure", () => {
  it("never drafts the scope and releases only on the learner's own statement", () => {
    const p = prompt(dataOwner, "data-collection");
    expect(p).toContain("# The scope comes from the consultant");
    expect(p).toContain("Do not propose, draft or suggest the scope yourself");
    expect(p).toContain("the purpose, the fields they need and the granularity");
    expect(p).toContain('A "yes" to wording that you offered is not a scope.');
    // The card no longer spells out the scope the data owner echoed back.
    expect(dataOwner.card).not.toContain("covering subscriber\n        attributes, usage, billing");
    expect(dataOwner.card).toContain("You never write the scope for them");
  });

  it("names the one issue on a broad question from the brief or dictionary, never a withheld point", () => {
    expect(prompt(dataOwner, "data-collection")).toContain(
      "a broad question never brings it out, only a specific question that meets its condition",
    );
  });

  it("is not shown to other personas", () => {
    expect(prompt(client, "data-collection")).not.toContain("# The scope comes from the consultant");
  });
});

describe("withheld ids and revealedWithheld", () => {
  it("prints each kept-back point with its id and asks for the id back", () => {
    const p = prompt(dataOwner, "data-collection");
    for (const w of dataOwner.withheld) expect(p).toContain(`- [${w.id}] ${w.fact}`);
    expect(p).toContain("put its id (in square brackets below) in revealedWithheld");
  });

  it("keeps only the persona's own ids, once each, in card order", () => {
    expect(validRevealedIds(dataOwner, ["usage-outage", "[duplicate-rows]", "offer-cost", "duplicate-rows"])).toEqual([
      "duplicate-rows",
    ]);
    expect(validRevealedIds(dataOwner, undefined)).toEqual([]);
  });

  it("is a field of both the turn and the reaction schema", () => {
    expect(Object.keys(PersonaTurnSchema.shape)).toContain("revealedWithheld");
    expect(Object.keys(PersonaReactionSchema.shape)).toContain("revealedWithheld");
  });
});

describe("reply length", () => {
  it("caps the reply field at the character limit", () => {
    const ok = { reply: "x".repeat(PERSONA_REPLY_MAX_CHARS), newFacts: [], revealedWithheld: [], releaseDatasets: [] };
    expect(PersonaTurnSchema.safeParse(ok).success).toBe(true);
    expect(PersonaTurnSchema.safeParse({ ...ok, reply: `${ok.reply}x` }).success).toBe(false);
    expect(PERSONA_REPLY_MAX_CHARS).toBe(450);
  });

  it("gives a neutral example reply of about 40 words that passes its own style check", () => {
    const words = PERSONA_EXAMPLE_REPLY.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(35);
    expect(words).toBeLessThanOrEqual(45);
    expect(findStyleViolations(PERSONA_EXAMPLE_REPLY)).toEqual([]);
    expect(prompt()).toContain(PERSONA_EXAMPLE_REPLY);
  });

  it("states the reply rules for length, full stops, advice, closers and follow-ups", () => {
    const p = prompt();
    expect(p).toContain("Keep a reply to about 60 words");
    expect(p).toContain("End every sentence with a full stop, or with a question mark when it asks a question. Do not join two sentences with a comma.");
    expect(p).toContain("Do not tell the consultant how to do the analysis");
    expect(p).toContain('Do not end with an instruction to the consultant such as "Send me a note once you have..."');
    expect(p).toContain("Do not promise to check something and come back later");
  });

  it("appends the draft and the broken rules for the single rewrite", () => {
    const retry = buildStyleRetrySystem("SYSTEM", "Good catch. It is fine.", 'it uses "exactly"');
    expect(retry.startsWith("SYSTEM\n\n# Rewrite your last draft")).toBe(true);
    expect(retry).toContain("Good catch. It is fine.");
    expect(retry).toContain('It broke these writing rules: it uses "exactly".');
  });
});

describe("reaction facts", () => {
  const ctx = {
    submissionText: "Our gradient-boosted model reached an AUC of 0.91 and flags 4,200 subscribers a month.",
    ledger: ["Campaign staff can handle about 6,000 offers a month."],
    persona: client,
  };

  it("keeps the sponsor's own decisions and requests", () => {
    const { kept, dropped } = filterReactionFacts(
      ["Sarah wants the list capped at 6,000 subscribers a month.", "Sarah will present the plan to the CFO."],
      ctx,
    );
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("drops a fact that repeats a figure the learner reported, or a model result", () => {
    const { kept, dropped } = filterReactionFacts(
      ["The model flags 4,200 subscribers a month.", "The consultant's AUC is strong.", "Sarah asked for reason codes."],
      ctx,
    );
    expect(kept).toEqual(["Sarah asked for reason codes."]);
    expect(dropped).toBe(2);
  });
});
