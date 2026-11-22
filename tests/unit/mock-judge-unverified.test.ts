// The offline mock judge flags a reported model metric, so the demo can show
// the instructor's unverified-result badge (rubric-v5) without an API key.
import { describe, expect, it } from "vitest";
import { generateObject } from "ai";
import { z } from "zod";
import { createMockModel } from "@/lib/llm/mock";

const schema = z.object({
  scores: z.array(
    z.object({
      criterionId: z.string(),
      score: z.number(),
      rationale: z.string(),
      improve: z.string(),
      unverifiedClaim: z.boolean(),
      unverifiedNote: z.string().optional(),
    }),
  ),
});

async function judge(submission: string) {
  const { object } = await generateObject({
    model: createMockModel(),
    schema,
    system: "Score the learner's stage-gate submission against the rubric.\n- objective (max 5): x\n- target (max 5): y",
    prompt: `Learner submission:\n\n${submission}`,
  });
  return object.scores;
}

describe("mock judge unverified flag", () => {
  it("flags a reported metric and names the whole value", async () => {
    const scores = await judge("The model reached an AUC of 0.91 on the holdout.");
    expect(scores.every((s) => s.unverifiedClaim)).toBe(true);
    expect(scores[0].unverifiedNote).toBe("the reported AUC of 0.91");
  });

  it("does not flag a plan", async () => {
    const scores = await judge("We will rank subscribers by churn risk.");
    expect(scores.every((s) => !s.unverifiedClaim)).toBe(true);
  });
});
