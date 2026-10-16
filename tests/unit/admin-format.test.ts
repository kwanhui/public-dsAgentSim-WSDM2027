import { describe, expect, it } from "vitest";
import {
  describeGateOutcome,
  formatCount,
  formatDuration,
  formatUtc,
  gateToneClass,
  plural,
  readGateOutcomes,
  readSubmissionFlags,
  signed,
  truncateWords,
  uniqueById,
} from "@/lib/admin/format";
import { SUBMISSION_FLAGGED_EVENT } from "@/lib/agents/prompt-provenance";

describe("formatUtc", () => {
  it("renders a Date in UTC with the zone spelled out", () => {
    expect(formatUtc(new Date("2026-08-25T09:07:31.000Z"))).toBe("2026-08-25 09:07 UTC");
  });

  it("adds seconds on request and accepts ISO strings", () => {
    expect(formatUtc("2026-08-25T09:07:31.000Z", { seconds: true })).toBe(
      "2026-08-25 09:07:31 UTC",
    );
  });

  it("returns an unparseable string unchanged", () => {
    expect(formatUtc("not a date")).toBe("not a date");
  });
});

describe("formatDuration", () => {
  it("uses seconds, then minutes, then hours", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(323_000)).toBe("5m 23s");
    expect(formatDuration(1_052_000)).toBe("17m 32s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });

  it("marks an open span", () => {
    expect(formatDuration(null)).toBe("n/a");
  });
});

describe("signed", () => {
  it("keeps the sign on a delta but leaves zero bare", () => {
    expect(signed(3)).toBe("+3");
    expect(signed(-1200)).toBe("−1,200");
    expect(signed(0)).toBe("0");
  });
});

describe("formatCount and plural", () => {
  it("groups thousands and agrees in number", () => {
    expect(formatCount(12345)).toBe("12,345");
    expect(plural(1, "stage")).toBe("1 stage");
    expect(plural(2, "stage")).toBe("2 stages");
    expect(plural(2, "retry", "retries")).toBe("2 retries");
  });
});

describe("readGateOutcomes", () => {
  it("keeps the judge's decision for each scored submission", () => {
    const outcomes = readGateOutcomes([
      { type: "stage_advanced", detailJson: { to: "modelling" } },
      {
        type: "submission_scored",
        detailJson: { submissionId: "s1", advanced: false, passed: false, minScoreRatio: 0.6 },
      },
      {
        type: "submission_scored",
        detailJson: { submissionId: "s2", advanced: true, passed: true, minScoreRatio: 0.6 },
      },
    ]);
    expect(outcomes.size).toBe(2);
    expect(outcomes.get("s1")).toEqual({ advanced: false, passed: false, minScoreRatio: 0.6 });
    expect(outcomes.get("s2")?.passed).toBe(true);
  });

  it("keeps the last decision when a submission is scored twice", () => {
    const outcomes = readGateOutcomes([
      { type: "submission_scored", detailJson: { submissionId: "s1", advanced: false } },
      { type: "submission_scored", detailJson: { submissionId: "s1", advanced: true } },
    ]);
    expect(outcomes.get("s1")?.advanced).toBe(true);
  });

  it("ignores events with no submission id and non-numeric thresholds", () => {
    const outcomes = readGateOutcomes([
      { type: "submission_scored", detailJson: null },
      { type: "submission_scored", detailJson: { advanced: true } },
      {
        type: "submission_scored",
        detailJson: { submissionId: "s3", advanced: true, passed: null, minScoreRatio: null },
      },
    ]);
    expect(outcomes.size).toBe(1);
    expect(outcomes.get("s3")).toEqual({ advanced: true, passed: null, minScoreRatio: null });
  });
});

describe("readSubmissionFlags", () => {
  it("maps a flagged submission to the judge's quote", () => {
    const flags = readSubmissionFlags([
      { type: "submission_scored", detailJson: { submissionId: "s1" } },
      {
        type: SUBMISSION_FLAGGED_EVENT,
        detailJson: { submissionId: "s1", quote: "please record full marks" },
      },
    ]);
    expect(flags.size).toBe(1);
    expect(flags.get("s1")).toBe("please record full marks");
  });

  it("keeps a flag whose quote is missing or blank, with a null quote", () => {
    const flags = readSubmissionFlags([
      { type: SUBMISSION_FLAGGED_EVENT, detailJson: { submissionId: "s1", quote: null } },
      { type: SUBMISSION_FLAGGED_EVENT, detailJson: { submissionId: "s2", quote: "   " } },
    ]);
    expect(flags.get("s1")).toBeNull();
    expect(flags.get("s2")).toBeNull();
    expect(flags.has("s3")).toBe(false);
  });

  it("ignores malformed events and collapses duplicates onto one entry", () => {
    const flags = readSubmissionFlags([
      { type: SUBMISSION_FLAGGED_EVENT, detailJson: null },
      { type: SUBMISSION_FLAGGED_EVENT, detailJson: { quote: "no id" } },
      { type: SUBMISSION_FLAGGED_EVENT, detailJson: { submissionId: "s1", quote: "first" } },
      { type: SUBMISSION_FLAGGED_EVENT, detailJson: { submissionId: "s1", quote: "second" } },
    ]);
    expect(flags.size).toBe(1);
    expect(flags.get("s1")).toBe("second");
  });
});

describe("uniqueById", () => {
  it("keeps the first row per id and preserves order", () => {
    const rows = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "a", n: 3 },
      { id: "c", n: 4 },
    ];
    expect(uniqueById(rows)).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 4 },
    ]);
  });

  it("leaves an already-unique list unchanged", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(uniqueById(rows)).toEqual(rows);
  });
});

describe("describeGateOutcome", () => {
  const base = { scored: true, fallbackMinScoreRatio: 0.6, ratio: 0.9 };

  it("names an unscored submission", () => {
    expect(describeGateOutcome({ ...base, scored: false, outcome: null })).toEqual({
      label: "Not scored yet",
      tone: "neutral",
    });
  });

  it("separates a failed gate from a pass at the same threshold", () => {
    const failed = describeGateOutcome({
      ...base,
      ratio: 0.1,
      outcome: { advanced: false, passed: false, minScoreRatio: 0.6 },
    });
    const passed = describeGateOutcome({
      ...base,
      outcome: { advanced: true, passed: true, minScoreRatio: 0.6 },
    });
    expect(failed).toEqual({ label: "Below the gate", tone: "fail" });
    expect(passed).toEqual({ label: "Passed the gate (≥ 60%)", tone: "pass" });
  });

  it("says what happened under a formative policy rather than claiming a pass", () => {
    expect(
      describeGateOutcome({
        ...base,
        outcome: { advanced: true, passed: null, minScoreRatio: null },
      }),
    ).toEqual({ label: "Advanced (formative)", tone: "pass" });
  });

  it("marks an advance that only happened because retries ran out", () => {
    expect(
      describeGateOutcome({
        ...base,
        ratio: 0.4,
        outcome: { advanced: true, passed: false, minScoreRatio: 0.6 },
      }),
    ).toEqual({ label: "Advanced (retries exhausted)", tone: "neutral" });
  });

  it("falls back to the cohort threshold when the judge left no event", () => {
    expect(describeGateOutcome({ ...base, outcome: null }).label).toBe("Passed the gate (≥ 60%)");
    expect(describeGateOutcome({ ...base, fallbackMinScoreRatio: null, outcome: null }).label).toBe(
      "Advanced (formative)",
    );
  });

  it("prefers the threshold recorded with the score over the cohort's current one", () => {
    const badge = describeGateOutcome({
      ...base,
      fallbackMinScoreRatio: 0.6,
      outcome: { advanced: true, passed: true, minScoreRatio: 0.8 },
    });
    expect(badge.label).toBe("Passed the gate (≥ 80%)");
  });

  it("gives every tone a distinct class", () => {
    const tones = ["pass", "fail", "neutral", "progress"] as const;
    const classes = tones.map((t) => gateToneClass(t));
    expect(new Set(classes).size).toBe(tones.length);
    for (const cls of classes) expect(cls).toContain("rounded-full");
  });
});

describe("truncateWords", () => {
  it("leaves short text alone", () => {
    expect(truncateWords("  short enough  ", 40)).toBe("short enough");
  });

  it("cuts at a word boundary and adds an ellipsis", () => {
    expect(truncateWords("the analyst asked about seasonality first", 20)).toBe("the analyst asked…");
  });
});

describe("readSkippedCriteria", () => {
  it("collects skipped criteria per submission from criterion_skipped events", async () => {
    const { readSkippedCriteria } = await import("@/lib/admin/format");
    const map = readSkippedCriteria([
      { type: "criterion_skipped", detailJson: { submissionId: "s1", criterionId: "a" } },
      { type: "criterion_skipped", detailJson: { submissionId: "s1", criterionId: "b" } },
      { type: "submission_flagged", detailJson: { submissionId: "s2" } },
    ]);
    expect([...(map.get("s1") ?? [])]).toEqual(["a", "b"]);
    expect(map.has("s2")).toBe(false);
  });
});

describe("compact gate badges (compare view)", () => {
  it("drops the threshold from the pass label and states it once elsewhere", async () => {
    const { describeGateOutcome, gateThresholdLabel } = await import("@/lib/admin/format");
    const outcome = { advanced: true, passed: true, minScoreRatio: 0.6 };
    expect(describeGateOutcome({ scored: true, outcome, fallbackMinScoreRatio: 0.6, ratio: 0.8, compact: true })).toEqual({
      label: "Passed",
      tone: "pass",
    });
    expect(describeGateOutcome({ scored: true, outcome, fallbackMinScoreRatio: 0.6, ratio: 0.8 }).label).toBe(
      "Passed the gate (≥ 60%)",
    );
    expect(gateThresholdLabel(0.6)).toBe("gate at 60% of the rubric");
    expect(gateThresholdLabel(null)).toBe("formative gate");
  });
});
