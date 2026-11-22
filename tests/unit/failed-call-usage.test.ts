// Usage on failed model calls: read from the AI SDK
// error, and counted by the spend guard on the failure events.

import { describe, expect, it, vi } from "vitest";
import { NoObjectGeneratedError, RetryError } from "ai";

vi.mock("@/lib/db/client", () => ({ db: {} }));

const { addUsage, isMetered, markMetered, usageFromError } = await import("@/lib/llm/usage");
const { totalsFromRows } = await import("@/lib/llm/budget");

const noObject = (promptTokens: number, completionTokens: number) =>
  new NoObjectGeneratedError({
    message: "No object generated.",
    text: "{",
    response: { id: "r", timestamp: new Date(), modelId: "m" },
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    finishReason: "length",
  });

describe("usageFromError", () => {
  it("reads the usage NoObjectGeneratedError carries", () => {
    expect(usageFromError(noObject(1200, 900))).toEqual({ promptTokens: 1200, completionTokens: 900 });
  });

  it("sums the attempts inside a RetryError", () => {
    const err = new RetryError({ message: "failed", reason: "maxRetriesExceeded", errors: [noObject(10, 1), new Error("x"), noObject(20, 2)] });
    expect(usageFromError(err)).toEqual({ promptTokens: 30, completionTokens: 3 });
  });

  it("follows a cause and gives zero for errors without usage", () => {
    expect(usageFromError(Object.assign(new Error("wrap"), { cause: noObject(5, 6) }))).toEqual({ promptTokens: 5, completionTokens: 6 });
    expect(usageFromError(new Error("network"))).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(usageFromError(null)).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it("gives zero for an error already metered, so it is not counted twice", () => {
    const err = noObject(100, 10);
    markMetered(err);
    expect(isMetered(err)).toBe(true);
    expect(usageFromError(err)).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it("adds usages", () => {
    expect(addUsage({ promptTokens: 1, completionTokens: 2 }, undefined)).toEqual({ promptTokens: 1, completionTokens: 2 });
  });
});

describe("the spend guard counts failure events", () => {
  it("prices persona_failed and analyst_step_failed on the persona side and a failed judge call on the judge side", () => {
    const totals = totalsFromRows({ prompt: 0, completion: 0 }, [
      { type: "persona_failed", prompt: 2100, completion: 1650, judgePrompt: 0, judgeCompletion: 0 },
      { type: "analyst_step_failed", prompt: 300, completion: 30, judgePrompt: 0, judgeCompletion: 0 },
      { type: "submission_scoring_failed", prompt: 0, completion: 0, judgePrompt: 4000, judgeCompletion: 500 },
      { type: "persona_consistency", prompt: 700, completion: 50, judgePrompt: 0, judgeCompletion: 0 },
    ]);
    expect(totals.persona).toEqual({ prompt: 2400, completion: 1680 });
    expect(totals.judge).toEqual({ prompt: 4700, completion: 550 });
  });
});
