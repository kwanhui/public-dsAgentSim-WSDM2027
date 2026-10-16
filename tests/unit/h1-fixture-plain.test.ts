// The H1 reference-run fixture after the plain-prose rewrite of 2026-10-07,
// which keeps scripted learner text free of machine-register tells: no dash
// punctuation and none of the quoted LLM-register phrases, the same message
// and artifact counts, the questions that obtained each hidden fact still
// meet its reveal condition, and the scenario patch still applies to the
// artifacts.

import { describe, expect, it } from "vitest";
import { applyPatch, DEFAULT_H1_PATCH, loadFixture, loadPatch } from "../../scripts/replay/fixture";
import { revealConditionMet } from "@/lib/agents/withheld-guard";
import { loadScenario } from "@/lib/scenarios/load";

const h1 = loadFixture("scripts/replay/fixtures/human-reference.json");
const churn = await loadScenario("customer-churn");
const fact = (id: string) => churn.personas.flatMap((p) => p.withheld).find((w) => w.id === id)!;
const step = (i: number) => h1.timeline.find((s) => s.index === i)!;

describe("H1 fixture in plain prose", () => {
  const texts = h1.timeline.map((s) => s.text ?? "");

  it("keeps 19 learner messages and six artifacts", () => {
    expect(h1.timeline.filter((s) => s.kind === "message")).toHaveLength(19);
    expect(h1.timeline.filter((s) => s.kind === "submit")).toHaveLength(6);
  });

  it.each([
    ["an em dash", /—/],
    ["an en dash", /–/],
    ["a spaced hyphen used as a dash", / - /],
    ['"honest"', /\bhonest(?:ly)?\b/i],
    ['"earns its keep"', /earns its keep/i],
    ['"died precisely for lack of"', /died precisely/i],
    ['"in the abstract: it is to decide"', /in the abstract/i],
    ["an announced count", /\b(?:two things|one more flag|one thing to flag)\b/i],
  ])("has no %s", (_label, pattern) => {
    for (const t of texts) expect(t).not.toMatch(pattern);
  });

  it("still asks the questions that obtained each hidden fact", () => {
    expect(revealConditionMet(fact("save-definition"), step(1).text!)).toBe(true);
    expect(revealConditionMet(fact("offer-cost"), step(1).text!)).toBe(true);
    expect(revealConditionMet(fact("duplicate-rows"), step(9).text!)).toBe(true);
    expect(revealConditionMet(fact("offer-levers"), step(17).text!)).toBe(true);
  });

  it("still takes the scenario patch, which brings the figures up to date", () => {
    const { timeline, applied } = applyPatch(h1, h1.timeline, loadPatch(DEFAULT_H1_PATCH).patch);
    expect(applied).toHaveLength(loadPatch(DEFAULT_H1_PATCH).patch.entries.length);
    expect(timeline.map((s) => s.text).join("\n")).toMatch(/S\$540,000 quarterly retention budget/);
  });
});
