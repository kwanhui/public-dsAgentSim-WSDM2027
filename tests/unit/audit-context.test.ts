// The consistency auditor's context (consistency-v3). Under
// consistency-v2 the auditor saw only the ledger, so a data owner truthfully describing a
// defect documented in his own dictionary (duplicate subscriber_id rows) was
// flagged as inventing it. The auditor now also receives the persona's
// public card, the dictionary of the files in play and the release
// profiles. Since consistency-v5 the withheld facts reach it too, in their
// own section with their reveal conditions, so that it can return an
// early-disclosure verdict; they are still never part of the card.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "p", rubricModel: "r" }),
  samplingParams: () => ({}),
  RUBRIC_TEMPERATURE: 0,
}));
const logEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/engagement/state", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import { generateObject } from "ai";
const { auditPersonaTurn, buildAuditContext } = await import("@/lib/agents/consistency");
const { CONSISTENCY_PROMPT_VERSION } = await import("@/lib/agents/prompt-provenance");
const { loadScenario } = await import("@/lib/scenarios/load");

const scenario = await loadScenario("customer-churn");
const marcus = scenario.personas.find((p) => p.role === "data-owner")!;
const sarah = scenario.personas.find((p) => p.role === "client-sponsor")!;

const ledger = [
  { fact: "Meridian Mobile has roughly 480,000 postpaid subscribers.", provenance: "seed" as const },
  {
    fact: "The released file churn_extract.csv has 8170 data rows with columns: subscriber_id, churn; 170 subscriber_id values appear more than once (340 rows).",
    provenance: "release-profile" as const,
  },
  { fact: "Marcus agreed to release the extract for retention modelling.", provenance: "persona" as const },
];

describe("buildAuditContext", () => {
  it("includes the public card, the dictionary in play and the release profile", () => {
    const ctx = buildAuditContext({ scenario, stage: "data-collection", persona: marcus, ledger });
    expect(ctx.card).toBe(marcus.card.trim());
    expect(ctx.dictionary).toContain("churn_extract.csv");
    expect(ctx.dictionary).toContain("pseudonymised subscriber key");
    // The duplicate-row defect is left out of the dictionary; the
    // release profile still records the repeated ids.
    expect(ctx.dictionary).not.toContain("Subscribers who changed");
    expect(ctx.releaseProfile).toContain("170 subscriber_id values appear more than once");
    // The profile is its own section, not repeated in the record.
    expect(ctx.record).not.toContain("The released file");
    expect(ctx.record).toContain("480,000");
    expect(ctx.record).toContain("Marcus agreed");
  });

  it("never puts withheld facts in the card", () => {
    for (const persona of scenario.personas) {
      const ctx = buildAuditContext({ scenario, stage: "deployment", persona, ledger: [] });
      for (const w of persona.withheld) {
        expect(ctx.card).not.toContain(w.fact);
        expect(ctx.card).not.toContain(w.revealWhen);
      }
    }
  });

  it("has no dictionary before any file is in play", () => {
    const ctx = buildAuditContext({ scenario, stage: "formulation", persona: sarah, ledger: [] });
    expect(ctx.dictionary).toBe("(no data files are in play yet)");
    expect(ctx.releaseProfile).toBe("(no files released yet)");
    expect(ctx.record).toBe("(none)");
  });
});

describe("buildAuditContext held-back points (consistency-v5)", () => {
  it("lists each withheld fact with its condition, marking those already shared", () => {
    const ctx = buildAuditContext({ scenario, stage: "formulation", persona: sarah, ledger: [], sharedFactIds: ["offer-cost"] });
    for (const w of sarah.withheld) {
      expect(ctx.heldBack).toContain(`[${w.id}]`);
      expect(ctx.heldBack).toContain(w.revealWhen);
    }
    expect(ctx.heldBack).toMatch(/\[offer-cost\][^\n]*Already shared/);
    expect(ctx.heldBack).not.toMatch(/\[save-definition\][^\n]*Already shared/);
  });
});

describe("validEarlyDisclosures", () => {
  it("keeps the persona's own ids that were not already shared", async () => {
    const { validEarlyDisclosures } = await import("@/lib/agents/consistency");
    expect(validEarlyDisclosures(sarah, ["offer-cost", "[save-definition]", "duplicate-rows", "bogus"], ["save-definition"])).toEqual([
      "offer-cost",
    ]);
    expect(validEarlyDisclosures(sarah, undefined)).toEqual([]);
  });
});

describe("auditPersonaTurn with consistency-v5", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
    logEvent.mockClear();
  });

  it("sends the card, dictionary and profile, and records the version and served model", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { consistent: true, contradiction: null },
      usage: { promptTokens: 3, completionTokens: 1 },
      response: { modelId: "served-judge" },
    } as never);
    await auditPersonaTurn({
      engagement: { id: "e", cohortId: "c" } as never,
      scenario,
      stage: "data-collection",
      persona: marcus,
      reply: "Yes, subscribers who changed plans mid-month appear twice.",
      ledger,
    });
    const call = vi.mocked(generateObject).mock.calls[0][0] as unknown as { system: string };
    expect(call.system).toContain(marcus.card.trim());
    expect(call.system).toContain("A reply that describes a defect, quirk or definition documented here is a truthful disclosure");
    expect(call.system).toContain("Information that none of these sources mentions is not a contradiction");
    expect(call.system).toContain("170 subscriber_id values appear more than once");
    for (const w of marcus.withheld) expect(call.system).toContain(w.revealWhen);
    expect(call.system).toContain("Early disclosure.");
    expect(call.system).not.toMatch(/«[^»]+»/);
    expect(logEvent.mock.calls[0][3]).toMatchObject({
      promptVersion: CONSISTENCY_PROMPT_VERSION,
      servedModel: "served-judge",
    });
    expect(call.system).toContain("Identity questions.");
    expect(call.system).toContain("simulated stakeholder for a course exercise");
    expect(CONSISTENCY_PROMPT_VERSION).toBe("consistency-v6");
    expect(logEvent.mock.calls[0][3]).toMatchObject({ disclosedEarly: [] });
  });

  it("logs an early disclosure verdict with the consultant's message in the prompt", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { consistent: true, contradiction: null, disclosedEarly: ["duplicate-rows"] },
      usage: { promptTokens: 3, completionTokens: 1 },
    } as never);
    await auditPersonaTurn({
      engagement: { id: "e", cohortId: "c" } as never,
      scenario,
      stage: "data-collection",
      persona: marcus,
      reply: "Some subscribers changed plans mid-month, so they have two rows.",
      ledger,
      consultantMessage: "Any quirks I should know about?",
    });
    const call = vi.mocked(generateObject).mock.calls[0][0] as unknown as { prompt: string };
    expect(call.prompt).toContain("Any quirks I should know about?");
    expect(logEvent.mock.calls[0][3]).toMatchObject({ disclosedEarly: ["duplicate-rows"] });
    const early = logEvent.mock.calls.find((c) => c[2] === "early_disclosure_flagged");
    expect(early?.[3]).toMatchObject({ personaId: "data-owner", factIds: ["duplicate-rows"] });
  });
});
