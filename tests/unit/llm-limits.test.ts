import { describe, expect, it, vi } from "vitest";
import {
  analystMaxTokens,
  auditorMaxTokens,
  judgeMaxTokens,
  MAX_TOKENS_DEFAULTS,
  personaMaxTokens,
  reactionMaxTokens,
} from "@/lib/llm/limits";
import { messageCapRefusal } from "@/lib/engagement/message-cap";

const base: NodeJS.ProcessEnv = { NODE_ENV: "test" };

describe("output-token caps", () => {
  it("have the documented defaults", () => {
    expect(personaMaxTokens(base)).toBe(900);
    expect(reactionMaxTokens(base)).toBe(700);
    expect(auditorMaxTokens(base)).toBe(200);
    expect(analystMaxTokens(base)).toBe(MAX_TOKENS_DEFAULTS.analyst);
  });

  it("size the judge to the rubric, within a bound", () => {
    expect(judgeMaxTokens(4, base)).toBe(200 + 4 * 250);
    expect(judgeMaxTokens(1, base)).toBe(450);
    expect(judgeMaxTokens(50, base)).toBe(MAX_TOKENS_DEFAULTS.judgeCap);
  });

  it("take environment overrides", () => {
    expect(personaMaxTokens({ ...base, LLM_MAX_TOKENS_PERSONA: "600" })).toBe(600);
    expect(judgeMaxTokens(4, { ...base, LLM_MAX_TOKENS_JUDGE_PER_CRITERION: "100" })).toBe(600);
    expect(judgeMaxTokens(4, { ...base, LLM_MAX_TOKENS_JUDGE_CAP: "500" })).toBe(500);
  });

  it("ignore an override that is not a positive integer", () => {
    expect(auditorMaxTokens({ ...base, LLM_MAX_TOKENS_AUDITOR: "0" })).toBe(200);
    expect(auditorMaxTokens({ ...base, LLM_MAX_TOKENS_AUDITOR: "lots" })).toBe(200);
  });
});

describe("message cap", () => {
  it("lets messages through below the cap and refuses at it", () => {
    expect(messageCapRefusal(199, 200)).toBeNull();
    expect(messageCapRefusal(200, 200)).toMatch(/limit of 200 messages/);
    expect(messageCapRefusal(200, 200)).not.toMatch(/[\u2014!]/);
  });
});

// Every model call in lib/agents passes maxTokens. The call sites mock the
// SDK in their own tests; this checks the judge, whose cap depends on the
// rubric, end to end.
vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: {}, rubricModel: {} }),
  RUBRIC_TEMPERATURE: 0,
  samplingParams: () => ({}),
  rubricModelName: () => "mock",
}));

describe("judge call", () => {
  it("passes a cap sized to the stage rubric", async () => {
    const { generateObject } = await import("ai");
    const { scoreSubmission } = await import("@/lib/agents/rubric");
    const { loadScenario } = await import("@/lib/scenarios/load");
    const scenario = await loadScenario("customer-churn");
    const stage = scenario.stages[0];
    vi.mocked(generateObject).mockResolvedValue({ object: { scores: [] } } as never);
    await scoreSubmission({ scenario, stage, submissionText: "x", ledger: [] });
    const call = vi.mocked(generateObject).mock.calls[0][0] as { maxTokens?: number };
    expect(call.maxTokens).toBe(judgeMaxTokens(stage.gate.rubric.length));
  });
});

describe("every model call site", () => {
  it("passes maxTokens", async () => {
    const { readFileSync } = await import("node:fs");
    const files = [
      "lib/agents/orchestrator.ts",
      "lib/agents/stage-gate.ts",
      "lib/agents/rubric.ts",
      "lib/agents/consistency.ts",
      "lib/agents/analyst.ts",
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const calls = (text.match(/generate(Object|Text|ObjectRobust)\(\s*\{/g) ?? []).length;
      const caps = (text.match(/maxTokens: \w+MaxTokens\(/g) ?? []).length;
      expect({ f, calls: calls > 0, capped: caps >= calls }).toEqual({ f, calls: true, capped: true });
    }
  });
});
