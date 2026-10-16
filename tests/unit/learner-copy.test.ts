// Learner-facing lines shared by the result banner, the past-submission
// rows, the help panel and the chat (components/workspace/learner-copy.ts).

import { describe, expect, it } from "vitest";
import {
  adjustedLine,
  criterionScore,
  FORMATIVE_CARRY_LINE,
  GENERIC_IMPROVE,
  helpStorageLine,
  improveFor,
  JUDGE_SCORE_NOTE,
  MOCK_LINE,
  otherDeviceLine,
  pointsLine,
  REVIEWED_NOTE,
  reviewNote,
  withoutMockNote,
} from "@/components/workspace/learner-copy";

describe("learner copy", () => {
  it("uses one score format, points of max", () => {
    expect(pointsLine(16, 20)).toBe("16 of 20 points");
    expect(pointsLine(1, 1)).toBe("1 of 1 point");
    expect(criterionScore(4, 5)).toBe("4 of 5");
    expect(adjustedLine(4, 5)).toBe("Adjusted by your instructor (judge: 4 of 5)");
  });

  it("says a score is the judge's until the instructor has reviewed it", () => {
    expect(reviewNote(false)).toBe("Judge's score; your instructor may review it.");
    expect(reviewNote(undefined)).toBe(JUDGE_SCORE_NOTE);
    expect(reviewNote(true)).toBe(REVIEWED_NOTE);
    expect(REVIEWED_NOTE).toBe("Reviewed by your instructor.");
  });

  it("falls back to a generic suggestion below full marks, and none at full marks", () => {
    expect(improveFor({ score: 2, maxScore: 5, improve: "Name the save rule." })).toBe("Name the save rule.");
    expect(improveFor({ score: 2, maxScore: 5, improve: null })).toBe(GENERIC_IMPROVE);
    expect(improveFor({ score: 2, maxScore: 5, improve: "  " })).toBe(GENERIC_IMPROVE);
    expect(improveFor({ score: 5, maxScore: 5, improve: null })).toBeNull();
  });

  it("branches the device lines on the join route", () => {
    expect(otherDeviceLine("invite")).toMatch(/ask your instructor for a resume link/);
    expect(otherDeviceLine("sandbox")).toBe(
      "Your demo seat lives in this browser only: signing out or clearing this site's data ends it, and it cannot be opened on another device.",
    );
    expect(helpStorageLine("sandbox")).toMatch(/^Drafts are saved in this browser only\. Your demo seat lives in this browser only/);
    expect(helpStorageLine("sandbox")).not.toMatch(/instructor/);
    expect(helpStorageLine("invite")).toMatch(/resume link/);
  });

  it("drops the mock model's trailing note, which the channel header states once", () => {
    expect(withoutMockNote("Noted, thanks. (Demo mode: replies are canned.)")).toBe("Noted, thanks.");
    expect(withoutMockNote("No note here.")).toBe("No note here.");
    expect(MOCK_LINE).toBe("Demo mode: replies and scores are placeholders.");
  });

  it("is plain", () => {
    for (const line of [JUDGE_SCORE_NOTE, REVIEWED_NOTE, MOCK_LINE, GENERIC_IMPROVE, FORMATIVE_CARRY_LINE, helpStorageLine("sandbox"), helpStorageLine("invite")]) {
      expect(line).not.toMatch(/[—!]/);
    }
  });
});
