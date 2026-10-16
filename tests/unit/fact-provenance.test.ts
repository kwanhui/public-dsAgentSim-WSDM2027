// Ledger fact provenance. Every fact carries a tag saying
// where it came from, so the judge can treat stakeholder-written facts as
// claims rather than ground truth. Run against PGlite with the real
// migrations, so the column, the write path and the backfill SQL are all
// exercised.

import { readFileSync } from "node:fs";
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
const { sql } = await import("drizzle-orm");
const { appendWorldFacts, createEngagement, getLedger } = await import("@/lib/engagement/state");
const { inferProvenance, resolveProvenance } = await import("@/lib/engagement/provenance");
const { loadScenario } = await import("@/lib/scenarios/load");

const scenario = await loadScenario("customer-churn");

async function freshEngagement(n: number) {
  await db.insert(schema.users).values({ id: `u${n}`, email: `u${n}`, role: "instructor" });
  await db.insert(schema.cohorts).values({
    id: `c${n}`,
    slug: `c${n}`,
    name: "T",
    instructorId: `u${n}`,
    configJson: {},
  });
  const [student] = await db.insert(schema.students).values({ cohortId: `c${n}`, learnerHash: `h${n}` }).returning();
  return createEngagement(`c${n}`, student.id, scenario);
}

describe("inferProvenance", () => {
  it("tags persona, release, system and seed facts", () => {
    expect(inferProvenance("data-owner", "The extract is one row per subscriber.")).toBe("persona");
    expect(inferProvenance("system", "The released file churn_extract.csv has 8170 data rows.")).toBe(
      "release-profile",
    );
    expect(inferProvenance("system", 'The consultant delivered the data-audit for the "Data collection" stage.')).toBe(
      "system",
    );
    expect(inferProvenance("system", 'The engagement moved past the "cleaning" stage by instructor decision.')).toBe(
      "system",
    );
    expect(inferProvenance("system", "Meridian Mobile has roughly 480,000 postpaid subscribers.")).toBe("seed");
  });

  it("prefers a stored tag and infers only when it is missing or unknown", () => {
    expect(resolveProvenance({ source: "client", fact: "x", provenance: "seed" })).toBe("seed");
    expect(resolveProvenance({ source: "client", fact: "x", provenance: null })).toBe("persona");
    expect(resolveProvenance({ source: "system", fact: "x", provenance: "bogus" })).toBe("seed");
  });
});

describe("ledger provenance in the database", () => {
  it("stores seed, persona, system and release-profile tags on write", async () => {
    const e = await freshEngagement(1);
    await appendWorldFacts(e.id, "formulation", "client", ["Finance counts a save at six months."]);
    await appendWorldFacts(e.id, "formulation", "system", ["The consultant delivered the problem-statement."]);
    await appendWorldFacts(e.id, "data-collection", "system", ["The released file x.csv has 3 data rows."], "release-profile");
    const ledger = await getLedger(e.id);
    const tags = ledger.map((f) => f.provenance);
    expect(tags.slice(0, scenario.worldFactsSeed.length).every((t) => t === "seed")).toBe(true);
    expect(tags.slice(-3)).toEqual(["persona", "system", "release-profile"]);
  });

  it("infers a tag for rows that have none (restored snapshots, pre-0009 rows)", async () => {
    const e = await freshEngagement(2);
    await db.insert(schema.worldFacts).values([
      { engagementId: e.id, fact: "Marcus said the extract is clean.", source: "data-owner", stage: "data-collection" },
      { engagementId: e.id, fact: "The released file y.csv has 5 data rows.", source: "system", stage: "data-collection" },
    ]);
    const ledger = await getLedger(e.id);
    expect(ledger.slice(-2).map((f) => f.provenance)).toEqual(["persona", "release-profile"]);
  });

  it("backfills stored rows with the same rule in migration 0009", async () => {
    const e = await freshEngagement(3);
    await db.insert(schema.worldFacts).values([
      { engagementId: e.id, fact: "A claim.", source: "client", stage: "formulation" },
      { engagementId: e.id, fact: "The released file z.csv has 1 data rows.", source: "system", stage: "data-collection" },
      { engagementId: e.id, fact: 'The engagement moved past the "cleaning" stage by instructor decision.', source: "system", stage: "cleaning" },
      { engagementId: e.id, fact: "A seeded fact.", source: "system", stage: "formulation" },
    ]);
    const migration = readFileSync("lib/db/migrations/0009_fact_provenance_and_improve.sql", "utf8");
    const backfill = migration.split("--> statement-breakpoint").find((s) => s.includes("UPDATE"));
    expect(backfill).toBeTruthy();
    await db.execute(sql.raw(backfill!));
    const rows = await db.execute(
      sql`select fact, provenance from world_facts where engagement_id = ${e.id} order by id desc limit 4`,
    );
    const got = (rows as unknown as { rows: { provenance: string }[] }).rows.map((r) => r.provenance).reverse();
    expect(got).toEqual(["persona", "release-profile", "system", "seed"]);
  });

  it("tags the data owner's release sentence system, on write and in migration 0010", async () => {
    const e = await freshEngagement(4);
    const { recordDataReleases } = await import("@/lib/agents/data-environment");
    const accepted = await recordDataReleases(
      { ...e, currentStage: "data-collection" },
      scenario,
      "data-owner",
      ["churn_extract.csv"],
      { scopeMessageId: 42 },
    );
    expect(accepted).toEqual(["churn_extract.csv"]);
    // The release event names the learner message it answered.
    const released = (await db.select().from(schema.events)).filter((ev) => ev.engagementId === e.id && ev.type === "data_released");
    expect(released.map((ev) => ev.detailJson)).toEqual([
      { file: "churn_extract.csv", personaId: "data-owner", scopeMessageId: 42, scopeText: null },
    ]);
    const ledger = await getLedger(e.id);
    const release = ledger.find((f) => f.fact.startsWith("The data owner released the dataset file"))!;
    expect(release).toMatchObject({ provenance: "system", source: "data-owner" });

    // A row stored as persona before the fix, and an untagged one.
    await db.insert(schema.worldFacts).values([
      {
        engagementId: e.id,
        fact: "The data owner released the dataset file old.csv to the consultant.",
        source: "data-owner",
        stage: "data-collection",
        provenance: "persona",
      },
    ]);
    expect(inferProvenance("data-owner", "The data owner released the dataset file x.csv to the consultant.")).toBe("system");
    const migration = readFileSync("lib/db/migrations/0010_rubric_unverified_claim.sql", "utf8");
    const retag = migration.split("--> statement-breakpoint").find((part) => part.includes("UPDATE"));
    await db.execute(sql.raw(retag!));
    const after = await getLedger(e.id);
    expect(after.filter((f) => f.fact.startsWith("The data owner released")).map((f) => f.provenance)).toEqual([
      "system",
      "system",
    ]);
  });
});
