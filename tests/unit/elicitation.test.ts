// Elicitation trace. A persona reports the
// ids of withheld facts it reveals; the server logs fact_elicited once per
// fact; getElicitationSummary reports hidden facts obtained out of those in
// the scenario, and the learner messages before each. Run against PGlite
// with the real migrations for the stored path.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("@/lib/db/schema");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "lib/db/migrations" });
  return { db };
});

const { db } = await import("@/lib/db/client");
const schema = await import("@/lib/db/schema");
const { eq } = await import("drizzle-orm");
const { createEngagement, getEvents, advanceStage, completeEngagement } = await import("@/lib/engagement/state");
const { FACT_ELICITED_EVENT, getElicitationSummary, recordElicitedFacts, summariseElicitation } = await import(
  "@/lib/engagement/elicitation"
);
const { loadScenario } = await import("@/lib/scenarios/load");

const scenario = await loadScenario("customer-churn");
const ALL_IDS = scenario.personas.flatMap((p) => p.withheld.map((w) => w.id));

async function freshEngagement(n: number) {
  await db.insert(schema.users).values({ id: `eu${n}`, email: `eu${n}`, role: "instructor" });
  await db.insert(schema.cohorts).values({ id: `ec${n}`, slug: `ec${n}`, name: "T", instructorId: `eu${n}`, configJson: {} });
  const [student] = await db.insert(schema.students).values({ cohortId: `ec${n}`, learnerHash: `eh${n}` }).returning();
  return createEngagement(`ec${n}`, student.id, scenario);
}

describe("findKey and verifyReveal (pure)", () => {
  it("matches a key at a word start, case-insensitively, without running into another digit", async () => {
    const { findKey } = await import("@/lib/engagement/elicitation");
    expect(findKey("An offer costs us about S$30 to serve.", ["$30"])).toBe("$30");
    expect(findKey("A budget of S$300 is fine.", ["$30"])).toBeNull();
    expect(findKey("Plan changes mid-month add a row.", ["plan change"])).toBe("plan change");
    expect(findKey("We are training staff.", ["rain"])).toBeNull();
    expect(findKey("Heavy rain kills walk-ins.", ["rain"])).toBe("rain");
    expect(findKey("Capacity is 6,000 a month.", ["6000"])).toBe("6000");
    expect(findKey("ids that begin with \u201cT\u201d", ['"T"'])).toBe('"T"');
  });

  it("verifies a reported reveal only when the reply states a key", async () => {
    const { verifyReveal } = await import("@/lib/engagement/elicitation");
    const offer = scenario.personas[0].withheld.find((w) => w.id === "offer-cost")!;
    expect(verifyReveal(offer, "It is about S$30 an offer.")).toEqual({ verified: true, matchedKey: "$30" });
    expect(verifyReveal(offer, "Money is tight this quarter.")).toEqual({ verified: false, matchedKey: null });
  });
});

describe("summariseElicitation (pure)", () => {
  it("counts every withheld fact in the scenario and the reachable ones at the stage", () => {
    const s = summariseElicitation(scenario, [], "formulation");
    expect(s.total).toBe(ALL_IDS.length);
    expect(s.total).toBe(4);
    // Only the client sponsor's channel is open at formulation.
    expect(s.reachable).toBe(2);
    expect(s.obtained).toBe(0);
    expect(s.verified).toBe(0);
    expect(s.facts.map((f) => f.id)).toEqual(ALL_IDS);
    expect(s.facts.every((f) => f.obtainedAtLearnerMessage === null)).toBe(true);
    expect(summariseElicitation(scenario, [], null).reachable).toBe(4);
  });

  it("takes the earliest learner-message count per fact, counts verified reveals apart, and ignores other events", () => {
    const events = [
      { type: "persona_turn", detailJson: { factId: "offer-cost", learnerMessagesSoFar: 1 } },
      { type: FACT_ELICITED_EVENT, detailJson: { factId: "offer-cost", persona: "client", turnIndex: 3, learnerMessagesSoFar: 4, verified: false } },
      { type: FACT_ELICITED_EVENT, detailJson: { factId: "offer-cost", persona: "client", turnIndex: 5, learnerMessagesSoFar: 9, verified: true } },
      { type: FACT_ELICITED_EVENT, detailJson: { factId: "duplicate-rows", persona: "data-owner", turnIndex: 1, learnerMessagesSoFar: 6 } },
      { type: FACT_ELICITED_EVENT, detailJson: null },
    ];
    const s = summariseElicitation(scenario, events, "data-collection");
    expect(s.obtained).toBe(2);
    // The duplicate-rows event predates verification, so it counts as reported only.
    expect(s.verified).toBe(1);
    expect(s.reachable).toBe(4);
    expect(s.facts.find((f) => f.id === "offer-cost")).toEqual({
      id: "offer-cost",
      persona: "client",
      obtainedAtLearnerMessage: 4,
      verifiedAtLearnerMessage: 9,
      detection: "reported",
      early: false,
    });
    expect(s.facts.find((f) => f.id === "duplicate-rows")?.obtainedAtLearnerMessage).toBe(6);
    expect(s.facts.find((f) => f.id === "save-definition")?.obtainedAtLearnerMessage).toBeNull();
  });
});

describe("recordElicitedFacts and getElicitationSummary (PGlite)", () => {
  const client = scenario.personas.find((p) => p.id === "client")!;
  const owner = scenario.personas.find((p) => p.id === "data-owner")!;

  it("records each fact once in fact_elicitations and the event log, verified against the reply", async () => {
    const e = await freshEngagement(1);
    const first = await recordElicitedFacts({
      engagement: e,
      persona: client,
      factIds: ["offer-cost", "offer-cost", "duplicate-rows"],
      reply: "Each offer costs about S$30.",
      stage: "formulation",
      source: "turn",
      turnIndex: 2,
      learnerMessagesSoFar: 3,
      messageId: 11,
    });
    // duplicate-rows is not the client's fact.
    expect(first).toEqual([{ factId: "offer-cost", verified: true, matchedKey: "$30", detection: "reported" }]);
    const again = await recordElicitedFacts({
      engagement: e,
      persona: client,
      factIds: ["offer-cost", "save-definition"],
      reply: "Finance has its own rule on that.",
      stage: "formulation",
      source: "turn",
      turnIndex: 4,
      learnerMessagesSoFar: 6,
    });
    expect(again).toEqual([{ factId: "save-definition", verified: false, matchedKey: null, detection: "reported" }]);
    const logged = (await getEvents(e.id)).filter((ev) => ev.type === FACT_ELICITED_EVENT);
    expect(logged.map((ev) => ev.detailJson)).toEqual([
      { factId: "offer-cost", persona: "client", turnIndex: 2, learnerMessagesSoFar: 3, verified: true, matchedKey: "$30", detection: "reported" },
      { factId: "save-definition", persona: "client", turnIndex: 4, learnerMessagesSoFar: 6, verified: false, matchedKey: null, detection: "reported" },
    ]);
    const rows = await db.select().from(schema.factElicitations).where(eq(schema.factElicitations.engagementId, e.id));
    expect(rows.map((r) => [r.factId, r.verified, r.messageId, r.source])).toEqual([
      ["offer-cost", true, 11, "turn"],
      ["save-definition", false, null, "turn"],
    ]);

    // A later reply that states the fact verifies the stored row.
    const later = await recordElicitedFacts({
      engagement: e,
      persona: client,
      factIds: ["save-definition"],
      reply: "A save counts only if they stay six more months.",
      stage: "formulation",
      source: "reaction",
      turnIndex: 5,
      learnerMessagesSoFar: 7,
    });
    expect(later).toEqual([{ factId: "save-definition", verified: true, matchedKey: "6 more month", detection: "reported" }]);
    const [row] = await db
      .select()
      .from(schema.factElicitations)
      .where(eq(schema.factElicitations.factId, "save-definition"));
    expect(row.verified).toBe(true);
    expect(row.verifiedAt).not.toBeNull();
  });

  it("summarises a stored engagement from the table, widening reach as stages open", async () => {
    const e = await freshEngagement(2);
    await recordElicitedFacts({
      engagement: e,
      persona: client,
      factIds: ["offer-cost"],
      reply: "About S$30 each.",
      stage: "formulation",
      source: "turn",
      turnIndex: 1,
      learnerMessagesSoFar: 2,
    });
    let summary = await getElicitationSummary(e.id);
    expect(summary).toMatchObject({ total: 4, reachable: 2, obtained: 1, verified: 1 });
    expect(summary.facts[0]).toEqual({
      id: "offer-cost",
      persona: "client",
      obtainedAtLearnerMessage: 2,
      verifiedAtLearnerMessage: 2,
      detection: "reported",
      early: false,
    });
    expect(summary.recorded).toBe(true);

    await advanceStage(e.id, "data-collection", scenario);
    await recordElicitedFacts({
      engagement: e,
      persona: owner,
      factIds: ["duplicate-rows"],
      reply: "Yes, there are some.",
      stage: "data-collection",
      source: "turn",
      turnIndex: 3,
      learnerMessagesSoFar: 8,
    });
    summary = await getElicitationSummary(e.id);
    expect(summary).toMatchObject({ total: 4, reachable: 4, obtained: 2, verified: 1 });

    // The table outlives the event purge: the summary still holds without events.
    await db.delete(schema.events).where(eq(schema.events.engagementId, e.id));
    expect(await getElicitationSummary(e.id)).toMatchObject({ obtained: 2, verified: 1 });

    await completeEngagement(e.id);
    expect((await getElicitationSummary(e.id)).reachable).toBe(4);
  });

  it("throws for an unknown engagement", async () => {
    await expect(getElicitationSummary("no-such-engagement")).rejects.toThrow(/Unknown engagement/);
    // The engagements table is untouched by the lookup.
    expect(await db.select().from(schema.engagements).where(eq(schema.engagements.id, "no-such-engagement"))).toEqual([]);
  });
});

describe("round-4 trace: detection, ledger, early marks (PGlite)", () => {
  const client = scenario.personas.find((p) => p.id === "client")!;

  it("records a reveal the persona did not report, verified by key, and writes the fact to the ledger once", async () => {
    const { recordRevealsInReply } = await import("@/lib/engagement/elicitation");
    const { getLedger } = await import("@/lib/engagement/state");
    const e = await freshEngagement(10);
    const found = await recordRevealsInReply({
      engagement: e,
      persona: client,
      reportedIds: [],
      reply: "Finance counts it only if they stay with us for a further six months.",
      stage: "formulation",
      source: "turn",
      turnIndex: 2,
      learnerMessagesSoFar: 3,
    });
    expect(found).toEqual([
      { factId: "save-definition", verified: true, matchedKey: "further 6 month", detection: "detected" },
    ]);
    const rows = await db.select().from(schema.factElicitations).where(eq(schema.factElicitations.engagementId, e.id));
    expect(rows.map((r) => [r.factId, r.detection, r.verified, r.early])).toEqual([["save-definition", "detected", true, false]]);
    // A second statement of the same fact adds nothing.
    await recordRevealsInReply({
      engagement: e,
      persona: client,
      reportedIds: ["save-definition"],
      reply: "As I said, six more months.",
      stage: "formulation",
      source: "turn",
      turnIndex: 3,
      learnerMessagesSoFar: 4,
    });
    const elicited = (await getLedger(e.id)).filter((f) => f.provenance === "elicited");
    expect(elicited).toEqual([
      expect.objectContaining({ fact: client.withheld.find((w) => w.id === "save-definition")!.statement, source: "client" }),
    ]);
    const summary = await getElicitationSummary(e.id);
    expect(summary).toMatchObject({ obtained: 1, verified: 1, detected: 1, early: 0 });
  });

  it("writes an unverified report to no ledger, and the fact once it is verified", async () => {
    const { getLedger } = await import("@/lib/engagement/state");
    const e = await freshEngagement(11);
    await recordElicitedFacts({
      engagement: e,
      persona: client,
      factIds: ["offer-cost"],
      reply: "Money is tight.",
      stage: "formulation",
      source: "turn",
      turnIndex: 1,
      learnerMessagesSoFar: 1,
    });
    expect((await getLedger(e.id)).some((f) => f.provenance === "elicited")).toBe(false);
    await recordElicitedFacts({
      engagement: e,
      persona: client,
      factIds: ["offer-cost"],
      reply: "It is S$ 30 an offer.",
      stage: "formulation",
      source: "turn",
      turnIndex: 2,
      learnerMessagesSoFar: 2,
    });
    expect((await getLedger(e.id)).filter((f) => f.provenance === "elicited").map((f) => f.fact)).toEqual([
      "A retention offer costs about S$30 to serve.",
    ]);
  });

  it("marks a reveal the auditor flagged as early, and the summary counts it", async () => {
    const { markEarlyDisclosures, getElicitationSummary: summary } = await import("@/lib/engagement/elicitation");
    const e = await freshEngagement(12);
    await recordElicitedFacts({
      engagement: e,
      persona: client,
      factIds: ["offer-cost"],
      reply: "About S$30 each.",
      stage: "formulation",
      source: "turn",
      turnIndex: 1,
      learnerMessagesSoFar: 1,
    });
    await markEarlyDisclosures(e, ["offer-cost"]);
    const s = await summary(e.id);
    expect(s.early).toBe(1);
    expect(s.facts.find((f) => f.id === "offer-cost")?.early).toBe(true);
    expect((await getEvents(e.id)).some((ev) => ev.type === "fact_elicited_early")).toBe(true);
  });

  it("marks new engagements as traced, so an empty trace reads as 0 obtained", async () => {
    const { getElicitationTraceRecorded } = await import("@/lib/engagement/elicitation");
    const e = await freshEngagement(13);
    expect(e.elicitationTrace).toBe(true);
    expect(await getElicitationTraceRecorded(e.id)).toBe(true);
    // A run restored without the flag and with pre-v3 persona events has no trace.
    await db.update(schema.engagements).set({ elicitationTrace: null }).where(eq(schema.engagements.id, e.id));
    expect(await getElicitationTraceRecorded(e.id)).toBe(false);
  });
});

describe("elicitationTraceRecorded (pure)", () => {
  it("tells a run that predates the trace from one that obtained nothing", async () => {
    const { elicitationTraceRecorded } = await import("@/lib/engagement/elicitation");
    const turn = (promptVersion?: string) => ({ type: "persona_turn", detailJson: promptVersion ? { promptVersion } : {} });
    expect(elicitationTraceRecorded({ elicitationTrace: true, events: [] })).toBe(true);
    expect(elicitationTraceRecorded({ elicitationTrace: null, events: [] })).toBe(false);
    expect(elicitationTraceRecorded({ elicitationTrace: null, events: [turn(), turn("persona-v2")] })).toBe(false);
    expect(elicitationTraceRecorded({ elicitationTrace: null, events: [turn("persona-v3")] })).toBe(true);
    expect(elicitationTraceRecorded({ events: [{ type: FACT_ELICITED_EVENT, detailJson: {} }] })).toBe(true);
  });
});

describe("detectUnreportedReveals and statedButNotElicited (pure)", () => {
  it("scans only the persona's own facts and skips facts already verified", async () => {
    const { detectUnreportedReveals } = await import("@/lib/engagement/elicitation");
    const client = scenario.personas.find((p) => p.id === "client")!;
    const owner = scenario.personas.find((p) => p.id === "data-owner")!;
    expect(detectUnreportedReveals(client, "It is S$30 an offer and a six-month save.").map((d) => d.factId)).toEqual([
      "offer-cost",
      "save-definition",
    ]);
    expect(detectUnreportedReveals(client, "It is S$30 an offer.", ["offer-cost"])).toEqual([]);
    // The data owner saying "6 more months" is not the sponsor's fact.
    expect(detectUnreportedReveals(owner, "Tickets cover the last 6 months.")).toEqual([]);
  });

  it("flags a withheld value the submission states that the trace does not show as obtained", async () => {
    const { statedButNotElicited } = await import("@/lib/engagement/elicitation");
    const constraints = scenario.stages[0].gate.rubric.find((c) => c.id === "constraints")!;
    const memo = "Offers cost S$30 each and Finance counts a save if the subscriber stays 6 more months.";
    expect(statedButNotElicited({ scenario, criterion: constraints, submissionText: memo, obtainedFactIds: [] })).toEqual([
      "offer-cost",
      "save-definition",
    ]);
    expect(
      statedButNotElicited({ scenario, criterion: constraints, submissionText: memo, obtainedFactIds: ["offer-cost"] }),
    ).toEqual(["save-definition"]);
    // A criterion that names neither fact flags neither.
    const objective = scenario.stages[0].gate.rubric.find((c) => c.id === "objective")!;
    expect(statedButNotElicited({ scenario, criterion: objective, submissionText: memo, obtainedFactIds: [] })).toEqual([]);
  });

  it("leaves out a defect that profiling the file reveals", async () => {
    const { statedButNotElicited } = await import("@/lib/engagement/elicitation");
    const seg = await loadScenario("customer-segmentation");
    const risks = seg.stages[1].gate.rubric.find((c) => c.id === "quality-risks")!;
    expect(
      statedButNotElicited({ scenario: seg, criterion: risks, submissionText: "Staff test accounts start with T.", obtainedFactIds: [] }),
    ).toEqual([]);
  });
});
