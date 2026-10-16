// Three persona replies in the regenerated showcase of 2026-10-07 (cohort
// showcase-meridian-mobile-churn-1f4wn, demo/showcase-snapshot.json at tool
// 46fc939) reached the learner as raw JSON text: the end user's message 30
// and the client sponsor's messages 46 and 48, each after a style rewrite.
// The model put the whole structured object inside the reply string. Since
// 6dbe0a0 the repair hook fills in missing arrays, which made the outer
// object validate, so the JSON went out as the reply and its newFacts never
// reached the ledger. Message 48 had also been cut at a sentence end by the
// length repair, mid-JSON. The texts below are copied from the snapshot.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV1 } from "ai/test";
import { replyLengthRepair, unwrapNestedReply } from "@/lib/agents/persona-style";
import { PERSONA_REPLY_MAX_CHARS } from "@/lib/agents/prompt-provenance";

const MSG_30 =
  '{"reply":"6,000 a month works out to about 300 a day across the team, which matches our capacity. On each row I want the subscriber\'s current contract end date and tenure, along with whatever usage or complaint numbers back up a NETWORK or PRICE flag, so I know what to say on the call. How fresh is the score when it lands on our desk?","newFacts":["6,000/month (~300/day) matches Priya\'s team capacity."],"revealedWithheld":[],"releaseDatasets":[]}';
const MSG_30_REPLY =
  "6,000 a month works out to about 300 a day across the team, which matches our capacity. On each row I want the subscriber's current contract end date and tenure, along with whatever usage or complaint numbers back up a NETWORK or PRICE flag, so I know what to say on the call. How fresh is the score when it lands on our desk?";
const MSG_30_FACT = "6,000/month (~300/day) matches Priya's team capacity.";

const MSG_46 =
  '{"reply":"On churn, I treat it as postpaid subscribers who cancel or port out, and Marcus can tell you how that\'s flagged in the extract. On capacity, Priya\'s team can handle about 6,000 offers a month, so that\'s our hard constraint. For the CFO, I want to show spend is targeted rather than blanket. There\'s no specific revenue number yet.","newFacts":[],"revealedWithheld":[],"releaseDatasets":[]}';
const MSG_46_REPLY =
  "On churn, I treat it as postpaid subscribers who cancel or port out, and Marcus can tell you how that's flagged in the extract. On capacity, Priya's team can handle about 6,000 offers a month, so that's our hard constraint. For the CFO, I want to show spend is targeted rather than blanket. There's no specific revenue number yet.";

// Cut mid-JSON: the wrapper never closes.
const MSG_48 =
  '{"reply":"On horizon, propose something workable against the campaign cadence rather than me setting a number. On scope, enterprise and corporate lines are out because this is postpaid consumer only.';
const MSG_48_REPLY =
  "On horizon, propose something workable against the campaign cadence rather than me setting a number. On scope, enterprise and corporate lines are out because this is postpaid consumer only.";

async function runHook(output: unknown) {
  const hook = replyLengthRepair();
  const text = await hook.repair({ text: typeof output === "string" ? output : JSON.stringify(output) });
  return { hook, object: text === null ? null : (JSON.parse(text) as Record<string, unknown>) };
}

describe("the repair hook on a reply that holds the whole object", () => {
  it("unwraps message 30 and keeps its fact", async () => {
    const { hook, object } = await runHook({ reply: MSG_30 });
    expect(object).toMatchObject({ reply: MSG_30_REPLY, newFacts: [MSG_30_FACT], revealedWithheld: [], releaseDatasets: [] });
    expect(hook.repairs()).toEqual([
      { kind: "nested-json", mergedFields: ["newFacts"], wrappedChars: MSG_30.length, replyChars: MSG_30_REPLY.length },
    ]);
    expect(hook.wasTruncated()).toBe(false);
  });

  it("unwraps message 46", async () => {
    const { object } = await runHook({ reply: MSG_46 });
    expect(object).toMatchObject({ reply: MSG_46_REPLY, newFacts: [], releaseDatasets: [] });
  });

  it("strips the cut-off wrapper of message 48", async () => {
    const { hook, object } = await runHook({ reply: MSG_48 });
    expect(object).toMatchObject({ reply: MSG_48_REPLY, newFacts: [], releaseDatasets: [] });
    expect(hook.repairs()[0]).toMatchObject({ kind: "truncated-json", mergedFields: [] });
  });

  it("unwraps before the length cut, so a long wrapper is not cut mid-JSON", async () => {
    const long = JSON.stringify({ reply: MSG_46_REPLY, newFacts: ["Churn is a cancel or a port-out."], releaseDatasets: [], padding: "x".repeat(200) });
    expect(long.length).toBeGreaterThan(PERSONA_REPLY_MAX_CHARS);
    const { hook, object } = await runHook({ reply: long });
    expect(object).toMatchObject({ reply: MSG_46_REPLY, newFacts: ["Churn is a cancel or a port-out."] });
    expect(hook.wasTruncated()).toBe(false);
  });

  it("reads the object returned as a JSON string literal", async () => {
    const { object } = await runHook(JSON.stringify(MSG_30));
    expect(object).toMatchObject({ reply: MSG_30_REPLY, newFacts: [MSG_30_FACT] });
  });

  it("recovers the reply when the raw output is itself cut-off JSON", async () => {
    const { object } = await runHook(MSG_48);
    expect(object).toMatchObject({ reply: MSG_48_REPLY, newFacts: [] });
  });

  it("merges the nested facts with the outer ones without duplicates", async () => {
    const { object } = await runHook({ reply: MSG_30, newFacts: [MSG_30_FACT, "The team works by phone."] });
    expect(object?.newFacts).toEqual([MSG_30_FACT, "The team works by phone."]);
  });

  it("still fills a genuinely missing array and leaves ordinary text alone", async () => {
    const { hook, object } = await runHook({ reply: "{Braces} are fine at the start of a reply." });
    expect(object).toMatchObject({ reply: "{Braces} are fine at the start of a reply.", newFacts: [], releaseDatasets: [] });
    expect(hook.repairs()).toEqual([]);
  });
});

describe("unwrapNestedReply", () => {
  it("returns null for an ordinary reply", () => {
    expect(unwrapNestedReply({ reply: "Each row needs a plain reason.", newFacts: [] })).toBeNull();
  });

  it("merges only the fields it is given (a reaction has no releaseDatasets)", () => {
    const wrapped = JSON.stringify({ reply: "Fine.", newFacts: ["A"], releaseDatasets: ["x.csv"] });
    const out = unwrapNestedReply({ reply: wrapped, newFacts: [], revealedWithheld: [], raisedFrictions: [] }, [
      "newFacts",
      "revealedWithheld",
      "raisedFrictions",
    ]);
    expect(out?.object).toEqual({ reply: "Fine.", newFacts: ["A"], revealedWithheld: [], raisedFrictions: [] });
  });

  it("decodes escapes in a cut-off wrapper", () => {
    const out = unwrapNestedReply({ reply: '{"reply":"She said \\"no\\" twice. And then' });
    expect(out?.object.reply).toBe('She said "no" twice. And then');
  });
});

// The full SDK path in tool mode, with the real generateObject: the
// provider's tool arguments carry the wrapped reply and no arrays.
describe("generateObject with the persona schema", async () => {
  const { PersonaTurnSchema } = await import("@/lib/agents/persona");
  const { generateObjectRobust } = await import("@/lib/llm/structured");
  const model = (args: unknown) =>
    new MockLanguageModelV1({
      defaultObjectGenerationMode: "tool",
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "tool-calls",
        usage: { promptTokens: 100, completionTokens: 50 },
        toolCalls: [{ toolCallType: "function", toolCallId: "t1", toolName: "json", args: JSON.stringify(args) }],
      }),
    });

  it("delivers message 30 as plain text with its fact", async () => {
    const r = await generateObjectRobust(
      { model: model({ reply: MSG_30 }), schema: PersonaTurnSchema, prompt: "Go.", experimental_repairText: replyLengthRepair().repair },
      { callSite: "persona.turn", retry: false },
    );
    expect(r.object).toMatchObject({ reply: MSG_30_REPLY, newFacts: [MSG_30_FACT], releaseDatasets: [] });
  });
});

// The style-rewrite path through the orchestrator: the first draft trips a
// style rule, the rewrite returns a schema-valid object whose reply is the
// wrapped JSON (the repair hook never runs on it).
const generateObject = vi.fn();
const appendMessage = vi.fn();
const appendWorldFacts = vi.fn(async (..._args: unknown[]) => {});
const logEvent = vi.fn(async (..._args: unknown[]) => {});

const ENGAGEMENT = {
  id: "eng-1",
  cohortId: "cohort-1",
  studentId: "student-1",
  scenarioId: "customer-churn",
  currentStage: "testing",
  status: "active",
  mode: "learner",
  createdAt: new Date("2026-10-07T05:00:00Z"),
  completedAt: null,
};
const CHANNEL = {
  id: "chan-1",
  engagementId: "eng-1",
  personaId: "end-user",
  unlockedAt: new Date("2026-10-07T05:00:00Z"),
  createdAt: new Date("2026-10-07T05:00:00Z"),
};

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => {
    const opts = args[0] as { model: unknown };
    // The SDK-path test above passes a real mock model; send it through.
    if (opts.model instanceof MockLanguageModelV1) return realGenerateObject(...(args as [never]));
    return generateObject(...args);
  },
}));
const { generateObject: realGenerateObject } = await vi.importActual<typeof import("ai")>("ai");
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
}));
vi.mock("@/lib/agents/consistency", () => ({
  shouldAuditTurn: () => false,
  auditPersonaTurn: async () => {},
}));
vi.mock("@/lib/agents/data-environment", () => ({
  releasableDatasets: () => [],
  recordDataReleases: async () => [],
}));
vi.mock("@/lib/agents/dataset-profile", () => ({
  profileReleasedDatasets: async () => [],
  releaseWorldFact: () => "",
}));
vi.mock("@/lib/engagement/state", () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  appendWorldFacts: (...a: unknown[]) => appendWorldFacts(...a),
  getChannel: async () => CHANNEL,
  countLearnerMessages: async () => 0,
  getMessages: async () => [],
  getLedger: async () => [],
  logEvent: (...a: unknown[]) => logEvent(...a),
}));
vi.mock("@/lib/db/client", async () => {
  const { createElicitationDbStub } = await import("./support/elicitation-db-stub");
  return { db: createElicitationDbStub().db };
});

describe("the style rewrite returning the wrapped object", async () => {
  const { handleLearnerMessage } = await import("@/lib/agents/orchestrator");
  const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");
  const { loadScenario } = await import("@/lib/scenarios/load");
  const scenario = await loadScenario("customer-churn");

  // Trips the not-just rule, so the rewrite runs.
  const DRAFT = { reply: "It is not just the volume, it's the reasons on each row.", newFacts: [], releaseDatasets: [] };

  beforeEach(() => {
    generateObject.mockReset();
    appendMessage.mockReset();
    appendWorldFacts.mockClear();
    logEvent.mockClear();
    let id = 0;
    appendMessage.mockImplementation(async (row: { sender: string; content: string }) => ({
      id: ++id,
      sender: row.sender,
      content: row.content,
      timestampIso: "2026-10-07T05:26:13Z",
    }));
  });

  const send = () =>
    handleLearnerMessage({
      engagement: ENGAGEMENT as never,
      channel: CHANNEL as never,
      scenario,
      config: DEFAULT_COHORT_CONFIG,
      // No figures, so the learner-number filter keeps the fact.
      text: "What does your team need on each row of the call list?",
    });

  it("delivers message 30 as plain text, records its fact and logs the repair", async () => {
    generateObject
      .mockResolvedValueOnce({ object: DRAFT, usage: { promptTokens: 10, completionTokens: 5 } })
      .mockResolvedValueOnce({
        object: { reply: MSG_30, newFacts: [], revealedWithheld: [], raisedFrictions: [], releaseDatasets: [] },
        usage: { promptTokens: 10, completionTokens: 5 },
      });
    const out = await send();
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(out.message.content).toBe(MSG_30_REPLY);
    const personaFacts = appendWorldFacts.mock.calls.find((c) => c[2] === "end-user");
    expect(personaFacts?.[3]).toEqual([MSG_30_FACT]);
    const repair = logEvent.mock.calls.find((c) => c[2] === "persona_output_repair");
    expect(repair?.[3]).toMatchObject({
      personaId: "end-user",
      kind: "turn",
      repairs: [{ call: "rewrite", stage: "validated-object", kind: "nested-json", mergedFields: ["newFacts"] }],
    });
  });

  it("gives the rewrite prompt only the reply text of a wrapped draft", async () => {
    // Trips the not-just rule inside the wrapper.
    const wrappedDraft = JSON.stringify({ reply: DRAFT.reply, newFacts: [], releaseDatasets: [] });
    generateObject
      .mockResolvedValueOnce({ object: { ...DRAFT, reply: wrappedDraft }, usage: { promptTokens: 10, completionTokens: 5 } })
      .mockResolvedValueOnce({ object: { reply: MSG_46, newFacts: [], releaseDatasets: [] }, usage: { promptTokens: 10, completionTokens: 5 } });
    const out = await send();
    const rewriteSystem = (generateObject.mock.calls[1][0] as { system: string }).system;
    expect(rewriteSystem).toContain(DRAFT.reply);
    expect(rewriteSystem).not.toContain('{"reply"');
    expect(out.message.content).toBe(MSG_46_REPLY);
  });
});
