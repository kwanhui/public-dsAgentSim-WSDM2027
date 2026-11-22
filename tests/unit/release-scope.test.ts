// The data owner's release precondition (lib/agents/release-scope.ts): a
// release goes through only when the learner's own messages in the channel
// name a column of the file's dictionary and state a purpose. The earlier
// probes are here: "send me everything" and a "Yes, confirmed" to a scope
// the data owner drafted must not release the file.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkReleaseScope,
  columnPhrases,
  dictionaryColumns,
  SCOPE_TEXT_MAX_CHARS,
  withheldReleaseReply,
} from "@/lib/agents/release-scope";
import { PERSONA_RELEASE_ASK } from "@/lib/agents/prompt-provenance";
import { loadScenario } from "@/lib/scenarios/load";

const churn = await loadScenario("customer-churn");
const seg = await loadScenario("customer-segmentation");
const bakery = await loadScenario("demand-forecasting");
const churnFile = churn.datasets[0];

describe("dictionary columns", () => {
  it("reads every column name, including a grouped line", () => {
    expect(dictionaryColumns(churnFile.dictionary)).toContain("data_usage_gb");
    expect(dictionaryColumns(churnFile.dictionary)).toHaveLength(14);
    expect(dictionaryColumns(seg.datasets[0].dictionary)).toEqual(
      expect.arrayContaining(["member_id", "share_fresh", "share_premium", "promo_share"]),
    );
    expect(dictionaryColumns(bakery.datasets[0].dictionary)).toEqual([
      "date",
      "outlet_id",
      "category",
      "units_sold",
      "sales_sgd",
      "promo_flag",
    ]);
  });

  it("counts a stem without units, but not a title word on its own", () => {
    const title = new Set(["postpaid", "churn", "at", "meridian", "mobile"]);
    expect(columnPhrases("data_usage_gb", title)).toEqual(["data usage gb", "data usage"]);
    expect(columnPhrases("tenure_months", title)).toEqual(["tenure months", "tenure"]);
    expect(columnPhrases("subscriber_id", title)).toEqual(["subscriber id"]);
    expect(columnPhrases("churn", title)).toEqual([]);
  });
});

describe("checkReleaseScope", () => {
  const check = (...learnerMessages: string[]) =>
    checkReleaseScope({ scenario: churn, dataset: churnFile, learnerMessages });

  it("refuses 'send me everything'", () => {
    expect(check("Hi Marcus, can you send me everything you have?")).toMatchObject({
      ok: false,
      missing: ["column", "purpose"],
      scopeText: null,
    });
  });

  it("refuses a 'Yes, confirmed' to a scope the data owner drafted", () => {
    const r = check("Hi Marcus, can you send me everything?", "Yes, confirmed, that scope is fine.");
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("column");
  });

  it("refuses a message that names the project but no field", () => {
    expect(check("I need the data for the churn project.")).toMatchObject({ ok: false, missing: ["column"] });
  });

  it("releases when the learner's messages name a column and a purpose, across messages", () => {
    const r = check("I need tenure, contract type and data usage per subscriber.", "It is to predict who leaves next month.");
    expect(r).toMatchObject({ ok: true, missing: [] });
    expect(r.columns).toEqual(["tenure_months", "contract_type", "data_usage_gb"]);
    expect(r.scopeText).toBe(
      "I need tenure, contract type and data usage per subscriber. / It is to predict who leaves next month.",
    );
  });

  it("accepts the reference run's scope message", () => {
    const h1 =
      "For that I need, at subscriber level and pseudonymised: subscriber attributes (tenure, contract type and end date, plan fee), usage (data, voice), billing (charges, payment method, late payments), and a churn label. Purpose: train and validate a model that ranks subscribers by churn risk.";
    expect(check(h1).ok).toBe(true);
  });

  it("matches underscores and spaces alike, case-insensitively", () => {
    expect(check("Please send SUBSCRIBER_ID and Late Payments so that we can rank risk.").ok).toBe(true);
  });

  it("keeps at most SCOPE_TEXT_MAX_CHARS of the scope text", () => {
    const r = check(`I need tenure for retention targeting. ${"x".repeat(900)}`);
    expect(r.scopeText?.length).toBe(SCOPE_TEXT_MAX_CHARS);
  });
});

describe("withheldReleaseReply", () => {
  it("drops the handover sentence and asks for what is missing", () => {
    expect(withheldReleaseReply("That scope works. I've attached the extract.", ["column", "purpose"])).toBe(
      PERSONA_RELEASE_ASK.both,
    );
    // The mock data owner's canned release.
    expect(
      withheldReleaseReply(
        "That scope works for me. I'm releasing churn_extract.csv to you now. It is as-is from the warehouse.",
        ["column"],
      ),
    ).toBe(`It is as-is from the warehouse. ${PERSONA_RELEASE_ASK.column}`);
    expect(withheldReleaseReply("Here is the file.", ["purpose"])).toBe(PERSONA_RELEASE_ASK.purpose);
  });

  it("adds nothing when the reply already asks", () => {
    expect(withheldReleaseReply("Which fields do you need from it?", ["column"])).toBe(
      "Which fields do you need from it?",
    );
  });
});

// The chat turn: a release that fails the check is dropped and logged, and
// one that passes stores the scope text.
const generateObject = vi.fn();
const appendMessage = vi.fn();
const logEvent = vi.fn(async (..._a: unknown[]) => {});
const recordDataReleases = vi.fn(async (..._a: unknown[]) => [] as string[]);
let history: { id: number; sender: string; content: string; timestampIso: string }[] = [];

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
}));
vi.mock("@/lib/agents/consistency", () => ({ shouldAuditTurn: () => false, auditPersonaTurn: async () => null }));
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
  appendWorldFacts: async () => {},
  countLearnerMessages: async () => 2,
  getEvents: async () => [],
  getMessages: async () => history,
  getLedger: async () => [],
  logEvent: (...a: unknown[]) => logEvent(...a),
}));

const { handleLearnerMessage } = await import("@/lib/agents/orchestrator");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");

function send(text: string) {
  return handleLearnerMessage({
    engagement: { id: "e", cohortId: "c", scenarioId: churn.id, currentStage: "data-collection", status: "active" } as never,
    channel: { id: "ch", engagementId: "e", personaId: "data-owner", unlockedAt: new Date() } as never,
    scenario: churn,
    config: DEFAULT_COHORT_CONFIG,
    text,
  });
}

function releasing(reply: string) {
  return {
    object: { reply, newFacts: ["Marcus released the churn extract."], revealedWithheld: [], releaseDatasets: ["churn_extract.csv"] },
    usage: { promptTokens: 1, completionTokens: 1 },
  };
}

describe("release check in a chat turn", () => {
  beforeEach(() => {
    generateObject.mockReset();
    logEvent.mockClear();
    recordDataReleases.mockReset().mockResolvedValue(["churn_extract.csv"]);
    history = [];
    let id = 0;
    appendMessage.mockReset().mockImplementation(async (row: { sender: string; content: string }) => ({
      id: ++id,
      sender: row.sender,
      content: row.content,
      timestampIso: "t",
    }));
  });

  it("drops the release on 'send me everything', logs it, and asks in role", async () => {
    generateObject.mockResolvedValue(releasing("Sure. I've attached the extract."));
    const out = await send("Send me everything you have.");
    expect(recordDataReleases).not.toHaveBeenCalled();
    expect(out.releasedFiles).toEqual([]);
    expect(out.message.content).toBe(`Sure. ${PERSONA_RELEASE_ASK.both}`);
    expect(logEvent.mock.calls.find((c) => c[2] === "release_withheld")?.[3]).toMatchObject({
      file: "churn_extract.csv",
      missing: ["column", "purpose"],
    });
    expect(logEvent.mock.calls.find((c) => c[2] === "persona_turn")?.[3]).toMatchObject({
      releaseWithheld: ["churn_extract.csv"],
      newFacts: 0,
    });
  });

  it("drops the release on 'Yes, confirmed' after the data owner drafted the scope", async () => {
    history = [
      { id: 1, sender: "learner", content: "Can you send me everything?", timestampIso: "t" },
      {
        id: 2,
        sender: "data-owner",
        content: "For a churn model I'd expect subscriber attributes, usage and billing. Is that the scope?",
        timestampIso: "t",
      },
    ];
    generateObject.mockResolvedValue(releasing("Good. Releasing it now."));
    const out = await send("Yes, confirmed, that scope is fine.");
    expect(recordDataReleases).not.toHaveBeenCalled();
    // Neither of the learner's messages names a field or a purpose.
    expect(out.message.content).toBe(`Good. ${PERSONA_RELEASE_ASK.both}`);
  });

  it("releases on a scope in the learner's own words and stores the text", async () => {
    generateObject.mockResolvedValue(releasing("Released."));
    const text = "I need subscriber_id, tenure and data usage, one row per subscriber, to predict churn for the call list.";
    const out = await send(text);
    expect(out.releasedFiles).toEqual(["churn_extract.csv"]);
    expect(recordDataReleases.mock.calls[0][4]).toEqual({ scopeMessageId: out.learnerMessage.id, scopeText: text });
  });
});
