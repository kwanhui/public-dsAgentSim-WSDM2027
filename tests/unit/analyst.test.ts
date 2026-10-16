// Analyst-agent invariants: prompt containment (the agent sees only what a
// human learner sees), grounding (dataset profiles are deterministic and the
// grounding rule is present), and the deterministic CSV profiler itself.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { profileCsv, renderProfile } from "@/lib/agents/dataset-profile";
import {
  ANALYST_MAX_MESSAGES_PER_STAGE,
  ANALYST_PROMPT_VERSION,
  AnalystActionSchema,
  buildAnalystSystemPrompt,
} from "@/lib/agents/analyst";
import { loadScenario } from "@/lib/scenarios/load";

describe("dataset profiler", () => {
  const csv = readFileSync(resolve(process.cwd(), "datasets/customer-churn/churn_extract.csv"), "utf8");

  it("profiles the churn extract deterministically", () => {
    const p1 = profileCsv("churn_extract.csv", csv);
    const p2 = profileCsv("churn_extract.csv", csv);
    expect(p1).toEqual(p2);
    expect(p1.rows).toBe(8170);
    expect(p1.columns.length).toBeGreaterThan(5);
    const tenure = p1.columns.find((c) => c.name === "tenure_months");
    expect(tenure?.kind).toBe("numeric");
    expect(tenure?.min).toBeDefined();
    expect(tenure?.max).toBeDefined();
  });

  it("renders profiles with row counts and per-column stats", () => {
    const p = profileCsv("churn_extract.csv", csv);
    const text = renderProfile(p);
    expect(text).toContain("churn_extract.csv: 8170 rows");
    expect(text).toMatch(/tenure_months: numeric \(min \d/);
  });

  it("counts missing values and duplicate rows", () => {
    const p = profileCsv(
      "t.csv",
      ["a,b", "1,x", "1,x", ",y", "2,"].join("\n"),
    );
    expect(p.rows).toBe(4);
    expect(p.duplicateRows).toBe(1);
    expect(p.columns.find((c) => c.name === "a")?.missing).toBe(1);
    expect(p.columns.find((c) => c.name === "b")?.missing).toBe(1);
  });
});

describe("analyst prompt containment", () => {
  // buildAnalystSystemPrompt is deliberately pure and receives no persona
  // cards, world facts, or data dictionaries. Build the full prompt for every
  // stage of the shipped scenario and assert the hidden material never
  // appears in it.
  it("the analyst system prompt never contains persona-card or dictionary text", async () => {
    const scenario = await loadScenario("customer-churn");
    for (const stage of scenario.stages) {
      const system = buildAnalystSystemPrompt({
        scenario,
        stageId: stage.id,
        channels: scenario.personas.map((p) => ({ personaId: p.id, unlocked: true })),
        transcripts: scenario.personas.map((p) => ({
          personaId: p.id,
          lines: [{ sender: "learner", content: "hello" }],
        })),
        profilesText: "",
        turnsUsed: 1,
      });

      for (const persona of scenario.personas) {
        const cardLines = persona.card
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 40);
        expect(cardLines.length).toBeGreaterThan(0);
        for (const line of cardLines) {
          expect(system).not.toContain(line);
        }
      }
      for (const dataset of scenario.datasets) {
        const dictLines = dataset.dictionary
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 40);
        for (const line of dictLines) {
          expect(system).not.toContain(line);
        }
      }
      // The learner-visible essentials are present.
      expect(system).toContain(stage.gate.kind);
      expect(system).toContain("Grounding rules");
    }
  });

  it("tells the analyst to submit once the turn cap is reached", async () => {
    const scenario = await loadScenario("customer-churn");
    const system = buildAnalystSystemPrompt({
      scenario,
      stageId: "formulation",
      channels: [{ personaId: "client", unlocked: true }],
      transcripts: [],
      profilesText: "",
      turnsUsed: ANALYST_MAX_MESSAGES_PER_STAGE,
    });
    expect(system).toContain("MUST submit");
  });

  it("the analyst action schema rejects unknown actions and requires text", () => {
    expect(() =>
      AnalystActionSchema.parse({ reasoning: "r", action: "hack", channelPersonaId: null, text: "t" }),
    ).toThrow();
    expect(() =>
      AnalystActionSchema.parse({ reasoning: "r", action: "submit", channelPersonaId: null }),
    ).toThrow();
    const ok = AnalystActionSchema.parse({
      reasoning: "r",
      action: "message",
      channelPersonaId: "client",
      text: "hello",
    });
    expect(ok.action).toBe("message");
  });

  it("keeps a finite per-stage turn cap", () => {
    expect(ANALYST_MAX_MESSAGES_PER_STAGE).toBeGreaterThan(0);
    expect(ANALYST_MAX_MESSAGES_PER_STAGE).toBeLessThanOrEqual(10);
  });

  it("says the agent cannot compute and must mark what was not run (since analyst-v2)", async () => {
    const scenario = await loadScenario("customer-churn");
    const system = buildAnalystSystemPrompt({
      scenario,
      stageId: "modelling",
      channels: [{ personaId: "client", unlocked: true }],
      transcripts: [],
      profilesText: "- churn_extract.csv: 8170 rows",
      turnsUsed: 0,
    });
    expect(ANALYST_PROMPT_VERSION).toBe("analyst-v3");
    expect(system).toContain("You cannot run code, train models, compute metrics, split data or look at individual rows.");
    expect(system).toContain("Never report the result of a model, metric, split, test or cleaning step as if it had been computed.");
    expect(system).toContain('on a line that starts "Not run:"');
    expect(system).toContain("Use only figures that appear in the file profiles above or that a stakeholder stated in the conversations.");
    // The old framing that invited reporting outside work is gone.
    expect(system).not.toContain("result of your outside analysis");
    expect(system).not.toContain("\u2014");
    expect(system).not.toMatch(/«[^»]+»/);
  });
});
