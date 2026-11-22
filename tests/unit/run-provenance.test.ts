import { describe, expect, it } from "vitest";
import {
  analystModelFromEvents,
  analystModelLabel,
  auditorPromptFromEvents,
  judgeModelFromScores,
  judgePromptFromScores,
  meteredTokens,
  personaModelFromEvents,
  personaPromptFromEvents,
  runRubricTotal,
  splitConditions,
} from "@/lib/admin/run-provenance";

// The compare view's held-constant strip reads each run's conditions from
// the run's own rows. A run without a record reports null, never the model
// the viewing deployment is configured with.

const ev = (type: string, detailJson: unknown = {}) => ({ type, detailJson });

describe("personaModelFromEvents", () => {
  it("reads the model stamped on persona turns", () => {
    expect(
      personaModelFromEvents([ev("persona_turn", { model: "claude-sonnet-5" }), ev("stage_advanced")]),
    ).toBe("claude-sonnet-5");
  });

  it("returns null for a run whose turns carry no stamp", () => {
    expect(personaModelFromEvents([ev("persona_turn", { personaId: "client" })])).toBeNull();
    expect(personaModelFromEvents([])).toBeNull();
  });

  it("falls back to analyst events for older agent runs", () => {
    expect(
      personaModelFromEvents([
        ev("persona_turn", { personaId: "client" }),
        ev("analyst_step", { model: "claude-sonnet-5" }),
      ]),
    ).toBe("claude-sonnet-5");
  });

  it("does not read the judge model off audit events", () => {
    expect(
      personaModelFromEvents([ev("persona_consistency", { judgeModel: "claude-opus-4-8" })]),
    ).toBeNull();
  });

  it("names every model when a run used more than one", () => {
    expect(
      personaModelFromEvents([
        ev("persona_turn", { model: "b-model" }),
        ev("persona_turn", { model: "a-model" }),
      ]),
    ).toBe("a-model + b-model");
  });
});

describe("analystModelFromEvents", () => {
  it("reads the model on analyst_run_started", () => {
    expect(
      analystModelFromEvents([
        ev("analyst_run_started", { model: "claude-haiku-4-5", modelOverride: "claude-haiku-4-5" }),
        ev("persona_turn", { model: "claude-sonnet-5" }),
      ]),
    ).toBe("claude-haiku-4-5");
  });

  it("falls back to the analyst steps, and is null without analyst events", () => {
    expect(analystModelFromEvents([ev("analyst_step", { model: "claude-sonnet-5" })])).toBe("claude-sonnet-5");
    expect(analystModelFromEvents([ev("persona_turn", { model: "claude-sonnet-5" })])).toBeNull();
  });

  it("puts two agent runs on different analyst models under differs", () => {
    const left = analystModelFromEvents([ev("analyst_run_started", { model: "claude-sonnet-5" })]);
    const right = analystModelFromEvents([ev("analyst_run_started", { model: "claude-haiku-4-5" })]);
    const split = splitConditions([{ label: "Analyst model", left, right }]);
    expect(split.same).toEqual([]);
    expect(split.differ.map((p) => p.label)).toEqual(["Analyst model"]);
  });

  it("labels a run without an analyst as none", () => {
    expect(analystModelLabel({ isAgent: false, analystModel: null })).toBe("none (not an agent run)");
    expect(analystModelLabel({ isAgent: true, analystModel: null })).toBe("not recorded");
    expect(analystModelLabel({ isAgent: true, analystModel: "claude-sonnet-5" })).toBe("claude-sonnet-5");
  });
});

describe("judge and auditor prompt versions", () => {
  it("reads the rubric prompt and judge model from the scores", () => {
    const scores = [
      { promptVersion: "rubric-v1", judgeModel: "claude-opus-4-8" },
      { promptVersion: "rubric-v1", judgeModel: "claude-opus-4-8" },
    ];
    expect(judgePromptFromScores(scores)).toBe("rubric-v1");
    expect(judgeModelFromScores(scores)).toBe("claude-opus-4-8");
    expect(judgePromptFromScores([])).toBeNull();
  });

  it("reads the auditor prompt from consistency events only", () => {
    expect(
      auditorPromptFromEvents([
        ev("persona_consistency", { promptVersion: "consistency-v2" }),
        ev("submission_scored", { promptVersion: "rubric-v2" }),
      ]),
    ).toBe("consistency-v2");
    expect(auditorPromptFromEvents([ev("persona_turn")])).toBeNull();
  });

  it("reads the persona prompt from persona turns and client reactions", () => {
    expect(
      personaPromptFromEvents([
        ev("persona_turn", { promptVersion: "persona-v2" }),
        ev("client_reaction", { promptVersion: "persona-v2" }),
        ev("persona_consistency", { promptVersion: "consistency-v3" }),
      ]),
    ).toBe("persona-v2");
    // Older turns carry no version.
    expect(personaPromptFromEvents([ev("persona_turn", { model: "m" })])).toBeNull();
  });
});

describe("meteredTokens", () => {
  it("adds every message and every metered event, with no stage window", () => {
    const messages = [
      { promptTokens: 100, completionTokens: 20 },
      { promptTokens: 0, completionTokens: 0 },
    ];
    const events = [
      ev("analyst_step", { promptTokens: 50, completionTokens: 5 }),
      ev("submission_scored", { judgePromptTokens: 300, judgeCompletionTokens: 30 }),
      ev("stage_advanced", { to: "collection" }),
    ];
    expect(meteredTokens(messages, events)).toBe(505);
  });
});

describe("runRubricTotal", () => {
  it("sums the latest scored submission of each stage, overrides applied", () => {
    const submissions = [
      { id: "s1", stage: "formulation", createdAt: "2026-08-01T00:00:00Z" },
      { id: "s2", stage: "formulation", createdAt: "2026-08-01T01:00:00Z" },
      { id: "s3", stage: "collection", createdAt: "2026-08-01T02:00:00Z" },
      { id: "s4", stage: "cleaning", createdAt: "2026-08-01T03:00:00Z" },
    ];
    const row = (submissionId: string, score: number, overrideScore: number | null = null) => ({
      submissionId,
      score,
      maxScore: 5,
      overrideScore,
    });
    const scores = [row("s1", 1), row("s1", 1), row("s2", 4), row("s2", 5), row("s3", 3, 2)];
    // s4 has no scores (judge failed) and does not count.
    expect(runRubricTotal(submissions, scores)).toEqual({ score: 11, max: 15 });
  });
});

describe("splitConditions", () => {
  it("keeps a missing record apart from a real difference", () => {
    const split = splitConditions([
      { label: "Scenario", left: "Churn", right: "Churn" },
      { label: "Judge prompt", left: "rubric-v1", right: "rubric-v2" },
      { label: "Persona model", left: "claude-sonnet-5", right: null },
    ]);
    expect(split.same).toEqual([{ label: "Scenario", value: "Churn" }]);
    expect(split.differ.map((p) => p.label)).toEqual(["Judge prompt"]);
    expect(split.unrecorded.map((p) => p.label)).toEqual(["Persona model"]);
  });
});
