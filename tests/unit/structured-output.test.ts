// generateObjectRobust (lib/llm/structured.ts) against a fake model in tool
// mode, the path on which claude-opus-4-8 wrapped the rubric judge's object
// in {"jsonData": ...} and the submission failed with 502.
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV1 } from "ai/test";
import { z } from "zod";
import { generateObjectRobust, STRUCTURED_RETRY_NOTE } from "@/lib/llm/structured";
import { usageFromError } from "@/lib/llm/usage";

const Schema = z.object({
  scores: z.array(z.object({ criterionId: z.string(), score: z.number().int() })),
  assessorDirected: z.object({ present: z.boolean() }).optional(),
});

const VALID = { assessorDirected: { present: false }, scores: [{ criterionId: "c1", score: 2 }] };

type Reply = { args: unknown; promptTokens: number; completionTokens: number };

// A tool-mode model that answers each call with the next reply, and records
// the system prompt it was sent.
function fakeModel(replies: Reply[]) {
  const systems: string[] = [];
  let i = 0;
  const model = new MockLanguageModelV1({
    defaultObjectGenerationMode: "tool",
    doGenerate: async ({ prompt }) => {
      const sys = prompt.find((m) => m.role === "system");
      systems.push(sys && typeof sys.content === "string" ? sys.content : "");
      const r = replies[Math.min(i++, replies.length - 1)];
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "tool-calls",
        usage: { promptTokens: r.promptTokens, completionTokens: r.completionTokens },
        toolCalls: [{ toolCallType: "function", toolCallId: `t${i}`, toolName: "json", args: JSON.stringify(r.args) }],
      };
    },
  });
  return { model, systems, calls: () => i };
}

describe("generateObjectRobust", () => {
  it("returns a valid object unchanged", async () => {
    const { model, calls } = fakeModel([{ args: VALID, promptTokens: 100, completionTokens: 20 }]);
    const r = await generateObjectRobust({ model, schema: Schema, system: "Judge.", prompt: "x" }, { callSite: "t" });
    expect(r.object).toEqual(VALID);
    expect(r.recovery).toBe("none");
    expect(r.usage).toMatchObject({ promptTokens: 100, completionTokens: 20 });
    expect(calls()).toBe(1);
  });

  it("unwraps a valid object wrapped in a single extra key, without a second call", async () => {
    const { model, calls } = fakeModel([{ args: { jsonData: VALID }, promptTokens: 1000, completionTokens: 300 }]);
    const warn = vi.fn();
    const r = await generateObjectRobust(
      { model, schema: Schema, system: "Judge.", prompt: "x" },
      { callSite: "rubric.judge", warn },
    );
    expect(r.object).toEqual(VALID);
    expect(r.recovery).toBe("unwrapped");
    expect(r.usage).toMatchObject({ promptTokens: 1000, completionTokens: 300 });
    expect(calls()).toBe(1);
    const line = JSON.parse(warn.mock.calls[0][0] as string);
    expect(line).toMatchObject({ event: "structured_unwrapped", callSite: "rubric.judge", wrapperKey: "jsonData" });
  });

  it("does not unwrap a single key whose value fails the schema", async () => {
    const { model, calls } = fakeModel([
      { args: { data: { scores: "none" } }, promptTokens: 10, completionTokens: 5 },
      { args: VALID, promptTokens: 11, completionTokens: 6 },
    ]);
    const r = await generateObjectRobust(
      { model, schema: Schema, prompt: "x" },
      { callSite: "t", warn: () => {} },
    );
    expect(r.recovery).toBe("retried");
    expect(calls()).toBe(2);
  });

  it("retries once with the unwrap note and sums the usage of both attempts", async () => {
    const { model, systems, calls } = fakeModel([
      { args: { scores: [{ criterionId: "c1" }] }, promptTokens: 1000, completionTokens: 300 },
      { args: VALID, promptTokens: 1100, completionTokens: 250 },
    ]);
    const r = await generateObjectRobust(
      { model, schema: Schema, system: "Judge.", prompt: "x" },
      { callSite: "t", warn: () => {} },
    );
    expect(r.object).toEqual(VALID);
    expect(r.recovery).toBe("retried");
    expect(r.usage).toMatchObject({ promptTokens: 2100, completionTokens: 550, totalTokens: 2650 });
    expect(calls()).toBe(2);
    expect(systems[0]).not.toContain(STRUCTURED_RETRY_NOTE);
    expect(systems[1]).toContain("Judge.");
    expect(systems[1]).toContain(STRUCTURED_RETRY_NOTE);
  });

  it("rethrows the first error with the usage of both attempts when the retry also fails", async () => {
    const bad = { scores: [{ criterionId: "c1" }] };
    const { model, calls } = fakeModel([
      { args: bad, promptTokens: 1000, completionTokens: 300 },
      { args: bad, promptTokens: 1200, completionTokens: 310 },
    ]);
    const err = await generateObjectRobust(
      { model, schema: Schema, system: "Judge.", prompt: "x" },
      { callSite: "t", warn: () => {} },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AI_NoObjectGeneratedError");
    expect(usageFromError(err)).toEqual({ promptTokens: 2200, completionTokens: 610 });
    expect(calls()).toBe(2);
  });

  it("with retry off, rethrows the first failure after one call", async () => {
    const { model, calls } = fakeModel([{ args: { scores: 1 }, promptTokens: 10, completionTokens: 5 }]);
    const err = await generateObjectRobust(
      { model, schema: Schema, prompt: "x" },
      { callSite: "persona.turn", retry: false, warn: () => {} },
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AI_NoObjectGeneratedError");
    expect(usageFromError(err)).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(calls()).toBe(1);
  });

  it("does not retry a provider error", async () => {
    let n = 0;
    const model = new MockLanguageModelV1({
      defaultObjectGenerationMode: "tool",
      doGenerate: async () => {
        n += 1;
        throw new Error("overloaded");
      },
    });
    await expect(
      generateObjectRobust({ model, schema: Schema, prompt: "x" }, { callSite: "t", warn: () => {} }),
    ).rejects.toThrow("overloaded");
    expect(n).toBe(1);
  });
});
