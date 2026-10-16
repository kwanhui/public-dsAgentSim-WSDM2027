// persona-v8: the reaction briefs no longer ask for the phrases the style
// check bans, the reply rules cover the closing ", not X" contrast,
// numbered points, announced counts and stock closers, the style check
// catches a count announced before the points, and a dropped release no
// longer keeps the data owner's acceptance of the scope ahead of the ask.
// The quoted replies are persona replies from the round-1 pre-upload review
// (showcase message ids in the comments).

import { describe, expect, it } from "vitest";
import { buildPersonaSystemPrompt, buildReactionPrompt } from "@/lib/agents/persona";
import { findStyleViolations } from "@/lib/agents/persona-style";
import {
  PERSONA_PROMPT_TEMPLATE,
  PERSONA_PROMPT_VERSION,
  PERSONA_REACTION_INSTRUCTIONS,
  PERSONA_RELEASE_ASK,
  PERSONA_REPLY_RULES,
} from "@/lib/agents/prompt-provenance";
import { withheldReleaseReply } from "@/lib/agents/release-scope";
import { loadScenario } from "@/lib/scenarios/load";

const scenario = await loadScenario("customer-churn");
const client = scenario.personas.find((p) => p.role === "client-sponsor")!;

describe("persona-v8 reaction briefs", () => {
  const briefs = Object.values(PERSONA_REACTION_INSTRUCTIONS).flat();

  it("is the current persona version", () => {
    expect(PERSONA_PROMPT_VERSION).toBe("persona-v8");
  });

  it("asks for none of the phrases the style check bans", () => {
    for (const brief of briefs) {
      expect(brief).not.toMatch(/matters most|close it out|the people above you|upstairs|before we go further/i);
      expect(findStyleViolations(brief).filter((id) => ["pseudo-cleft", "stock-closer", "not-contrast"].includes(id))).toEqual([]);
    }
  });

  it("keeps the reaction message free of a closing contrast", () => {
    const prompt = buildReactionPrompt({
      artifactKind: "problem-statement",
      stageTitle: "Problem formulation",
      submissionExcerpt: "text",
      recentTurns: [],
      outcome: "completed",
      variant: 1,
    });
    expect(prompt).toContain("Do not open with a verdict on the document.");
    expect(prompt).not.toContain("not a verdict");
    expect(prompt).not.toContain("claims, not facts");
    expect(prompt).toContain("say what you will report to your own management and the one risk you will watch");
  });
});

describe("persona-v8 reply rules", () => {
  const prompt = buildPersonaSystemPrompt({ scenario, persona: client, stage: "formulation", worldFacts: [] });

  it("forbids the closing contrast, numbered points, announced counts and stock closers", () => {
    expect(prompt).toContain('Write no ", not X" at the end of a clause');
    expect(prompt).toContain('Do not number your points or copy the consultant\'s numbering ("On (1):", "(2)")');
    expect(prompt).toContain('do not announce how many points you have ("Two things.", "One thing to flag"');
    expect(prompt).toContain('"before we go further", "before I take it upstairs" or "let\'s close this out"');
    expect(PERSONA_PROMPT_TEMPLATE).toContain(PERSONA_REPLY_RULES);
  });

  it("keeps the identity and withheld-fact sections", () => {
    expect(prompt).toContain("# If you are asked what you are");
    expect(prompt).toContain("# Things you know but keep to yourself for now");
  });
});

describe("signpost style pattern (persona-v8)", () => {
  it.each([
    "Two things. The list has to fit 6,000 slots a month.", // id 27
    "One thing to flag, the extract is a sample.", // id 62
    "A few points: the save rule is Finance's.", // id 75
    "One note: the file has a header row.", // id 88
    "One flag on granularity: subscribers can appear twice.", // id 125
    "Churn is pooled. On quirks, one to note: total_charges is text.", // id 127
    "One concern is timing.", // id 11
  ])("flags %s", (reply) => {
    expect(findStyleViolations(reply)).toContain("signpost");
  });

  it.each([
    "One row per subscriber per month, as far as I know.",
    "That report goes to the regional managers on Thursdays.",
    "Two of the four team leads will use the list.",
  ])("leaves %s alone", (reply) => {
    expect(findStyleViolations(reply)).not.toContain("signpost");
  });
});

describe("a dropped release does not acknowledge the scope and then ask for it (persona-v8)", () => {
  it("removes the acceptance sentence before the ask (showcase id 125)", () => {
    const reply = withheldReleaseReply(
      "That states purpose and fields clearly. Subscribers who changed plans mid-month appear twice.",
      ["column"],
    );
    expect(reply).toBe(`Subscribers who changed plans mid-month appear twice. ${PERSONA_RELEASE_ASK.column}`);
  });

  it("keeps a question that mentions the scope", () => {
    const reply = withheldReleaseReply("Is the purpose clear to your team? I can send it after that.", ["column"]);
    expect(reply).toContain("Is the purpose clear to your team?");
  });

  it("falls back to the full ask when nothing else is left", () => {
    expect(withheldReleaseReply("That scope works for me.", ["column", "purpose"])).toBe(PERSONA_RELEASE_ASK.both);
  });
});
