// Before an artifact under the word target is submitted, the learner is
// asked to confirm, and told which attempt it will use.

import { describe, expect, it } from "vitest";
import { belowTargetNote, underTargetQuestion } from "@/components/workspace/length-check";

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const target = { min: 300, max: 600 };

describe("underTargetQuestion", () => {
  it("names the length, the target and the attempt under a hard gate", () => {
    expect(
      underTargetQuestion({ text: words(113), target, attemptsUsed: 0, minScoreRatio: 0.6, maxRetries: 2 }),
    ).toBe("This is 113 words; the target is 300 to 600. Submit anyway? It uses attempt 1 of 3.");
  });

  it("says the stage moves on under a formative gate", () => {
    expect(
      underTargetQuestion({ text: words(88), target, attemptsUsed: 1, minScoreRatio: null, maxRetries: 2 }),
    ).toMatch(/scored as it stands and the stage moves on/);
  });

  it("does not ask at or above the target, or without one", () => {
    expect(underTargetQuestion({ text: words(300), target, attemptsUsed: 0, minScoreRatio: 0.6, maxRetries: 2 })).toBeNull();
    expect(underTargetQuestion({ text: words(10), target: null, attemptsUsed: 0, minScoreRatio: 0.6, maxRetries: 2 })).toBeNull();
  });

  it("marks the counter below the target", () => {
    expect(belowTargetNote(words(10), target)).toBe("below the target");
    expect(belowTargetNote(words(400), target)).toBeNull();
  });
});
