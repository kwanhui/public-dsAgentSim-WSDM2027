import { describe, expect, it } from "vitest";
import { buildPersonaSystemPrompt } from "@/lib/agents/persona";
import { loadScenario } from "@/lib/scenarios/load";

const scenario = await loadScenario("customer-churn");
const client = scenario.personas.find((p) => p.role === "client-sponsor")!;
const dataOwner = scenario.personas.find((p) => p.role === "data-owner")!;
const facts = ["The consultant agreed the scope is postpaid only."];

describe("persona system prompt", () => {
  it("embeds the persona card, brief, and shared world facts", () => {
    const prompt = buildPersonaSystemPrompt({
      scenario,
      persona: client,
      stage: "formulation",
      worldFacts: facts,
    });
    expect(prompt).toContain("Sarah Tan");
    expect(prompt).toContain(scenario.brief.trim().slice(0, 60));
    expect(prompt).toContain(facts[0]);
  });

  it("never gives the client sponsor the data dictionary", () => {
    const prompt = buildPersonaSystemPrompt({
      scenario,
      persona: client,
      stage: "data-collection",
      worldFacts: facts,
    });
    expect(prompt).not.toContain("churn_extract.csv");
    expect(prompt).not.toContain("pseudonymised subscriber key");
  });

  it("tells the data owner nothing is releasable before data collection", () => {
    const prompt = buildPersonaSystemPrompt({
      scenario,
      persona: dataOwner,
      stage: "formulation",
      worldFacts: facts,
    });
    expect(prompt).toContain("None yet.");
    // The data dictionary itself must not be attached before the stage.
    expect(prompt).not.toContain("pseudonymised subscriber key");
  });

  it("names the stakeholders still out of reach, and when they arrive", () => {
    const prompt = buildPersonaSystemPrompt({
      scenario,
      persona: client,
      stage: "formulation",
      worldFacts: facts,
    });
    // Marcus and Priya (both from data collection) have no channel yet, so
    // the sponsor should defer to them rather than send the consultant off
    // to ask them now.
    expect(prompt).toContain("People the consultant cannot reach yet");
    expect(prompt).toContain("Marcus Wong");
    expect(prompt).toContain("involved once the data request is under way");
    expect(prompt).toContain("Priya Nair");
    expect(prompt).not.toContain("involved once there are model results");
    // In-world timing, not the platform's stage names.
    expect(prompt).not.toContain("joins the engagement at");
    // The speaker is never listed as out of reach from themselves.
    expect(prompt).not.toContain("Sarah Tan (VP Customer Retention");
  });

  it("drops the out-of-reach section once every stakeholder has a channel", () => {
    const prompt = buildPersonaSystemPrompt({
      scenario,
      persona: client,
      stage: "deployment",
      worldFacts: facts,
    });
    expect(prompt).not.toContain("People the consultant cannot reach yet");
  });

  it("lists only the stakeholders whose stage has not been reached", () => {
    const prompt = buildPersonaSystemPrompt({
      scenario,
      persona: dataOwner,
      stage: "cleaning",
      worldFacts: facts,
    });
    expect(prompt).toContain("Priya Nair");
    expect(prompt).not.toContain("Sarah Tan (VP");
  });

  it("gives the data owner the file and dictionary once the stage is reached", () => {
    const prompt = buildPersonaSystemPrompt({
      scenario,
      persona: dataOwner,
      stage: "data-collection",
      worldFacts: facts,
    });
    expect(prompt).toContain("churn_extract.csv");
    expect(prompt).toContain("subscriber_id");
  });
});

describe("persona-v3 reply rules", () => {
  const prompt = buildPersonaSystemPrompt({ scenario, persona: client, stage: "formulation", worldFacts: facts });

  it("asks for the question asked, in about 60 words of plain sentences", () => {
    expect(prompt).toContain("Answer the question the consultant asked, and only that.");
    expect(prompt).toContain("Keep a reply to about 60 words");
    expect(prompt).toContain("no headings, no bullet points or numbered lists");
  });

  it("bans opening evaluations, stock phrasing, em dashes and platform talk", () => {
    expect(prompt).toContain('no "Good question", "Good catch"');
    expect(prompt).toContain('Do not use "not just", "not only", "exactly", "genuinely", "honestly" or "worth flagging".');
    expect(prompt).toContain("Do not set what you mean against what you do not mean.");
    expect(prompt).toContain("Do not use em dashes or semicolons.");
    expect(prompt).toContain("Never mention stages, gates, channels, rubrics");
    expect(prompt).not.toContain("\u2014");
  });

  it("does not call the ledger a record in the persona's own instructions", () => {
    expect(prompt).toContain("# What has already been said and agreed");
    expect(prompt).not.toContain("# Shared engagement record");
  });
});

describe("withheld facts", () => {
  it("lists each kept-back fact with its condition, apart from the card", () => {
    const prompt = buildPersonaSystemPrompt({ scenario, persona: client, stage: "formulation", worldFacts: facts });
    expect(client.withheld.length).toBeGreaterThanOrEqual(2);
    expect(prompt).toContain("# Things you know but keep to yourself for now");
    expect(prompt).toContain("Share a point only when the consultant's message meets the condition");
    for (const w of client.withheld) {
      expect(prompt).toContain(w.fact);
      expect(prompt).toContain(`Share it when: ${w.revealWhen}`);
      // The fact lives in the withheld list, not in the card text.
      expect(client.card).not.toContain(w.fact);
    }
  });

  it("holds back the churn sponsor's save rule and offer cost", () => {
    const text = client.withheld.map((w) => w.fact).join(" ");
    expect(text).toContain("S$30");
    expect(text).toMatch(/save only if the subscriber stays 6 more months/);
    expect(client.card).not.toContain("S$30");
    expect(client.card).not.toMatch(/6 more months/);
    expect(client.withheld.find((w) => w.fact.includes("save"))!.revealWhen).toMatch(/Finance or the business defines a successful save/);
  });

  it("gives every persona in every scenario at least one kept-back fact", async () => {
    const { listScenarios } = await import("@/lib/scenarios/load");
    for (const { id } of await listScenarios()) {
      const s = await loadScenario(id);
      for (const p of s.personas) {
        expect(p.withheld.length, `${id}/${p.id}`).toBeGreaterThanOrEqual(1);
        for (const w of p.withheld) expect(w.revealWhen.length, `${id}/${p.id}`).toBeGreaterThan(10);
      }
    }
  });

  it("omits the section for a persona with nothing kept back", () => {
    const prompt = buildPersonaSystemPrompt({
      scenario,
      persona: { ...client, withheld: [] },
      stage: "formulation",
      worldFacts: facts,
    });
    expect(prompt).not.toContain("keep to yourself");
  });
});

describe("data owner disclosure", () => {
  it("names at most one issue on a broad question and asks about use", () => {
    const prompt = buildPersonaSystemPrompt({ scenario, persona: dataOwner, stage: "data-collection", worldFacts: facts });
    expect(prompt).toContain('When the consultant asks a broad question such as "any quirks?"');
    expect(prompt).toContain("name at most one issue, taken from the data dictionary or from the facts in your brief");
    expect(prompt).toContain("A problem that the data dictionary leaves out is one of the points you keep to yourself");
    expect(prompt).toContain("Do not say what it means for the analysis");
    expect(prompt).toContain("then ask what they plan to use the data for");
    expect(prompt).toContain("Answer a specific question about a column");
  });

  it("no longer carries the card line that personas echoed", () => {
    expect(dataOwner.card).not.toMatch(/do NOT enumerate/i);
    expect(dataOwner.card).not.toContain("unprompted");
  });

  it("is not given to the other personas", () => {
    const prompt = buildPersonaSystemPrompt({ scenario, persona: client, stage: "data-collection", worldFacts: facts });
    expect(prompt).not.toContain("# Questions about the data");
  });
});

describe("reaction briefs (persona-v4)", () => {
  it("pick a variant per engagement and stage, reproducibly and within range", async () => {
    const { pickReactionVariant, buildReactionPrompt } = await import("@/lib/agents/persona");
    const { PERSONA_REACTION_INSTRUCTIONS } = await import("@/lib/agents/prompt-provenance");
    const seen = new Set<number>();
    for (const stage of ["formulation", "data-collection", "cleaning", "modelling", "testing"]) {
      const v = pickReactionVariant("advanced", `eng-7:${stage}`);
      expect(v).toBe(pickReactionVariant("advanced", `eng-7:${stage}`));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(PERSONA_REACTION_INSTRUCTIONS.advanced.length);
      seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(1);
    const prompt = buildReactionPrompt({
      artifactKind: "final-report",
      stageTitle: "Deployment & handover",
      submissionExcerpt: "x",
      recentTurns: [],
      outcome: "completed",
      variant: 2,
    });
    expect(prompt).toContain(PERSONA_REACTION_INSTRUCTIONS.completed[2]);
    // No closing brief asks what happens next on the sponsor's side.
    for (const brief of PERSONA_REACTION_INSTRUCTIONS.completed) expect(brief).not.toContain("what happens next");
  });
});
