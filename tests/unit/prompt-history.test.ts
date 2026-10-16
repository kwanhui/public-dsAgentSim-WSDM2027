// Prompt version history. Scores and audit verdicts
// store a prompt version string; every released version's text is kept so
// the string can be resolved to the prompt that produced it. The v1 texts
// were recovered from git history (rubric.ts at 4ab86cb..23ac994^,
// consistency.ts at e7753fe..bec7b59^) and must not change.

import { describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const logEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock("ai", () => ({ generateObject: (...a: unknown[]) => generateObject(...a) }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "p", rubricModel: "r" }),
  samplingParams: () => ({}),
  RUBRIC_TEMPERATURE: 0,
}));
vi.mock("@/lib/engagement/state", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

const {
  CONSISTENCY_PROMPT_TEMPLATE,
  CONSISTENCY_PROMPT_VERSION,
  PROMPT_HISTORY,
  RUBRIC_PROMPT_TEMPLATE,
  RUBRIC_PROMPT_VERSION,
  promptVersionRecord,
} = await import("@/lib/agents/prompt-provenance");
const { scoreSubmission } = await import("@/lib/agents/rubric");
const { auditPersonaTurn } = await import("@/lib/agents/consistency");
const { loadScenario } = await import("@/lib/scenarios/load");

const scenario = await loadScenario("customer-churn");

const placeholders = (t: string) => [...t.matchAll(/«([^«»]+)»/g)].map((m) => m[1]).sort();

describe("PROMPT_HISTORY", () => {
  it("lists each version once, with exactly one current version per role", () => {
    const ids = PROMPT_HISTORY.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const role of ["rubric-judge", "consistency-auditor", "persona", "analyst-agent"] as const) {
      expect(PROMPT_HISTORY.filter((v) => v.role === role && v.current).length).toBe(1);
    }
  });

  it("marks the executed templates as current", () => {
    expect(promptVersionRecord(RUBRIC_PROMPT_VERSION)).toMatchObject({
      current: true,
      template: RUBRIC_PROMPT_TEMPLATE,
    });
    expect(promptVersionRecord(CONSISTENCY_PROMPT_VERSION)).toMatchObject({
      current: true,
      template: CONSISTENCY_PROMPT_TEMPLATE,
    });
  });

  it("keeps the versions the showcase scores and verdicts carry", () => {
    for (const id of ["rubric-v1", "rubric-v2", "consistency-v1", "consistency-v2", "persona-v1", "analyst-v1"]) {
      expect(promptVersionRecord(id)?.template.length).toBeGreaterThan(100);
    }
    expect(promptVersionRecord("rubric-v11")).toBeNull();
  });

  it("holds the recovered rubric-v1 text: v2 without the assessor-directed paragraph", () => {
    const v1 = promptVersionRecord("rubric-v1")!.template;
    expect(v1).not.toContain("assessorDirected");
    expect(v1).toContain("Score every rubric criterion exactly once. Do not invent criteria.");
    expect(v1).toContain("Learner submission:\n\n«submission text»");
    expect(placeholders(v1)).toEqual(placeholders(promptVersionRecord("rubric-v2")!.template));
  });

  it("keeps rubric-v2 with its single engagement record, and v3 splits it by provenance", () => {
    const v2 = promptVersionRecord("rubric-v2")!.template;
    expect(v2).toContain("assessorDirected");
    expect(placeholders(v2)).toContain("engagement record");
    expect(placeholders(RUBRIC_PROMPT_TEMPLATE)).toEqual(
      expect.arrayContaining(["established facts", "released data", "stakeholder claims"]),
    );
    expect(placeholders(RUBRIC_PROMPT_TEMPLATE)).not.toContain("engagement record");
  });

  it("holds the recovered consistency-v1 text: v2 without the data-quirk sentence", () => {
    const v1 = promptVersionRecord("consistency-v1")!.template;
    const v2 = promptVersionRecord("consistency-v2")!.template;
    expect(v1).toContain("Terse or unhelpful replies are still consistent if in character.");
    expect(v1).not.toContain("known quirks");
    expect(v2).toContain("known quirks");
    expect(placeholders(v1)).toEqual(placeholders(v2));
  });

  it("gives consistency-v3 the card, dictionary and release profile beside the record", () => {
    for (const name of ["persona card", "data dictionary", "release profile", "engagement record"]) {
      expect(placeholders(CONSISTENCY_PROMPT_TEMPLATE)).toContain(name);
    }
    expect(placeholders(promptVersionRecord("consistency-v2")!.template)).not.toContain("persona card");
  });
});

describe("served model id", () => {
  it("is stored with the judge's scores when the provider reports one", async () => {
    generateObject.mockResolvedValueOnce({
      object: { scores: [] },
      usage: { promptTokens: 1, completionTokens: 1 },
      response: { modelId: "claude-opus-4-8-20260801" },
    });
    const result = await scoreSubmission({
      scenario,
      stage: scenario.stages[0],
      submissionText: "x",
      ledger: [],
    });
    expect(result.servedModel).toBe("claude-opus-4-8-20260801");
  });

  it("is null when the provider reports none", async () => {
    generateObject.mockResolvedValueOnce({ object: { scores: [] } });
    const result = await scoreSubmission({
      scenario,
      stage: scenario.stages[0],
      submissionText: "x",
      ledger: [],
    });
    expect(result.servedModel).toBeNull();
  });

  it("is recorded on audit verdicts with the judge model and prompt version", async () => {
    generateObject.mockResolvedValueOnce({
      object: { consistent: true, contradiction: null },
      usage: { promptTokens: 5, completionTokens: 1 },
      response: { modelId: "claude-opus-4-8-20260801" },
    });
    await auditPersonaTurn({
      engagement: { id: "e1", cohortId: "c1" } as never,
      persona: scenario.personas[0],
      reply: "Fine.",
      ledger: [],
    });
    const detail = logEvent.mock.calls.at(-1)?.[3] as Record<string, unknown>;
    expect(detail).toMatchObject({
      judgeModel: expect.any(String),
      servedModel: "claude-opus-4-8-20260801",
      promptVersion: CONSISTENCY_PROMPT_VERSION,
    });
    // "model" on an event means the persona model to the compare view.
    expect(detail).not.toHaveProperty("model");
  });
});

describe("current prompt versions", () => {
  it("registers each current version, keeps the previous one, and names a commit", () => {
    const current = PROMPT_HISTORY.filter((v) => v.current).map((v) => v.id).sort();
    expect(current).toEqual(["analyst-v3", "consistency-v6", "persona-v8", "rubric-v10"]);
    for (const id of [
      "analyst-v1",
      "analyst-v2",
      "consistency-v2",
      "consistency-v3",
      "consistency-v4",
      "consistency-v5",
      "persona-v1",
      "persona-v2",
      "persona-v3",
      "persona-v4",
      "persona-v5",
      "persona-v6",
      "persona-v7",
      "rubric-v2",
      "rubric-v3",
      "rubric-v4",
      "rubric-v5",
      "rubric-v6",
      "rubric-v7",
      "rubric-v8",
      "rubric-v9",
    ]) {
      expect(promptVersionRecord(id)?.current, id).toBe(false);
    }
    for (const v of PROMPT_HISTORY) {
      expect(v.introducedIn, v.id).toMatch(/^[0-9a-f]{7}$/);
      expect(v.template.length, v.id).toBeGreaterThan(100);
    }
  });
});

describe("rubric-v6, consistency-v5 and persona-v4 keep the earlier texts", () => {
  it("resolves persona-v2, rubric-v3 and consistency-v3 to their frozen texts", () => {
    const persona2 = promptVersionRecord("persona-v2")!.template;
    expect(persona2).toContain("2 to 5 sentences");
    expect(persona2).toContain("Never say or imply that you are an AI, a simulation, or a character.");
    expect(persona2).not.toContain("revealedWithheld");
    const rubric3 = promptVersionRecord("rubric-v3")!.template;
    expect(rubric3).toContain("A claim of executed work with no such numbers");
    expect(rubric3).not.toContain("Learner wording");
    const consistency3 = promptVersionRecord("consistency-v3")!.template;
    expect(consistency3).toContain("reveals that it is an AI or a simulation");
    expect(consistency3).not.toContain("Identity questions.");
  });

  it("differs from the current texts", () => {
    for (const [old, current] of [
      ["persona-v2", "persona-v3"],
      ["rubric-v3", "rubric-v4"],
      ["rubric-v4", "rubric-v5"],
      ["consistency-v3", "consistency-v4"],
      ["rubric-v5", "rubric-v6"],
      ["consistency-v4", "consistency-v5"],
      ["persona-v3", "persona-v4"],
      ["rubric-v6", "rubric-v7"],
      ["persona-v4", "persona-v5"],
      ["persona-v5", "persona-v6"],
      ["persona-v6", "persona-v7"],
      ["persona-v7", "persona-v8"],
      ["rubric-v7", "rubric-v8"],
      ["rubric-v8", "rubric-v9"],
      ["rubric-v9", "rubric-v10"],
      ["analyst-v2", "analyst-v3"],
      ["consistency-v5", "consistency-v6"],
    ]) {
      expect(promptVersionRecord(old)!.template).not.toBe(promptVersionRecord(current)!.template);
    }
    expect(promptVersionRecord("persona-v3")!.template).toContain("# If you are asked what you are");
    expect(promptVersionRecord("consistency-v6")!.template).toBe(CONSISTENCY_PROMPT_TEMPLATE);
    expect(promptVersionRecord("rubric-v10")!.template).toBe(RUBRIC_PROMPT_TEMPLATE);
  });
});

describe("the text replaced at persona-v6 stays retrievable, verbatim", () => {
  it("persona-v5 is the text that ran the earlier showcase and probes (3da1b85)", async () => {
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(promptVersionRecord("persona-v5")!.template).digest("hex")).toBe(
      "fa56f91d92ce1d2645a655ab212a5c70a225680e6a0d44e0a1e0c21b0755bc5d",
    );
  });

  it("persona-v6 adds the withheld-fact corrective line that persona-v5 did not have", () => {
    expect(promptVersionRecord("persona-v5")!.template).not.toContain("«withheld points»");
    expect(promptVersionRecord("persona-v6")!.template).toContain("«withheld points»");
  });
});

describe("the texts replaced before upload stay retrievable, verbatim", () => {
  // sha256 of each template as composed at 6db9a38, before the pre-upload
  // versions replaced them.
  const FROZEN: Record<string, string> = {
    "persona-v7": "f183d37842c14533324152dff1431891b58a9dff81e7e5f9264e9c98b9032bf9",
    "rubric-v9": "7fb729d5cce0f54cc4c1edd07f7fd7fd538e4c39938216fce44a6da09bb8f44e",
    "analyst-v2": "c18bf079ebc053276c5662902e6ed5019247a84c601c69fa79f7524c1e1d8ad7",
  };
  for (const [id, hash] of Object.entries(FROZEN)) {
    it(`${id} is the text that ran before the pre-upload fixes`, async () => {
      const { createHash } = await import("node:crypto");
      expect(createHash("sha256").update(promptVersionRecord(id)!.template).digest("hex")).toBe(hash);
    });
  }
});

describe("the texts replaced at rubric-v8 and rubric-v9, persona-v7 and consistency-v6 stay retrievable, verbatim", () => {
  // sha256 of each template as composed at 5621dd7, before rubric-v8,
  // persona-v7 and consistency-v6 replaced them. rubric-v7 and
  // consistency-v5 are the texts that scored and audited the earlier
  // showcase.
  const FROZEN: Record<string, string> = {
    "rubric-v7": "0f604b39b56e309f518b48905bb4ac7d18c23fc0d9936e3e7479c4c8d83d9c6e",
    "persona-v6": "eb438b984629123bdc348b364feb62dda781c8e4d94a38d7c806a625b7752fee",
    "consistency-v5": "7b183828deb3a81a5a91dce9dbf7140832a5cfa59403791a6ca908858a38070c",
    // As composed at 4729a9e, before rubric-v9 restored credit rules for
    // points not yet shared.
    "rubric-v8": "3a722f3666d664bfa0caced98ae54cc91df6be10515bf13192d0d6cc5b536b59",
  };
  for (const [id, hash] of Object.entries(FROZEN)) {
    it(`${id} is the text that ran before it was replaced`, async () => {
      const { createHash } = await import("node:crypto");
      expect(createHash("sha256").update(promptVersionRecord(id)!.template).digest("hex")).toBe(hash);
    });
  }

  it("rubric-v8 adds the transcripts and the not-run rule that rubric-v7 did not have", () => {
    expect(promptVersionRecord("rubric-v7")!.template).not.toContain("«stakeholder transcripts»");
    expect(RUBRIC_PROMPT_TEMPLATE).toContain("«stakeholder transcripts»");
    expect(RUBRIC_PROMPT_TEMPLATE).toContain("set notRun to true");
  });
});

describe("the texts replaced at rubric-v7 and persona-v5 stay retrievable, verbatim", () => {
  // sha256 of each template as composed at cbd781a, before rubric-v7 and
  // persona-v5 replaced them.
  const FROZEN: Record<string, string> = {
    "rubric-v6": "5bf003f6ffd213b7f2523339a74e15d1b317b1219bfcfefb6699f45f45dae011",
    "persona-v4": "637f957947ce165599d3e9b22d5311f2cde71c4648df149fe3d2718763d8887c",
  };
  for (const [id, hash] of Object.entries(FROZEN)) {
    it(`${id} is the text that ran before rubric-v7 and persona-v5`, async () => {
      const { createHash } = await import("node:crypto");
      expect(createHash("sha256").update(promptVersionRecord(id)!.template).digest("hex")).toBe(hash);
    });
  }

  it("rubric-v7 adds the conversation record that rubric-v6 did not have", () => {
    expect(promptVersionRecord("rubric-v6")!.template).not.toContain("«conversation record»");
    expect(RUBRIC_PROMPT_TEMPLATE).toContain("«conversation record»");
  });

  it("persona-v5 asks for raisedFrictions, which persona-v4 did not", () => {
    expect(promptVersionRecord("persona-v4")!.template).not.toContain("raisedFrictions");
    expect(promptVersionRecord("persona-v5")!.template).toContain("raisedFrictions");
  });
});

describe("the texts replaced at rubric-v6, consistency-v5 and persona-v4 stay retrievable, verbatim", () => {
  // sha256 of each template as composed at 04dab70, before rubric-v6,
  // consistency-v5 and persona-v4 replaced them.
  const FROZEN: Record<string, string> = {
    "rubric-v5": "8fc9a5dbdc04c42f485ae4040bd428c88b0848cb167c36069655d967bb524019",
    "consistency-v4": "90109d9b0b14eaab3cc221d9790f5b84e2f2baea4bf56d92c398abd03d4e50a9",
    "persona-v3": "0ef22cc730df29b0022ccd7def657f4e6b6bef5691be135d2bdc808967df54f8",
  };
  for (const [id, hash] of Object.entries(FROZEN)) {
    it(`${id} is the text that ran before rubric-v6, consistency-v5 and persona-v4`, async () => {
      const { createHash } = await import("node:crypto");
      expect(createHash("sha256").update(promptVersionRecord(id)!.template).digest("hex")).toBe(hash);
    });
  }

  it("rubric-v5 opens with the assessor persona line that rubric-v6 drops", () => {
    expect(promptVersionRecord("rubric-v5")!.template).toContain("You are a strict but fair assessor");
    expect(RUBRIC_PROMPT_TEMPLATE).not.toContain("strict but fair");
  });
});

describe("rubric-v4 stays retrievable after rubric-v5", () => {
  it("is the exact text that the judge ran from d85779d", async () => {
    const { createHash } = await import("node:crypto");
    const v4 = promptVersionRecord("rubric-v4")!;
    expect(v4.introducedIn).toBe("d85779d");
    // sha256 of RUBRIC_PROMPT_TEMPLATE as composed at b2e43ac.
    expect(createHash("sha256").update(v4.template).digest("hex")).toBe(
      "c46de8772ae3b6efce6479b69fb415119441f76ed320c4756d9fd38e3299774e",
    );
    expect(v4.template).toContain("give each of those criteria at most 40% of its maxScore (2 of 5)");
  });

  it("rubric-v5 leaves the cap to the platform and asks for a separate note", () => {
    const v5 = promptVersionRecord("rubric-v5")!.template;
    expect(v5).not.toContain("give each of those criteria at most 40%");
    expect(v5).toContain("do not lower the score for it yourself");
    expect(v5).toContain("do not mention it in the rationale or the improve line");
    expect(v5).toContain("unverifiedNote");
  });
});

