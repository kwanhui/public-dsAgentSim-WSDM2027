// The cohort's research.ledger switch. On, the
// default, the persona prompt is exactly what it was before the switch
// existed. Off, the engagement record section is left out of the prompt and
// nothing else changes: facts are still read, appended and audited.

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const appendMessage = vi.fn();
const appendWorldFacts = vi.fn(async (..._a: unknown[]) => {});
const logEvent = vi.fn(async (..._args: unknown[]) => {});
const auditPersonaTurn = vi.fn(async (..._a: unknown[]) => {});

const LEDGER_FACT = "The consultant agreed with Sarah that the scope is postpaid only.";

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
}));
vi.mock("@/lib/agents/consistency", () => ({
  // Every turn is audited here, so the test can see the auditor still runs.
  shouldAuditTurn: () => true,
  auditPersonaTurn: (...a: unknown[]) => auditPersonaTurn(...a),
}));
vi.mock("@/lib/agents/data-environment", () => ({
  releasableDatasets: () => [],
  recordDataReleases: async () => [],
}));
vi.mock("@/lib/agents/dataset-profile", () => ({ profileReleasedDatasets: async () => [], releaseWorldFact: () => "" }));
vi.mock("@/lib/db/client", async () => {
  const { createElicitationDbStub } = await import("./support/elicitation-db-stub");
  return { db: createElicitationDbStub().db };
});
vi.mock("@/lib/engagement/state", () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  appendWorldFacts: (...a: unknown[]) => appendWorldFacts(...a),
  countLearnerMessages: async () => 1,
  getEvents: async () => [],
  getMessages: async () => [],
  getLedger: async () => [{ fact: LEDGER_FACT, provenance: "persona" }],
  logEvent: (...a: unknown[]) => logEvent(...a),
}));

const { handleLearnerMessage } = await import("@/lib/agents/orchestrator");
const { buildPersonaSystemPrompt } = await import("@/lib/agents/persona");
const { resetElicitationDbStubs } = await import("./support/elicitation-db-stub");
const { loadScenario } = await import("@/lib/scenarios/load");
const { CohortConfigSchema, DEFAULT_COHORT_CONFIG, NEW_COHORT_CONFIG, parseCohortConfig } = await import(
  "@/lib/cohort/defaults"
);
const { PERSONA_RECORD_SECTION } = await import("@/lib/agents/prompt-provenance");
const scenario = await loadScenario("customer-churn");
const client = scenario.personas.find((p) => p.role === "client-sponsor")!;

const RECORD_HEADING = PERSONA_RECORD_SECTION.split("\n")[0];

function send(ledger: boolean) {
  return handleLearnerMessage({
    engagement: {
      id: "eng-1",
      cohortId: "cohort-1",
      scenarioId: "customer-churn",
      currentStage: "formulation",
      status: "active",
      mode: "learner",
    } as never,
    channel: { id: "chan-1", engagementId: "eng-1", personaId: "client", unlockedAt: new Date() } as never,
    scenario,
    config: { ...DEFAULT_COHORT_CONFIG, research: { ...DEFAULT_COHORT_CONFIG.research, ledger } },
    text: "What is the scope of the work?",
  });
}

beforeEach(() => {
  generateObject.mockReset().mockResolvedValue({
    object: {
      reply: "Postpaid only. Prepaid is out of scope.",
      newFacts: ["Prepaid subscribers are out of scope."],
      revealedWithheld: [],
      releaseDatasets: [],
      raisedFrictions: [],
    },
    usage: { promptTokens: 10, completionTokens: 4 },
  });
  appendWorldFacts.mockClear();
  logEvent.mockClear();
  auditPersonaTurn.mockReset().mockResolvedValue(undefined);
  resetElicitationDbStubs();
  let id = 100;
  appendMessage.mockReset().mockImplementation(async (row: { sender: string; content: string }) => ({
    id: ++id,
    sender: row.sender,
    content: row.content,
    timestampIso: "t",
  }));
});

describe("research.ledger in the cohort config", () => {
  it("defaults to true in the schema, the default config and the new-cohort config", () => {
    expect(DEFAULT_COHORT_CONFIG.research.ledger).toBe(true);
    expect(NEW_COHORT_CONFIG.research.ledger).toBe(true);
    // A stored config from before the key existed parses as on.
    const older: Partial<typeof DEFAULT_COHORT_CONFIG.research> = { ...DEFAULT_COHORT_CONFIG.research };
    delete older.ledger;
    const parsed = CohortConfigSchema.parse({ ...DEFAULT_COHORT_CONFIG, research: older });
    expect(parsed.research.ledger).toBe(true);
    expect(parseCohortConfig({ ...DEFAULT_COHORT_CONFIG, research: { ...older, ledger: false } }).research.ledger).toBe(
      false,
    );
  });
});

describe("buildPersonaSystemPrompt with and without the ledger", () => {
  const base = { scenario, persona: client, stage: "formulation" as const, worldFacts: [LEDGER_FACT] };

  it("is unchanged when includeLedger is true or left out", () => {
    const before = buildPersonaSystemPrompt(base);
    expect(buildPersonaSystemPrompt({ ...base, includeLedger: true })).toBe(before);
    expect(before).toContain(RECORD_HEADING);
    expect(before).toContain(`- ${LEDGER_FACT}`);
  });

  it("leaves out only the record section when includeLedger is false", () => {
    const on = buildPersonaSystemPrompt(base);
    const off = buildPersonaSystemPrompt({ ...base, includeLedger: false });
    expect(off).not.toContain(RECORD_HEADING);
    expect(off).not.toContain(LEDGER_FACT);
    const record = `${RECORD_HEADING}${PERSONA_RECORD_SECTION.slice(RECORD_HEADING.length).replace(
      "«engagement record»",
      `- ${LEDGER_FACT}`,
    )}`;
    expect(on.replace(`\n\n${record}`, "")).toBe(off);
  });
});

describe("handleLearnerMessage under research.ledger", () => {
  it("sends the same prompt as before the switch existed when the ledger is on", async () => {
    await send(true);
    const system = generateObject.mock.calls[0][0].system as string;
    expect(system).toBe(
      buildPersonaSystemPrompt({ scenario, persona: client, stage: "formulation", worldFacts: [LEDGER_FACT] }),
    );
    expect(system).toContain(LEDGER_FACT);
  });

  it("drops the record from the prompt when off, and still appends facts and audits", async () => {
    await send(false);
    const system = generateObject.mock.calls[0][0].system as string;
    expect(system).not.toContain(RECORD_HEADING);
    expect(system).not.toContain(LEDGER_FACT);
    // Fact extraction and the ledger write are untouched.
    expect(appendWorldFacts).toHaveBeenCalledWith("eng-1", "formulation", "client", [
      "Prepaid subscribers are out of scope.",
    ]);
    // The auditor still reads the ledger as it stood before the turn.
    expect(auditPersonaTurn).toHaveBeenCalledTimes(1);
    expect((auditPersonaTurn.mock.calls[0][0] as { ledger: unknown }).ledger).toEqual([
      { fact: LEDGER_FACT, provenance: "persona" },
    ]);
    // The turn is logged as usual.
    expect(logEvent.mock.calls.some((c) => c[2] === "persona_turn")).toBe(true);
  });
});
