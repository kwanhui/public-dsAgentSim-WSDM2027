// When the data owner releases a file, its deterministic profile must land
// in the world-fact ledger at that moment. The ledger is what every persona
// and the stage-gate judge read, so without this fact the data owner could
// dispute her own extract's row count and a judge could dock the learner for
// citing a number they read straight off the file.

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.fn();
const appendWorldFacts = vi.fn(async (..._args: unknown[]) => {});
const recordDataReleases = vi.fn();
const logEvent = vi.fn(async (..._args: unknown[]) => {});

const RELEASED_CSV = ["subscriber_id,tenure_months", "S1,4", "S2,", "S1,4"].join("\n");

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
  RUBRIC_TEMPERATURE: 0,
}));
vi.mock("@/lib/agents/consistency", () => ({
  shouldAuditTurn: () => false,
  auditPersonaTurn: async () => {},
}));
vi.mock("@/lib/agents/data-environment", () => ({
  recordDataReleases: (...a: unknown[]) => recordDataReleases(...a),
  readReleasedDataset: async () => Buffer.from(RELEASED_CSV, "utf8"),
  releasableDatasets: () => [],
}));
vi.mock("@/lib/db/client", async () => {
  const { createElicitationDbStub } = await import("./support/elicitation-db-stub");
  return { db: createElicitationDbStub().db };
});
vi.mock("@/lib/engagement/state", () => ({
  appendMessage: async (input: { sender: string; content: string }) => ({
    id: 1,
    sender: input.sender,
    content: input.content,
    timestampIso: "2026-08-25T09:00:00Z",
  }),
  appendWorldFacts: (...a: unknown[]) => appendWorldFacts(...a),
  getMessages: async () => [],
  getLedger: async () => [],
  logEvent: (...a: unknown[]) => logEvent(...a),
}));

const { handleLearnerMessage } = await import("@/lib/agents/orchestrator");
const { profileCsv, releaseWorldFact } = await import("@/lib/agents/dataset-profile");
const { loadScenario } = await import("@/lib/scenarios/load");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");

const scenario = await loadScenario("customer-churn");

const ENGAGEMENT = {
  id: "eng-1",
  cohortId: "cohort-1",
  studentId: "student-1",
  scenarioId: "customer-churn",
  currentStage: "data-collection",
  status: "active",
  mode: "learner",
  createdAt: new Date("2026-08-25T09:00:00Z"),
  completedAt: null,
};

const CHANNEL = {
  id: "chan-2",
  engagementId: "eng-1",
  personaId: "data-owner",
  unlockedAt: new Date("2026-08-25T09:00:00Z"),
  createdAt: new Date("2026-08-25T09:00:00Z"),
};

describe("released-file world fact", () => {
  beforeEach(() => {
    generateObject.mockReset();
    appendWorldFacts.mockClear();
    recordDataReleases.mockReset();
  });

  it("writes the released file's shape into the ledger at the release point", async () => {
    generateObject.mockResolvedValue({
      object: {
        reply: "Here is the extract we discussed.",
        newFacts: [],
        releaseDatasets: ["churn_extract.csv"],
      },
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    recordDataReleases.mockResolvedValue(["churn_extract.csv"]);

    const result = await handleLearnerMessage({
      engagement: ENGAGEMENT as never,
      channel: CHANNEL as never,
      scenario,
      config: DEFAULT_COHORT_CONFIG,
      // A release needs a dictionary column and a purpose in the learner's
      // own words (lib/agents/release-scope.ts).
      text: "Could you send over the extract with subscriber_id, tenure and churn, for retention targeting?",
    });

    expect(result.releasedFiles).toEqual(["churn_extract.csv"]);

    const call = appendWorldFacts.mock.calls.find((c) =>
      (c[3] as string[]).some((f) => f.includes("The released file churn_extract.csv")),
    );
    expect(call).toBeDefined();
    const [engagementId, stage, source, facts] = call as [string, string, string, string[]];
    expect(engagementId).toBe("eng-1");
    expect(stage).toBe("data-collection");
    expect(source).toBe("system");

    const fact = (facts as string[]).find((f) => f.includes("churn_extract.csv")) as string;
    // Row count, columns, and the seeded quirks, exactly as profiled.
    expect(fact).toContain("3 data rows");
    expect(fact).toContain("columns: subscriber_id, tenure_months");
    expect(fact).toContain("1 exact duplicate row");
    expect(fact).toContain("missing values in tenure_months (1)");
    // The scenario's own description of the file grounds what the extract is.
    expect(fact).toContain("Postpaid subscriber extract");
    // The dictionary's notable semantics travel with the release, so judges
    // and personas honour what the dictionary established (churn label
    // definition, text-typed total_charges) instead of disputing it.
    expect(fact).toContain("Per the data dictionary:");
    expect(fact).toContain("involuntary");
  });

  it("writes no profile fact when the persona releases nothing", async () => {
    generateObject.mockResolvedValue({
      object: { reply: "Not yet — scope first.", newFacts: [], releaseDatasets: [] },
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    await handleLearnerMessage({
      engagement: ENGAGEMENT as never,
      channel: CHANNEL as never,
      scenario,
      config: DEFAULT_COHORT_CONFIG,
      text: "Could you send over the extract?",
    });

    expect(recordDataReleases).not.toHaveBeenCalled();
    const factLists = appendWorldFacts.mock.calls.map((c) => c[3] as string[]);
    expect(factLists.flat().some((f) => f.includes("released file"))).toBe(false);
  });
});

describe("releaseWorldFact", () => {
  it("skips the notable clauses when a file has no quirks", () => {
    const profile = profileCsv("clean.csv", ["a,b", "1,x", "2,y"].join("\n"));
    expect(releaseWorldFact(profile)).toBe(
      "The released file clean.csv has 2 data rows with columns: a, b. Column profile: a numeric, min 1, max 2, mean 1.5.",
    );
  });

  it("pluralises duplicate rows and lists every column with missing values", () => {
    const profile = profileCsv(
      "quirky.csv",
      ["a,b", "1,", "1,", "1,", ",x"].join("\n"),
    );
    const fact = releaseWorldFact(profile, { description: "a test extract" });
    expect(fact).toContain("quirky.csv (a test extract)");
    expect(fact).toContain("2 exact duplicate rows");
    expect(fact).toContain("missing values in a (1), b (3)");
  });

  it("summarises repeated text values and date spans, and skips id-like columns", () => {
    const profile = profileCsv(
      "t.csv",
      ["id,kind,day", "a1,x,2025-01-02", "a2,x,2025-03-04", "a3,y,2025-02-01"].join("\n"),
    );
    const fact = releaseWorldFact(profile);
    expect(fact).toContain("kind most frequent x (2), y (1)");
    expect(fact).toContain("day dates from 2025-01-02 to 2025-03-04");
    expect(fact).not.toContain("id most frequent");
  });

  it("appends the dictionary notes as a readable sentence, not a dump", () => {
    const profile = profileCsv("clean.csv", ["a,b", "1,x", "2,y"].join("\n"));
    const fact = releaseWorldFact(profile, {
      description: "a test extract",
      notes: 'The "drinks" category covers coffee and all other beverages.\n',
    });
    expect(fact).toBe(
      'The released file clean.csv (a test extract) has 2 data rows with columns: a, b. ' +
        "Column profile: a numeric, min 1, max 2, mean 1.5. " +
        'Per the data dictionary: The "drinks" category covers coffee and all other beverages.',
    );
  });
});
