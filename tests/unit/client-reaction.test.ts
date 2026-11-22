// The client sponsor's reaction to a gate submission. It must never break a
// submission, but the result banner points the learner at the sponsor's
// channel, so a failed reaction has to come back as a flag and land in the
// event log rather than disappearing into a bare catch. Since persona-v2 the
// reaction is a structured persona call like a chat turn: it returns the
// reply and any new facts, the facts join the ledger, and the reply is
// eligible for the consistency audit.

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const auditPersonaTurn = vi.fn(async (..._args: unknown[]) => {});
const appendMessage = vi.fn(async (..._args: unknown[]) => ({ id: 1 }));
const logEvent = vi.fn(async (..._args: unknown[]) => {});
const advanceStage = vi.fn(async (..._args: unknown[]) => {});
const appendWorldFacts = vi.fn(async (..._args: unknown[]) => {});

const ENGAGEMENT = {
  id: "eng-1",
  cohortId: "cohort-1",
  studentId: "student-1",
  scenarioId: "customer-churn",
  currentStage: "formulation",
  status: "active",
  mode: "learner",
  createdAt: new Date("2026-08-25T09:00:00Z"),
  completedAt: null,
};

const WORLD_FACTS = ["The client agreed the scope is postpaid only."];

// The sponsor's channel history: a concession the reaction must not reopen.
const CLIENT_CHANNEL_MESSAGES = [
  {
    id: 1,
    channelId: "chan-1",
    engagementId: "eng-1",
    sender: "learner",
    content: "Can we park the partnership idea until after handover?",
    timestampIso: "2026-08-25T09:10:00Z",
  },
  {
    id: 2,
    channelId: "chan-1",
    engagementId: "eng-1",
    sender: "client",
    content: "Fine, the partnership can wait. Focus on churn first.",
    timestampIso: "2026-08-25T09:11:00Z",
  },
];

// Withheld facts the learner has obtained before the delivery: the rows a
// read of fact_elicitations returns.
let elicitationRows: Record<string, unknown>[] = [];
let elicitationTable: unknown = null;

// Enough of the drizzle query builder for the inserts and updates the gate
// handler makes; no query it issues here reads anything back but the
// submission row and the elicitation rows.
function stubDb() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table !== null && table === elicitationTable ? [...elicitationRows] : []),
      }),
    }),
    insert: () => ({
      values: (rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        const returned = list.map((r, i) => ({ id: `sub-${i + 1}`, ...(r as object) }));
        return Object.assign(Promise.resolve(returned), {
          returning: async () => returned,
          onConflictDoNothing: async () => {},
        });
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
}

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("@/lib/agents/consistency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/consistency")>();
  return { ...actual, auditPersonaTurn: (...a: unknown[]) => auditPersonaTurn(...a) };
});
vi.mock("@/lib/db/client", () => ({ db: stubDb() }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
  RUBRIC_TEMPERATURE: 0,
}));
vi.mock("@/lib/agents/rubric", () => ({
  scoreSubmission: async () => ({
    // 3 of 5 is exactly the shipped 60% bar, so the default cohort passes and
    // a stricter one holds without needing a second rubric stub.
    scores: [{ criterionId: "objective", score: 3, maxScore: 5, rationale: "Partly there." }],
    judgeModel: "stub",
    promptVersion: "rubric-v1",
    promptTokens: 1,
    completionTokens: 1,
  }),
}));
vi.mock("@/lib/engagement/state", () => ({
  advanceStage: (...a: unknown[]) => advanceStage(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  appendWorldFacts: (...a: unknown[]) => appendWorldFacts(...a),
  completeEngagement: async () => {},
  getChannels: async () => [
    {
      id: "chan-1",
      engagementId: ENGAGEMENT.id,
      personaId: "client",
      unlockedAt: new Date("2026-08-25T09:00:00Z"),
      createdAt: new Date("2026-08-25T09:00:00Z"),
    },
  ],
  getMessages: async () => CLIENT_CHANNEL_MESSAGES,
  getLedger: async () => WORLD_FACTS.map((fact) => ({ fact, provenance: "persona", source: "client", stage: "formulation" })),
  getWorldFacts: async () => WORLD_FACTS,
  getEvents: async () => [],
  countLearnerMessages: async () => 7,
  logEvent: (...a: unknown[]) => logEvent(...a),
}));

const { handleGateSubmission, CLIENT_REACTION_EVENT, CLIENT_REACTION_FAILED_EVENT } = await import(
  "@/lib/agents/stage-gate"
);
const { loadScenario } = await import("@/lib/scenarios/load");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");

const scenario = await loadScenario("customer-churn");
elicitationTable = (await import("@/lib/db/schema")).factElicitations;

function obtained(factId: string, verified = true) {
  return { factId, personaId: "client", verified, detection: "reported", matchedKey: verified ? "$30" : null };
}

const ARTIFACT = "A problem statement long enough to clear the submission floor. ".repeat(4);

async function submit(config = DEFAULT_COHORT_CONFIG) {
  return handleGateSubmission({
    engagement: ENGAGEMENT as never,
    scenario,
    config,
    text: ARTIFACT,
  });
}

function reactionCalls() {
  return logEvent.mock.calls.filter((c) => c[2] === CLIENT_REACTION_FAILED_EVENT);
}

function reacted(reply: string, newFacts: string[] = [], revealedWithheld: string[] = [], raisedFrictions: string[] = []) {
  return {
    object: { reply, newFacts, revealedWithheld, raisedFrictions },
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

describe("client reaction to a gate submission", () => {
  beforeEach(() => {
    generateObject.mockReset();
    appendMessage.mockClear();
    appendWorldFacts.mockClear();
    auditPersonaTurn.mockClear();
    logEvent.mockClear();
    advanceStage.mockClear();
    elicitationRows = [];
  });

  it("reports the reaction as delivered when the message is persisted", async () => {
    generateObject.mockResolvedValue(reacted("Fine. What does this mean for next month's list?"));

    const outcome = await submit();

    expect(outcome.advanced).toBe(true);
    expect(outcome.clientReacted).toBe(true);
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(reactionCalls()).toHaveLength(0);
  });

  it("is a structured persona call with the reaction schema", async () => {
    generateObject.mockResolvedValue(reacted("Noted."));

    await submit();

    const call = generateObject.mock.calls[0][0] as { schema: { shape: Record<string, unknown> }; prompt: string };
    expect(Object.keys(call.schema.shape).sort()).toEqual(["newFacts", "raisedFrictions", "reply", "revealedWithheld"]);
    // The persona must speak as themselves, and must not open by grading
    // the document.
    expect(call.prompt).toContain("in the first person");
    expect(call.prompt).toContain("Never refer to yourself by name");
    expect(call.prompt).toContain("Start with the point you want to make. Do not open with a verdict on the document.");
    expect(call.prompt).toMatch(/The work is good enough to move on\. (?:Raise one concrete concern|Ask the business question|Say what you will decide)/);
    expect(call.prompt).toContain("Do not name a data problem, a defect, a figure or a constraint that the document does not mention");
    expect(call.prompt).toContain("do not bring up requests that belong later");
    expect(call.prompt).toContain('do not end with an instruction such as "Send me a note once..."');
    expect(call.prompt).toContain("Never record a number, a result or a finding that the consultant reported");
    expect(call.prompt).not.toMatch(/rubric terms/);
  });

  it("asks a failing reaction to state business needs without assessment language", async () => {
    generateObject.mockResolvedValue(reacted("Not yet. I need the capacity figure in it."));

    await submit({ ...DEFAULT_COHORT_CONFIG, gates: { minScoreRatio: 0.9, maxRetries: 2 } });

    const prompt = (generateObject.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("Say what the business still needs from it");
    expect(prompt).toContain("Do not use assessment language");
  });

  it("appends the reaction's new facts to the ledger as persona facts", async () => {
    generateObject.mockResolvedValue(
      reacted("Fine. Can the model also flag upsell candidates?", ["Sarah asked whether the model could also flag upsell candidates."]),
    );

    await submit();

    const factCall = appendWorldFacts.mock.calls.find((c) => c[2] === "client");
    expect(factCall).toBeTruthy();
    expect(factCall![3]).toEqual(["Sarah asked whether the model could also flag upsell candidates."]);
    expect(factCall![4]).toBe("persona");
    const done = logEvent.mock.calls.find((c) => c[2] === CLIENT_REACTION_EVENT);
    expect(done?.[3]).toMatchObject({ personaId: "client", newFacts: 1, promptVersion: "persona-v8" });
  });

  it("is eligible for the consistency audit like a chat turn", async () => {
    generateObject.mockResolvedValue(reacted("Noted."));
    // The sponsor has one prior message in the channel, so this reaction is
    // within the guaranteed first two audited turns.
    await submit();
    expect(auditPersonaTurn).toHaveBeenCalledTimes(1);
    const arg = auditPersonaTurn.mock.calls[0][0] as { reply: string; persona: { id: string } };
    expect(arg.reply).toBe("Noted.");
    expect(arg.persona.id).toBe("client");
    const done = logEvent.mock.calls.find((c) => c[2] === CLIENT_REACTION_EVENT);
    expect(done?.[3]).toMatchObject({ audited: true });
  });

  it("audits the reaction against the same 4,000-character excerpt the sponsor read (consistency-v6)", async () => {
    generateObject.mockResolvedValue(reacted("The pilot with 500 before full rollout works for me."));
    const memo = `${"Validation memo text. ".repeat(134)}Priya's team will pilot the list with 500 subscribers in the first week. ${"More. ".repeat(600)}`;
    await handleGateSubmission({ engagement: ENGAGEMENT as never, scenario, config: DEFAULT_COHORT_CONFIG, text: memo });
    const prompt = (generateObject.mock.calls[0][0] as { prompt: string }).prompt;
    const audit = auditPersonaTurn.mock.calls[0][0] as { consultantMessage: string };
    expect(memo.indexOf("pilot the list")).toBeGreaterThan(1500);
    expect(prompt).toContain("pilot the list with 500 subscribers");
    expect(audit.consultantMessage).toContain("pilot the list with 500 subscribers");
    expect(audit.consultantMessage).toContain(memo.slice(0, 4000));
    expect(audit.consultantMessage).not.toContain(memo.slice(0, 4001));
  });

  it("prompts the sponsor with the ledger as it stood when the artifact landed", async () => {
    generateObject.mockResolvedValue(reacted("Noted."));

    await submit();

    // The advancing path writes "the engagement moved on" into the ledger
    // before the reaction is generated; the sponsor must not be asked to
    // acknowledge a delivery the shared record already reports as settled.
    const system = generateObject.mock.calls[0][0].system as string;
    expect(system).toContain(WORLD_FACTS[0]);
    expect(system).not.toContain("the engagement moved on");
    expect(appendWorldFacts).toHaveBeenCalled();
  });

  it("includes the sponsor's recent channel turns so settled points stay settled", async () => {
    generateObject.mockResolvedValue(reacted("Noted."));

    await submit();

    const prompt = (generateObject.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("the partnership can wait");
    expect(prompt).toContain("Points settled here stay settled");
  });

  it("retries once and delivers the reaction when the second attempt succeeds", async () => {
    const err = new Error("Overloaded: please retry.");
    err.name = "AI_APICallError";
    generateObject.mockRejectedValueOnce(err).mockResolvedValueOnce(reacted("Received. Now the list."));

    const outcome = await submit();

    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(outcome.clientReacted).toBe(true);
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(reactionCalls()).toHaveLength(0);
  });

  it("flags a failed reaction and logs the error class, without failing the submission", async () => {
    const err = new Error("Overloaded: please retry.");
    err.name = "AI_APICallError";
    generateObject.mockRejectedValue(err);

    const outcome = await submit();

    expect(outcome.advanced).toBe(true);
    expect(outcome.clientReacted).toBe(false);
    // Both the first attempt and its retry failed.
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(appendMessage).not.toHaveBeenCalled();

    const calls = reactionCalls();
    expect(calls).toHaveLength(1);
    const detail = calls[0][3] as Record<string, unknown>;
    expect(detail.errorClass).toBe("AI_APICallError");
    expect(detail.stage).toBe("formulation");
    expect(detail.reason).toBe("passed");
    expect(detail.message).toContain("Overloaded");
  });

  it("meters the failed reaction attempts as persona_failed", async () => {
    const err = Object.assign(new Error("No object generated."), {
      name: "AI_NoObjectGeneratedError",
      usage: { promptTokens: 900, completionTokens: 700, totalTokens: 1600 },
    });
    generateObject.mockRejectedValue(err);
    await submit();
    const failed = logEvent.mock.calls.filter((c) => c[2] === "persona_failed").map((c) => c[3]);
    expect(failed).toEqual([
      expect.objectContaining({ kind: "reaction", recovered: false, attempts: 2, promptTokens: 1800, completionTokens: 1400 }),
    ]);
  });

  it("treats an empty reply as a failed reaction rather than a blank message", async () => {
    generateObject.mockResolvedValue(reacted("   "));

    const outcome = await submit();

    expect(outcome.clientReacted).toBe(false);
    expect(appendMessage).not.toHaveBeenCalled();
    expect(reactionCalls()).toHaveLength(1);
  });

  it("still reacts when the gate holds the learner at the same stage", async () => {
    generateObject.mockResolvedValue(reacted("Not enough to go on yet."));

    const outcome = await submit({
      ...DEFAULT_COHORT_CONFIG,
      gates: { minScoreRatio: 0.9, maxRetries: 2 },
    });

    expect(outcome.advanced).toBe(false);
    expect(outcome.clientReacted).toBe(true);
    expect(advanceStage).not.toHaveBeenCalled();
  });

  it("drops reaction facts that restate a figure or result from the submission", async () => {
    generateObject.mockResolvedValue(
      reacted("I will take the list to the CFO on Friday.", [
        "The consultant's model reached an AUC of 0.91 on the held-out 20%.",
        "Sarah will take the targeting list to the CFO on Friday.",
      ]),
    );
    await handleGateSubmission({
      engagement: ENGAGEMENT as never,
      scenario,
      config: DEFAULT_COHORT_CONFIG,
      text: `${ARTIFACT} We trained a model and reached an AUC of 0.91 on the held-out 20%.`,
    });
    const factCall = appendWorldFacts.mock.calls.find((c) => c[2] === "client");
    expect(factCall![3]).toEqual(["Sarah will take the targeting list to the CFO on Friday."]);
    const done = logEvent.mock.calls.find((c) => c[2] === CLIENT_REACTION_EVENT);
    expect(done?.[3]).toMatchObject({ newFacts: 1, droppedFacts: 1 });
  });

  it("audits every reaction, whatever the sampling rate", async () => {
    generateObject.mockResolvedValue(reacted("Noted."));
    await submit({ ...DEFAULT_COHORT_CONFIG, research: { ...DEFAULT_COHORT_CONFIG.research, consistencyAuditRate: 0 } });
    expect(auditPersonaTurn).toHaveBeenCalledTimes(1);
  });

  it("logs fact_elicited when the reaction states a kept-back point the learner had obtained unverified", async () => {
    elicitationRows = [obtained("offer-cost", false)];
    generateObject.mockResolvedValue(reacted("An offer costs us about S$30.", [], ["offer-cost", "not-an-id"]));
    await submit();
    expect(generateObject).toHaveBeenCalledTimes(1);
    const elicited = logEvent.mock.calls.filter((c) => c[2] === "fact_elicited");
    expect(elicited).toHaveLength(1);
    expect(elicited[0][3]).toEqual({
      factId: "offer-cost",
      persona: "client",
      turnIndex: 2,
      learnerMessagesSoFar: 7,
      verified: true,
      matchedKey: "$30",
      detection: "reported",
    });
  });

  it("does not record a reported reveal of a fact the learner has not obtained (persona-v6)", async () => {
    generateObject.mockResolvedValue(reacted("We can talk about money later.", [], ["offer-cost"]));
    await submit();
    expect(logEvent.mock.calls.some((c) => c[2] === "fact_elicited")).toBe(false);
    expect(logEvent.mock.calls.find((c) => c[2] === CLIENT_REACTION_EVENT)?.[3]).toMatchObject({
      revealedWithheld: [],
      droppedReveals: ["offer-cost"],
    });
  });

  it("rewrites a reaction once when it trips a style pattern, and logs the hit", async () => {
    generateObject
      .mockResolvedValueOnce(reacted("Good catch on the budget. Send me a short note once you have the list."))
      .mockResolvedValueOnce(reacted("The budget point stands. I need the list by Friday."));
    await submit();
    expect(generateObject).toHaveBeenCalledTimes(2);
    const retrySystem = (generateObject.mock.calls[1][0] as { system: string }).system;
    expect(retrySystem).toContain("# Rewrite your last draft");
    expect(retrySystem).toContain("Good catch on the budget.");
    expect(appendMessage.mock.calls[0][0]).toMatchObject({
      content: "The budget point stands. I need the list by Friday.",
      promptTokens: 20,
      completionTokens: 10,
    });
    const retry = logEvent.mock.calls.find((c) => c[2] === "persona_style_retry");
    expect(retry?.[3]).toMatchObject({
      personaId: "client",
      kind: "reaction",
      patterns: ["verdict-opener", "note-once-closer"],
      resolved: true,
      promptVersion: "persona-v8",
    });
  });

  it("does not show a modelling-stage pressure in a formulation reaction", async () => {
    generateObject.mockResolvedValue(reacted("Noted."));
    await submit();
    const system = (generateObject.mock.calls[0][0] as { system: string }).system;
    expect(system).not.toContain("also flag customers we could upsell");
    expect(system).not.toContain("# Pressures you bring");
  });

  it("brings the modelling scope request in the reaction that opens modelling, and records it when raised", async () => {
    generateObject.mockResolvedValue(
      reacted("Before you start, could the model also flag customers we could upsell?", [], [], ["upsell-request"]),
    );
    const cleaning = { ...ENGAGEMENT, currentStage: "cleaning" };
    const outcome = await handleGateSubmission({
      engagement: cleaning as never,
      scenario,
      config: DEFAULT_COHORT_CONFIG,
      text: ARTIFACT,
    });
    expect(outcome.newStage).toBe("modelling");
    // rubric-v7: the stage's message counts join the record with the delivery.
    const counts = appendWorldFacts.mock.calls.flatMap((c) => c[3] as string[]).find((f) => f.startsWith("Messages at the"));
    expect(counts).toBe('Messages at the "Data cleaning" stage: the consultant sent 0 to Sarah Tan (client sponsor), 0 to Marcus Wong (data owner), 0 to Priya Nair (end user).');
    const call = generateObject.mock.calls[0][0] as { system: string; prompt: string };
    expect(call.system).toContain("# Pressures you bring at this point in the work");
    expect(call.system).toContain("also flag customers we could upsell");
    expect(call.prompt).toContain("also raise the pressure listed in your brief");
    const friction = client().frictions[0];
    const recorded = appendWorldFacts.mock.calls.find((c) => (c[3] as string[]).includes(friction.ledger));
    expect(recorded?.[2]).toBe("client");
    // A keyword match on model text is a claim, not an established fact.
    expect(recorded?.[4]).toBe("detected");
    expect(logEvent.mock.calls.find((c) => c[2] === "friction_raised")?.[3]).toMatchObject({ stage: "modelling", via: "reaction" });
  });

  it("records no raised friction when the reaction leaves it out", async () => {
    generateObject.mockResolvedValue(reacted("Noted. What does the cleaned file look like?"));
    await handleGateSubmission({
      engagement: { ...ENGAGEMENT, currentStage: "cleaning" } as never,
      scenario,
      config: DEFAULT_COHORT_CONFIG,
      text: ARTIFACT,
    });
    expect(logEvent.mock.calls.some((c) => c[2] === "friction_raised")).toBe(false);
  });

  it("returns learner scores without the instructor-only fields", async () => {
    generateObject.mockResolvedValue(reacted("Noted."));
    const outcome = await submit();
    expect(outcome.learnerScores).toEqual([
      { criterionId: "objective", score: 3, maxScore: 5, rationale: "Partly there.", improve: null },
    ]);
  });

  it("regenerates a reaction that names a fact the document does not mention, once, with a corrective line", async () => {
    generateObject
      .mockResolvedValueOnce(reacted("Do subscribers who changed plans show up twice in there? I need the list by Friday."))
      .mockResolvedValueOnce(reacted("I need the list by Friday."));
    await submit();
    expect(generateObject).toHaveBeenCalledTimes(2);
    const retry = generateObject.mock.calls[1][0] as { prompt: string };
    expect(retry.prompt).toContain("Your draft reaction named something the document does not mention: changed plans");
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ content: "I need the list by Friday.", promptTokens: 20 });
    expect(logEvent.mock.calls.find((c) => c[2] === "reaction_leak_filtered")?.[3]).toMatchObject({
      named: ["changed plans"],
      regenerated: true,
      removed: false,
    });
  });

  it("removes the naming sentences when the regenerated reaction still names the fact", async () => {
    generateObject.mockResolvedValue(reacted("I need the list by Friday. Finance counts a save only if they stay 6 more months."));
    await submit();
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ content: "I need the list by Friday." });
    expect(logEvent.mock.calls.find((c) => c[2] === "reaction_leak_filtered")?.[3]).toMatchObject({
      regenerated: true,
      removed: true,
    });
  });

  it("falls back to a neutral line when every sentence names an unraised fact", async () => {
    const { PERSONA_REACTION_LEAK_FALLBACK } = await import("@/lib/agents/prompt-provenance");
    generateObject.mockResolvedValue(reacted("Each offer costs us S$30."));
    await submit();
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ content: PERSONA_REACTION_LEAK_FALLBACK });
  });

  it("keeps the sponsor's own fact once the learner has obtained it", async () => {
    elicitationRows = [obtained("offer-cost")];
    generateObject.mockResolvedValue(reacted("An offer costs us about S$30.", [], ["offer-cost"]));
    await submit();
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ content: "An offer costs us about S$30." });
    expect(logEvent.mock.calls.some((c) => c[2] === "withheld_leak_blocked")).toBe(false);
  });

  it("blocks the sponsor's own unobtained fact even when the document states it (persona-v6)", async () => {
    generateObject.mockResolvedValue(reacted("Noted. Remember an offer costs S$30.", [], []));
    await handleGateSubmission({
      engagement: ENGAGEMENT as never,
      scenario,
      config: DEFAULT_COHORT_CONFIG,
      text: `${ARTIFACT} Offers cost S$30 each.`,
    });
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ content: "Noted." });
    expect(logEvent.mock.calls.some((c) => c[2] === "fact_elicited")).toBe(false);
  });
});

// Probe 17b: a statement that leaves the offer cost and the save
// definition "to be confirmed", from a learner who never wrote to the
// sponsor. The sponsor's reaction stated both, reported them as shared, and
// the persona-v5 filter let them through because the sponsor's own reported
// facts were exempt.
describe("the sponsor's own withheld facts in a reaction (persona-v6)", () => {
  const HEDGED = `${ARTIFACT} Constraints: the offer cost per subscriber is to be confirmed with the sponsor; the save definition used by Finance is to be confirmed.`;
  const LEAKY =
    "An offer costs about S$30 to serve, so that's your economics figure. Finance only counts a save if the subscriber stays six more months, use that for the save definition. I need the list timing confirmed.";

  beforeEach(() => {
    generateObject.mockReset();
    appendMessage.mockClear();
    appendWorldFacts.mockClear();
    auditPersonaTurn.mockClear();
    logEvent.mockClear();
    elicitationRows = [];
  });

  async function submitHedged() {
    return handleGateSubmission({ engagement: ENGAGEMENT as never, scenario, config: DEFAULT_COHORT_CONFIG, text: HEDGED });
  }

  it("regenerates once with a corrective line naming the conditions, and delivers the clean draft", async () => {
    generateObject
      .mockResolvedValueOnce(reacted(LEAKY, [], ["offer-cost", "save-definition"]))
      .mockResolvedValueOnce(reacted("I need the list timing confirmed before Thursday."));
    await submitHedged();
    expect(generateObject).toHaveBeenCalledTimes(2);
    const retry = (generateObject.mock.calls[1][0] as { prompt: string }).prompt;
    expect(retry).toContain("Your draft stated a point that you keep to yourself until the consultant asks for it");
    expect(retry).toContain("what an offer costs");
    expect(retry).toContain("defines a successful save");
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ content: "I need the list timing confirmed before Thursday." });
    const blocked = logEvent.mock.calls.filter((c) => c[2] === "withheld_leak_blocked").map((c) => c[3]);
    expect(blocked).toEqual([
      expect.objectContaining({ factId: "offer-cost", channel: "reaction", channelId: "chan-1", regenerated: true, removed: false }),
      expect.objectContaining({ factId: "save-definition", channel: "reaction", channelId: "chan-1", regenerated: true, removed: false }),
    ]);
    expect(logEvent.mock.calls.some((c) => c[2] === "fact_elicited")).toBe(false);
  });

  it("removes the sentences that still state S$30 and the six-month rule, and records no reveal", async () => {
    generateObject.mockResolvedValue(
      reacted(LEAKY, ["A retention offer costs about S$30 to serve.", "The list timing must be confirmed."], [
        "offer-cost",
        "save-definition",
      ]),
    );
    await submitHedged();
    expect(generateObject).toHaveBeenCalledTimes(2);
    const delivered = (appendMessage.mock.calls[0][0] as { content: string }).content;
    expect(delivered).toBe("I need the list timing confirmed.");
    expect(delivered).not.toMatch(/\$30|six|6 more/i);
    const blocked = logEvent.mock.calls.filter((c) => c[2] === "withheld_leak_blocked").map((c) => c[3]);
    expect(blocked).toEqual([
      expect.objectContaining({ factId: "offer-cost", channel: "reaction", regenerated: true, removed: true }),
      expect.objectContaining({ factId: "save-definition", channel: "reaction", regenerated: true, removed: true }),
    ]);
    // Neither fact is recorded as obtained or reaches the ledger.
    expect(logEvent.mock.calls.some((c) => c[2] === "fact_elicited")).toBe(false);
    expect(logEvent.mock.calls.some((c) => c[2] === "fact_elicited_early")).toBe(false);
    const written = appendWorldFacts.mock.calls.flatMap((c) => c[3] as string[]);
    expect(written.some((f) => f.includes("S$30"))).toBe(false);
    expect(written).toContain("The list timing must be confirmed.");
    expect(logEvent.mock.calls.find((c) => c[2] === CLIENT_REACTION_EVENT)?.[3]).toMatchObject({
      revealedWithheld: [],
      droppedReveals: ["offer-cost", "save-definition"],
      withheldLeakBlocked: ["offer-cost", "save-definition"],
    });
  });
});

function client() {
  return scenario.personas.find((p) => p.role === "client-sponsor")!;
}
