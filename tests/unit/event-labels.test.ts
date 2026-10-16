import { describe, expect, it } from "vitest";
import { describeEvent, EVENT_LABELS, eventLabel } from "@/lib/admin/event-labels";

// The event log is a table with a label and a one-line summary per event,
// including the event types added in later rounds.
describe("event labels", () => {
  it.each([
    "persona_failed",
    "persona_style_retry",
    "persona_output_repair",
    "fact_elicited",
    "message_cap_reached",
    "unverified_claim_flagged",
    "analyst_step_failed",
    "client_reaction",
    "identity_question",
    "friction_raised",
    "judge_style_retry",
    "early_disclosure_flagged",
    "budget_refused",
  ])("labels %s", (type) => {
    expect(EVENT_LABELS[type]).toBeTruthy();
    expect(EVENT_LABELS[type]).not.toMatch(/_/);
  });

  it("falls back to spaced words for an unknown type", () => {
    expect(eventLabel("something_new")).toBe("something new");
  });

  it("summarises the round-2 events", () => {
    expect(
      describeEvent("persona_failed", { personaId: "sarah", stage: "formulation", kind: "turn", attempts: 2, recovered: false, errorClass: "AI_NoObjectGeneratedError", promptTokens: 2000, completionTokens: 100 }, (id) => (id === "sarah" ? "Sarah Tan" : id)),
    ).toEqual({
      label: "Persona call failed",
      stage: "Problem formulation",
      persona: "Sarah Tan",
      tokens: 2100,
      summary: "turn, 2 failed attempts, no reply (AI_NoObjectGeneratedError)",
      problem: true,
    });
    expect(describeEvent("fact_elicited", { factId: "offer-cost", persona: "sarah", learnerMessagesSoFar: 3 }).summary).toBe(
      "offer-cost after 3 learner messages",
    );
    expect(describeEvent("client_reaction", { outcome: "advanced", droppedFacts: ["x"], revealedWithheld: ["offer-cost"], styleRetry: true, audited: true }).summary).toBe(
      "advanced · 1 fact dropped · revealed offer-cost · rewritten for style · audited",
    );
    expect(describeEvent("persona_style_retry", { patterns: ["not-just"], resolved: true }).summary).toBe('used "not just"; fixed by the rewrite');
    expect(
      describeEvent("persona_output_repair", {
        repairs: [
          { call: "rewrite", kind: "nested-json", mergedFields: ["newFacts"] },
          { call: "draft", kind: "truncated-json", mergedFields: [] },
        ],
      }).summary,
    ).toBe("rewrite: nested JSON unwrapped (newFacts merged); draft: cut-off JSON stripped");
    expect(describeEvent("unverified_claim_flagged", { capped: false, criteria: [{ criterionId: "a", note: "the reported AUC of 0.91" }, { criterionId: "b", note: "the reported AUC of 0.91" }] }).summary).toBe(
      "2 criteria, score kept: the reported AUC of 0.91",
    );
    expect(describeEvent("message_cap_reached", { sent: 200, cap: 200 }).summary).toBe("200 of 200 messages sent");
    expect(describeEvent("persona_consistency", { consistent: true }).problem).toBe(false);
    expect(describeEvent("persona_consistency", { consistent: false, contradiction: "x" }).problem).toBe(true);
  });
});

describe("round-3 event summaries", () => {
  it("summarises identity, friction, judge rewrite, early disclosure and budget refusals", () => {
    expect(describeEvent("identity_question", { personaId: "sarah", outcome: "replaced" }).summary).toMatch(/replaced/);
    expect(describeEvent("friction_raised", { stage: "modelling", via: "reaction" }).summary).toBe("Modelling friction, raised in a gate reaction");
    expect(describeEvent("judge_style_retry", { criteria: [{}, {}], resolved: true }).summary).toBe("2 rationales rewritten, fixed by the rewrite");
    const early = describeEvent("early_disclosure_flagged", { factIds: ["offer-cost"] });
    expect(early.summary).toMatch(/offer-cost/);
    expect(early.problem).toBe(true);
    expect(describeEvent("budget_refused", { route: "submit", scope: "sandbox", limitUsd: 2 }).summary).toBe(
      "submit refused: the sandbox cohort's daily limit of USD 2.00 was reached",
    );
    expect(describeEvent("fact_elicited", { factId: "offer-cost", learnerMessagesSoFar: 2, verified: true }).summary).toMatch(/verified in the reply/);
  });
});
