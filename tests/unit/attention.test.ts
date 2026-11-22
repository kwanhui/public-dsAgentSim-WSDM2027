// The cohort table's "Needs attention" column: effective total, attempts at
// the current gate, and counts of the events an instructor should look at.

import { describe, expect, it } from "vitest";
import { attentionLine, engagementAttention } from "@/lib/admin/attention";

const score = (submissionId: string, s: number, max = 5, extra: object = {}) => ({
  submissionId, score: s, maxScore: max, overrideScore: null, unverifiedClaim: null, ...extra,
});

describe("engagementAttention", () => {
  it("totals the standing attempt at each stage, with overrides", () => {
    const a = engagementAttention({
      currentStage: "cleaning",
      status: "active",
      submissions: [
        { id: "s1", stage: "formulation", status: "scored", attempt: 1, assessorDirected: null },
        { id: "s2", stage: "formulation", status: "scored", attempt: 2, assessorDirected: null },
        { id: "s3", stage: "cleaning", status: "scored", attempt: 1, assessorDirected: null },
      ],
      scores: [score("s1", 1), score("s2", 4, 5, { overrideScore: 5 }), score("s3", 2, 5, { unverifiedClaim: true })],
      events: [],
    });
    expect(a.total).toEqual({ score: 7, max: 10 });
    expect(a.attemptsAtCurrentStage).toBe(1);
    expect(a.flags).toEqual({ unverified: 1 });
  });

  it("counts failures, refusals, audits, assessor text and exhausted retries", () => {
    const a = engagementAttention({
      currentStage: "modelling",
      status: "active",
      submissions: [
        { id: "s1", stage: "cleaning", status: "failed", attempt: null, assessorDirected: null },
        { id: "s2", stage: "cleaning", status: "scored", attempt: 3, assessorDirected: true },
      ],
      scores: [score("s2", 1)],
      events: [
        { type: "persona_failed", detailJson: {} },
        { type: "submission_scoring_failed", detailJson: {} },
        { type: "submission_flagged", detailJson: { submissionId: "s2" } },
        { type: "persona_consistency", detailJson: { consistent: false } },
        { type: "persona_consistency", detailJson: { consistent: true, disclosedEarly: ["offer-cost"] } },
        { type: "budget_refused", detailJson: {} },
        { type: "message_cap_reached", detailJson: {} },
        { type: "submission_scored", detailJson: { submissionId: "s2", passed: false, advanced: true } },
      ],
    });
    expect(a.flags).toEqual({
      "model-failure": 2,
      "unscored-submission": 1,
      "assessor-directed": 1,
      "audit-inconsistent": 1,
      "early-disclosure": 1,
      "budget-refused": 1,
      "message-cap": 1,
      "retries-exhausted": 1,
    });
    expect(a.flagCount).toBe(9);
    expect(attentionLine(a.flags)).toMatch(/^2 persona or judge failures, 1 submission needs rescoring/);
  });

  it("is empty for a clean run", () => {
    const a = engagementAttention({ currentStage: "formulation", status: "active", submissions: [], scores: [], events: [] });
    expect(a).toEqual({ total: null, attemptsAtCurrentStage: 0, flags: {}, flagCount: 0, allFlagCount: 0 });
    expect(attentionLine(a.flags)).toBe("");
  });
});

describe("Mark reviewed", () => {
  const T0 = "2026-09-30T01:00:00.000Z";
  const REVIEWED = "2026-09-30T02:00:00.000Z";
  const T2 = "2026-09-30T03:00:00.000Z";
  const base = {
    currentStage: "modelling",
    status: "active",
    submissions: [
      { id: "s1", stage: "cleaning", status: "scored", attempt: 1, assessorDirected: true, createdAt: T0 },
      { id: "s2", stage: "cleaning", status: "failed", attempt: null, assessorDirected: null, createdAt: T0 },
    ],
    scores: [score("s1", 2, 5, { unverifiedClaim: true, createdAt: T0 })],
    events: [
      { type: "persona_failed", detailJson: {}, timestampIso: T0 },
      { type: "persona_consistency", detailJson: { consistent: false }, timestampIso: T0 },
    ],
  };

  it("drops flags raised before the review from the filter and keeps the whole count", () => {
    const before = engagementAttention(base);
    expect(before.flagCount).toBe(5);
    const after = engagementAttention({ ...base, reviewedAt: REVIEWED });
    // The failed submission still needs rescoring: a live state, not a past flag.
    expect(after.flags).toEqual({ "unscored-submission": 1 });
    expect(after.allFlagCount).toBe(5);
  });

  it("brings the engagement back when a flag is raised after the review", () => {
    const after = engagementAttention({
      ...base,
      submissions: base.submissions.filter((s) => s.id !== "s2"),
      events: [...base.events, { type: "budget_refused", detailJson: {}, timestampIso: T2 }],
      reviewedAt: new Date(REVIEWED),
    });
    expect(after.flags).toEqual({ "budget-refused": 1 });
    expect(after.flagCount).toBe(1);
  });

  it("counts a flag with no time as new, so a missing timestamp never hides it", () => {
    const after = engagementAttention({
      ...base,
      submissions: [],
      scores: [score("s9", 1, 5, { unverifiedClaim: true })],
      events: [{ type: "message_cap_reached", detailJson: {} }],
      reviewedAt: REVIEWED,
    });
    expect(after.flags).toEqual({ unverified: 1, "message-cap": 1 });
  });

  it("formats who reviewed and when", async () => {
    const { reviewedLine } = await import("@/lib/admin/attention-review");
    expect(reviewedLine(new Date(REVIEWED), "admin")).toBe("Reviewed 2026-09-30 02:00 UTC by admin");
    expect(reviewedLine(new Date(REVIEWED), null)).toBe("Reviewed 2026-09-30 02:00 UTC");
    expect(reviewedLine(null, "admin")).toBeNull();
  });
});

describe("forced advance ledger fact", async () => {
  const { forcedAdvanceFact } = await import("@/lib/admin/force-advance");
  it("stays in-world and names the stages by title", () => {
    expect(forcedAdvanceFact("formulation", "data-collection")).toBe(
      "The client agreed to move on from Problem formulation to Data collection.",
    );
    expect(forcedAdvanceFact("deployment", null)).toMatch(/^The client agreed to close the engagement/);
    expect(forcedAdvanceFact("formulation", "data-collection")).not.toMatch(/instructor|formulation"/);
  });
});
