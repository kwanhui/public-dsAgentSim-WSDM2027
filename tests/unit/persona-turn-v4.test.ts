// A chat turn under persona-v4: the platform enforces the identity answer
// and audits every turn that answers a sincere identity question; a chat
// turn may not turn a figure the learner wrote into a ledger fact; a pressure
// raised in chat is recorded as a system fact; a release names the learner
// message it answered; and the auditor receives the learner's message.

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const appendMessage = vi.fn();
const appendWorldFacts = vi.fn(async (..._a: unknown[]) => {});
const logEvent = vi.fn(async (..._args: unknown[]) => {});
const auditPersonaTurn = vi.fn(async (..._a: unknown[]) => {});
const recordDataReleases = vi.fn(async (..._a: unknown[]) => [] as string[]);

let engagementStage = "formulation";
let channelPersona = "client";
let ledger: { fact: string; provenance: string }[] = [];

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
}));
vi.mock("@/lib/agents/consistency", () => ({
  // Sampling never fires on its own here, so only forced audits run.
  shouldAuditTurn: () => false,
  auditPersonaTurn: (...a: unknown[]) => auditPersonaTurn(...a),
}));
vi.mock("@/lib/agents/data-environment", () => ({
  releasableDatasets: () => [],
  recordDataReleases: (...a: unknown[]) => recordDataReleases(...a),
}));
vi.mock("@/lib/agents/dataset-profile", () => ({ profileReleasedDatasets: async () => [], releaseWorldFact: () => "" }));
vi.mock("@/lib/db/client", async () => {
  const { createElicitationDbStub } = await import("./support/elicitation-db-stub");
  return { db: createElicitationDbStub().db };
});
vi.mock("@/lib/engagement/state", () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  appendWorldFacts: (...a: unknown[]) => appendWorldFacts(...a),
  countLearnerMessages: async () => 3,
  getEvents: async () => [],
  getMessages: async () => [],
  getLedger: async () => ledger,
  logEvent: (...a: unknown[]) => logEvent(...a),
}));

const { handleLearnerMessage } = await import("@/lib/agents/orchestrator");
const { resetElicitationDbStubs } = await import("./support/elicitation-db-stub");
const { loadScenario } = await import("@/lib/scenarios/load");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");
const { PERSONA_IDENTITY_SENTENCE } = await import("@/lib/agents/prompt-provenance");
const scenario = await loadScenario("customer-churn");

function turn(
  reply: string,
  extra: { newFacts?: string[]; releaseDatasets?: string[]; raisedFrictions?: string[]; revealedWithheld?: string[] } = {},
) {
  return {
    object: {
      reply,
      newFacts: extra.newFacts ?? [],
      revealedWithheld: extra.revealedWithheld ?? [],
      releaseDatasets: extra.releaseDatasets ?? [],
      raisedFrictions: extra.raisedFrictions ?? [],
    },
    usage: { promptTokens: 10, completionTokens: 4 },
  };
}

function send(text: string) {
  return handleLearnerMessage({
    engagement: {
      id: "eng-1",
      cohortId: "cohort-1",
      scenarioId: "customer-churn",
      currentStage: engagementStage,
      status: "active",
      mode: "learner",
    } as never,
    channel: { id: "chan-1", engagementId: "eng-1", personaId: channelPersona, unlockedAt: new Date() } as never,
    scenario,
    config: DEFAULT_COHORT_CONFIG,
    text,
  });
}

beforeEach(() => {
  generateObject.mockReset();
  appendWorldFacts.mockClear();
  logEvent.mockClear();
  auditPersonaTurn.mockReset().mockResolvedValue(undefined);
  resetElicitationDbStubs();
  recordDataReleases.mockReset().mockResolvedValue([]);
  engagementStage = "formulation";
  channelPersona = "client";
  ledger = [];
  let id = 100;
  appendMessage.mockReset().mockImplementation(async (row: { sender: string; content: string }) => ({
    id: ++id,
    sender: row.sender,
    content: row.content,
    timestampIso: "t",
  }));
});

describe("sincere identity questions", () => {
  it("replaces a reply that claims to be human with the fixed line and the in-role remainder", async () => {
    generateObject.mockResolvedValue(turn("Yes, this is me. I'm a real person. The budget is tight this quarter."));
    const out = await send("Am I talking to a real person or an AI?");
    expect(out.message.content).toBe(`${PERSONA_IDENTITY_SENTENCE} The budget is tight this quarter.`);
    expect(logEvent.mock.calls.find((c) => c[2] === "identity_question")?.[3]).toMatchObject({
      personaId: "client",
      outcome: "replaced",
      promptVersion: "persona-v8",
    });
    // Always audited, on the model's own reply, with the learner's question.
    expect(auditPersonaTurn).toHaveBeenCalledTimes(1);
    expect(auditPersonaTurn.mock.calls[0][0]).toMatchObject({
      reply: "Yes, this is me. I'm a real person. The budget is tight this quarter.",
      consultantMessage: "Am I talking to a real person or an AI?",
      reason: "identity-question",
    });
  });

  it("puts the fixed line first when the reply dodges the question", async () => {
    generateObject.mockResolvedValue(turn("I'm Sarah Tan, VP Customer Retention."));
    const out = await send("Are you a bot?");
    expect(out.message.content).toBe(`${PERSONA_IDENTITY_SENTENCE} I'm Sarah Tan, VP Customer Retention.`);
    expect(logEvent.mock.calls.find((c) => c[2] === "identity_question")?.[3]).toMatchObject({ outcome: "prepended" });
  });

  it("keeps a reply that already states it", async () => {
    generateObject.mockResolvedValue(turn(`${PERSONA_IDENTITY_SENTENCE} What do you need from me?`));
    const out = await send("Are you human?");
    expect(out.message.content).toBe(`${PERSONA_IDENTITY_SENTENCE} What do you need from me?`);
    expect(logEvent.mock.calls.find((c) => c[2] === "identity_question")?.[3]).toMatchObject({ outcome: "stated" });
  });

  it("leaves banter alone and does not force an audit", async () => {
    generateObject.mockResolvedValue(turn("Only on Fridays."));
    const out = await send("Are you a robot about deadlines?");
    expect(out.message.content).toBe("Only on Fridays.");
    expect(logEvent.mock.calls.some((c) => c[2] === "identity_question")).toBe(false);
    expect(auditPersonaTurn).not.toHaveBeenCalled();
  });
});

describe("chat-turn facts", () => {
  it("drops a fact that quotes a figure the learner wrote and the record does not hold", async () => {
    generateObject.mockResolvedValue(
      turn("Noted.", { newFacts: ["The team will call 1,500 people a week.", "Prepaid is out of scope."] }),
    );
    await send("My model reaches 91% precision if we call 1,500 people a week.");
    const persona = appendWorldFacts.mock.calls.find((c) => c[2] === "client" && c[4] === undefined);
    expect(persona?.[3]).toEqual(["Prepaid is out of scope."]);
    expect(logEvent.mock.calls.find((c) => c[2] === "persona_turn")?.[3]).toMatchObject({ newFacts: 1, droppedFacts: 1 });
  });

  it("keeps a figure the persona's own brief holds, even when the learner also wrote it", async () => {
    generateObject.mockResolvedValue(turn("Yes.", { newFacts: ["Campaign staff can handle about 6,000 offers a month."] }));
    await send("Is it right that the team handles 6,000 offers a month?");
    const persona = appendWorldFacts.mock.calls.find((c) => c[2] === "client" && c[4] === undefined);
    expect(persona?.[3]).toEqual(["Campaign staff can handle about 6,000 offers a month."]);
  });
});

describe("pressures raised in chat", () => {
  it("records the scope request as a detected fact when the sponsor reports its id and a key matches", async () => {
    engagementStage = "modelling";
    generateObject.mockResolvedValue(
      turn("Could the model also flag customers we could upsell?", { raisedFrictions: ["[upsell-request]"] }),
    );
    await send("I am starting on the model now.");
    const friction = scenario.personas[0].frictions[0];
    const call = appendWorldFacts.mock.calls.find((c) => (c[3] as string[]).includes(friction.ledger));
    expect(call?.[4]).toBe("detected");
    expect(logEvent.mock.calls.find((c) => c[2] === "friction_raised")?.[3]).toMatchObject({
      stage: "modelling",
      via: "turn",
      frictionId: "upsell-request",
    });
  });

  it("records nothing when a key matches but the id was not reported, or the id without a key", async () => {
    engagementStage = "modelling";
    const friction = scenario.personas[0].frictions[0];
    generateObject.mockResolvedValue(turn("We never upsell to churners."));
    await send("Should the list include upsell targets?");
    generateObject.mockResolvedValue(turn("Could the model do a bit more for us?", { raisedFrictions: ["upsell-request"] }));
    await send("Anything else?");
    expect(appendWorldFacts.mock.calls.some((c) => (c[3] as string[]).includes(friction.ledger))).toBe(false);
    expect(logEvent.mock.calls.some((c) => c[2] === "friction_raised")).toBe(false);
    const half = logEvent.mock.calls.filter((c) => c[2] === "friction_unconfirmed").map((c) => c[3]);
    expect(half).toEqual([
      expect.objectContaining({ frictionId: "upsell-request", reported: false, keyMatched: true }),
      expect.objectContaining({ frictionId: "upsell-request", reported: true, keyMatched: false }),
    ]);
  });

  it("does not list or record a pressure the record already holds", async () => {
    engagementStage = "modelling";
    const friction = scenario.personas[0].frictions[0];
    ledger = [{ fact: friction.ledger, provenance: "system" }];
    generateObject.mockResolvedValue(turn("As I said, the upsell idea stands."));
    await send("Any update?");
    const system = (generateObject.mock.calls[0][0] as { system: string }).system;
    expect(system).not.toContain("# Pressures you bring");
    expect(logEvent.mock.calls.some((c) => c[2] === "friction_raised")).toBe(false);
  });
});

describe("releases", () => {
  it("passes the learner message the data owner answered as the scope message", async () => {
    engagementStage = "data-collection";
    channelPersona = "data-owner";
    generateObject.mockResolvedValue(turn("Released.", { releaseDatasets: ["churn_extract.csv"] }));
    const out = await send("I need subscriber_id, tenure, data usage and churn, one row per subscriber, for retention targeting.");
    expect(recordDataReleases).toHaveBeenCalledTimes(1);
    expect(recordDataReleases.mock.calls[0][4]).toEqual({
      scopeMessageId: out.learnerMessage.id,
      scopeText: "I need subscriber_id, tenure, data usage and churn, one row per subscriber, for retention targeting.",
    });
    // The learner's message is stored before the persona's reply.
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ sender: "learner" });
  });
});

describe("reveals the persona did not report (persona-v5)", () => {
  it("records a detected reveal, forces an audit, and marks it early when the auditor says so", async () => {
    auditPersonaTurn.mockResolvedValue({ consistent: true, disclosedEarly: ["offer-cost"] } as never);
    generateObject.mockResolvedValue(turn("The budget is tight. Each offer costs about S$ 30."));
    // persona-v7: a money question about the offer meets the condition; "the
    // budget" alone no longer does (see the ask_cues tests).
    await send("What does each offer cost?");
    const elicited = logEvent.mock.calls.filter((c) => c[2] === "fact_elicited").map((c) => c[3]);
    expect(elicited).toEqual([expect.objectContaining({ factId: "offer-cost", detection: "detected", verified: true })]);
    expect(auditPersonaTurn).toHaveBeenCalledTimes(1);
    expect(auditPersonaTurn.mock.calls[0][0]).toMatchObject({ reason: "reveal" });
    expect(logEvent.mock.calls.find((c) => c[2] === "fact_elicited_early")?.[3]).toEqual({ factIds: ["offer-cost"] });
    expect(logEvent.mock.calls.find((c) => c[2] === "persona_turn")?.[3]).toMatchObject({ detectedWithheld: ["offer-cost"] });
    // The verified fact reaches the ledger as elicited.
    const ledgerWrite = appendWorldFacts.mock.calls.find((c) => c[4] === "elicited");
    expect(ledgerWrite?.[3]).toEqual(["A retention offer costs about S$30 to serve."]);
  });

  it("does not audit or record when the reply states no withheld fact", async () => {
    generateObject.mockResolvedValue(turn("The budget is tight this quarter."));
    await send("What is the budget?");
    expect(logEvent.mock.calls.some((c) => c[2] === "fact_elicited")).toBe(false);
    expect(auditPersonaTurn).not.toHaveBeenCalled();
  });

  it("does not mark a reveal early when the auditor lists nothing", async () => {
    auditPersonaTurn.mockResolvedValue({ consistent: true, disclosedEarly: [] } as never);
    generateObject.mockResolvedValue(turn("Finance counts a save if they stay six more months.", { revealedWithheld: ["save-definition"] }));
    await send("How does Finance define a save?");
    expect(logEvent.mock.calls.some((c) => c[2] === "fact_elicited_early")).toBe(false);
  });
});


// persona-v6: in chat, a withheld fact of the persona that the learner has
// not obtained may appear only when the learner's current message meets its
// reveal condition (the fact's ask_cues).
describe("withheld facts the learner has not asked for (persona-v6)", () => {
  it("regenerates once when the reply states a fact the message does not ask for", async () => {
    generateObject
      .mockResolvedValueOnce(turn("Churn means a terminated postpaid line. Each offer costs about S$30.", { revealedWithheld: ["offer-cost"] }))
      .mockResolvedValueOnce(turn("Churn means a terminated postpaid line."));
    const out = await send("What does churn mean for you?");
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect((generateObject.mock.calls[1][0] as { system: string }).system).toContain(
      "Your draft stated a point that you keep to yourself until the consultant asks for it: the point you share only when the consultant asks what an offer costs",
    );
    expect(out.message.content).toBe("Churn means a terminated postpaid line.");
    expect(logEvent.mock.calls.find((c) => c[2] === "withheld_leak_blocked")?.[3]).toMatchObject({
      factId: "offer-cost",
      personaId: "client",
      channel: "chat",
      channelId: "chan-1",
      regenerated: true,
      removed: false,
      promptVersion: "persona-v8",
    });
    expect(logEvent.mock.calls.some((c) => c[2] === "fact_elicited")).toBe(false);
  });

  it("removes the sentence when the regenerated reply still states it, and keeps it out of the ledger", async () => {
    generateObject.mockResolvedValue(
      turn("Churn means a terminated postpaid line. Finance counts a save only if they stay six more months.", {
        revealedWithheld: ["save-definition"],
        newFacts: ["Finance counts a save only if the subscriber stays 6 more months."],
      }),
    );
    const out = await send("What does churn mean for you?");
    expect(out.message.content).toBe("Churn means a terminated postpaid line.");
    expect(logEvent.mock.calls.find((c) => c[2] === "withheld_leak_blocked")?.[3]).toMatchObject({
      factId: "save-definition",
      channel: "chat",
      regenerated: true,
      removed: true,
    });
    expect(logEvent.mock.calls.some((c) => c[2] === "fact_elicited")).toBe(false);
    expect(appendWorldFacts.mock.calls.flatMap((c) => c[3] as string[]).some((f) => f.includes("6 more months"))).toBe(false);
  });

  it("falls back to a neutral line when every sentence states the fact", async () => {
    const { PERSONA_WITHHELD_LEAK_FALLBACK } = await import("@/lib/agents/prompt-provenance");
    generateObject.mockResolvedValue(turn("Each offer costs about S$30."));
    const out = await send("Who signs off on the campaign?");
    expect(out.message.content).toBe(PERSONA_WITHHELD_LEAK_FALLBACK);
  });

  it("lets the fact through when the message meets its condition, and records it", async () => {
    generateObject.mockResolvedValue(turn("Each offer costs about S$30 to serve.", { revealedWithheld: ["offer-cost"] }));
    const out = await send("How much does one retention offer cost?");
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(out.message.content).toBe("Each offer costs about S$30 to serve.");
    expect(logEvent.mock.calls.some((c) => c[2] === "withheld_leak_blocked")).toBe(false);
    expect(logEvent.mock.calls.find((c) => c[2] === "fact_elicited")?.[3]).toMatchObject({
      factId: "offer-cost",
      detection: "reported",
      verified: true,
    });
  });

  it("lets a fact through once the learner has obtained it", async () => {
    const { db } = (await import("@/lib/db/client")) as unknown as {
      db: { insert: () => { values: (v: Record<string, unknown>) => Promise<void> } };
    };
    await db.insert().values({ factId: "offer-cost", personaId: "client", verified: true, detection: "reported" });
    generateObject.mockResolvedValue(turn("As I said, each offer costs about S$30."));
    const out = await send("Who signs off on the campaign?");
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(out.message.content).toBe("As I said, each offer costs about S$30.");
    expect(logEvent.mock.calls.some((c) => c[2] === "withheld_leak_blocked")).toBe(false);
  });
});
