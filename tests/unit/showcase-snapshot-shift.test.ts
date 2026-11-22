// A snapshot exported from one database and restored into another: the
// production case. The committed showcase snapshot was taken on a local
// database, so its serial ids (messages, scores, world facts, events, the
// elicitation trace and the releases) start at 1, and a target database that
// already holds other cohorts uses those ids. The restore has to move the
// snapshot's ids past the target's maxima and carry the message references
// with them, without touching the rows that were already there.
//
// Runs against a throwaway in-memory PGlite database with the real migrations.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
  exportCohort,
  parseSnapshot,
  restoreCohort,
  shiftSerialIds,
  type Snapshot,
  type SnapshotDb,
} from "@/scripts/showcase-snapshot";

const SNAPSHOT_FILE = "demo/showcase-snapshot.json";
const BYSTANDER_COHORT = "cohort-bystander";
const BYSTANDER_ENGAGEMENT = "engagement-bystander";

let client: PGlite;
let db: SnapshotDb;
let snapshot: Snapshot;

/** Rows of another cohort that occupy the low serial ids in every table. */
async function seedBystander(): Promise<void> {
  await db.insert(schema.users).values({ id: "instructor-b", email: "b@example.test", role: "instructor" });
  await db.insert(schema.cohorts).values({
    id: BYSTANDER_COHORT,
    slug: "some-other-class",
    name: "Some other class",
    instructorId: "instructor-b",
    configJson: { scenarios: { allowed: ["customer-churn"] } },
  });
  await db.insert(schema.students).values({ id: "student-b", cohortId: BYSTANDER_COHORT, learnerHash: "hash-b" });
  await db.insert(schema.engagements).values({
    id: BYSTANDER_ENGAGEMENT,
    cohortId: BYSTANDER_COHORT,
    studentId: "student-b",
    scenarioId: "customer-churn",
    currentStage: "data-collection",
    status: "active",
    mode: "human",
  });
  await db.insert(schema.channels).values({ id: "channel-b", engagementId: BYSTANDER_ENGAGEMENT, personaId: "client-sponsor" });
  const messages = Array.from({ length: 40 }, (_, i) => ({
    channelId: "channel-b",
    engagementId: BYSTANDER_ENGAGEMENT,
    sender: i % 2 === 0 ? "learner" : "client-sponsor",
    content: `bystander message ${i + 1}`,
    promptTokens: 0,
    completionTokens: 0,
    timestampIso: "2026-09-30T10:00:00.000Z",
  }));
  await db.insert(schema.messages).values(messages);
  await db.insert(schema.submissions).values({
    id: "submission-b",
    engagementId: BYSTANDER_ENGAGEMENT,
    stage: "formulation",
    kind: "problem-statement",
    contentText: "bystander memo",
    status: "scored",
  });
  await db.insert(schema.rubricScores).values(
    Array.from({ length: 12 }, (_, i) => ({
      submissionId: "submission-b",
      engagementId: BYSTANDER_ENGAGEMENT,
      criterionId: `c${i}`,
      score: 1,
      maxScore: 5,
      rationale: "bystander",
      judgeModel: "m",
      promptVersion: "p",
    })),
  );
  await db.insert(schema.worldFacts).values(
    Array.from({ length: 25 }, (_, i) => ({
      engagementId: BYSTANDER_ENGAGEMENT,
      fact: `bystander fact ${i + 1}`,
      source: "system",
      stage: "formulation",
    })),
  );
  await db.insert(schema.factElicitations).values({
    engagementId: BYSTANDER_ENGAGEMENT,
    factId: "save-rule",
    personaId: "client-sponsor",
    stage: "formulation",
    source: "turn",
    turnIndex: 2,
    learnerMessagesSoFar: 1,
    verified: true,
    messageId: 2,
  });
  await db.insert(schema.dataReleases).values({
    engagementId: BYSTANDER_ENGAGEMENT,
    file: "churn_extract.csv",
    personaId: "data-owner",
    stage: "data-collection",
    scopeMessageId: 3,
  });
  await db.insert(schema.events).values(
    Array.from({ length: 30 }, (_, i) => ({
      engagementId: BYSTANDER_ENGAGEMENT,
      cohortId: BYSTANDER_COHORT,
      type: "persona_reply",
      detailJson: { n: i + 1 },
      timestampIso: "2026-09-30T10:00:00.000Z",
    })),
  );
}

async function bystanderDump(): Promise<string> {
  return JSON.stringify((await exportCohort(db, BYSTANDER_COHORT)).tables);
}

beforeAll(async () => {
  snapshot = parseSnapshot(readFileSync(SNAPSHOT_FILE, "utf8"));
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as SnapshotDb;
  await migrate(drizzle(client), { migrationsFolder: "lib/db/migrations" });
  await seedBystander();
});

afterAll(async () => {
  await client.close();
});

describe("restore into a database that already holds rows", () => {
  it("is the production case: the snapshot's serial ids clash with rows already there", () => {
    const low = snapshot.tables.messages.map((m) => m.id as number);
    expect(Math.min(...low)).toBeLessThanOrEqual(40);
    expect(snapshot.tables.factElicitations.length).toBeGreaterThan(0);
    expect(snapshot.tables.dataReleases.some((r) => typeof r.scopeMessageId === "number")).toBe(true);
  });

  it("moves the clashing ids past the target's maxima and keeps the bystander rows", async () => {
    const before = await bystanderDump();
    const result = await restoreCohort(db, snapshot);

    expect(result.inserted.messages).toBe(snapshot.tables.messages.length);
    expect(result.inserted.events).toBe(snapshot.tables.events.length);
    // Every table whose ids clash moves by (target max - snapshot min + 1).
    const minId = (t: keyof Snapshot["tables"]) => Math.min(...snapshot.tables[t].map((r) => r.id as number));
    expect(result.shifted.messages).toBe(40 - minId("messages") + 1);
    expect(result.shifted.rubricScores).toBe(12 - minId("rubricScores") + 1);
    expect(result.shifted.worldFacts).toBe(25 - minId("worldFacts") + 1);
    expect(result.shifted.events).toBe(30 - minId("events") + 1);
    expect(result.shifted.factElicitations).toBe(1 - minId("factElicitations") + 1);
    expect(result.shifted.dataReleases).toBe(1 - minId("dataReleases") + 1);

    expect(await bystanderDump()).toBe(before);
  });

  it("keeps every message reference pointing at the same message", async () => {
    const engagementIds = snapshot.tables.engagements.map((e) => e.id as string);
    const originalContent = new Map(snapshot.tables.messages.map((m) => [m.id as number, m.content as string]));
    const restored = await db.select().from(schema.messages).where(inArray(schema.messages.engagementId, engagementIds));
    const restoredContent = new Map(restored.map((m) => [m.id, m.content]));
    expect(restored).toHaveLength(snapshot.tables.messages.length);

    const elicitations = await db
      .select()
      .from(schema.factElicitations)
      .where(inArray(schema.factElicitations.engagementId, engagementIds));
    for (const e of elicitations) {
      const original = snapshot.tables.factElicitations.find(
        (o) => o.engagementId === e.engagementId && o.factId === e.factId,
      );
      if (original?.messageId == null) continue;
      expect(restoredContent.get(e.messageId as number)).toBe(originalContent.get(original.messageId as number));
    }

    const releases = await db
      .select()
      .from(schema.dataReleases)
      .where(inArray(schema.dataReleases.engagementId, engagementIds));
    let checked = 0;
    for (const r of releases) {
      const original = snapshot.tables.dataReleases.find((o) => o.engagementId === r.engagementId && o.file === r.file);
      if (original?.scopeMessageId == null) continue;
      expect(restoredContent.get(r.scopeMessageId as number)).toBe(originalContent.get(original.scopeMessageId as number));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);

    const events = await db.select().from(schema.events).where(inArray(schema.events.engagementId, engagementIds));
    const withScope = events.filter((e) => typeof (e.detailJson as Record<string, unknown> | null)?.scopeMessageId === "number");
    expect(withScope.length).toBe(
      snapshot.tables.events.filter((e) => typeof (e.detailJson as Record<string, unknown> | null)?.scopeMessageId === "number").length,
    );
    for (const e of withScope) {
      expect(restoredContent.has((e.detailJson as { scopeMessageId: number }).scopeMessageId)).toBe(true);
    }
  });

  it("leaves the sequences past the restored rows", async () => {
    const [row] = await db
      .insert(schema.messages)
      .values({
        channelId: "channel-b",
        engagementId: BYSTANDER_ENGAGEMENT,
        sender: "learner",
        content: "after the restore",
        promptTokens: 0,
        completionTokens: 0,
        timestampIso: "2026-09-30T11:00:00.000Z",
      })
      .returning({ id: schema.messages.id });
    const maxRestored = Math.max(...snapshot.tables.messages.map((m) => m.id as number)) + 40;
    expect(row.id).toBeGreaterThan(maxRestored - 1);
    await db.delete(schema.messages).where(eq(schema.messages.id, row.id));
  });

  it("round-trips: the restored cohort exports as the snapshot with its ids moved", async () => {
    // A second restore of the same file replaces the cohort again; the
    // bystander rows still clash, so the ids move again, by the same amount.
    const result = await restoreCohort(db, snapshot);
    const exported = await exportCohort(db, snapshot.cohort.id);
    const expected = shiftSerialIds(snapshot, result.shifted);
    for (const t of ["messages", "worldFacts", "rubricScores", "factElicitations", "dataReleases"] as const) {
      expect(exported.tables[t].map((r) => r.id)).toEqual(expected.tables[t].map((r) => r.id));
    }
    expect(exported.tables.factElicitations.map((r) => r.messageId)).toEqual(
      expected.tables.factElicitations.map((r) => r.messageId),
    );
    expect(exported.tables.dataReleases.map((r) => r.scopeMessageId)).toEqual(
      expected.tables.dataReleases.map((r) => r.scopeMessageId),
    );
    expect(exported.tables.engagements.map((e) => e.id)).toEqual(snapshot.tables.engagements.map((e) => e.id));
  });

  it("does not move ids when nothing clashes", () => {
    const same = shiftSerialIds(snapshot, {});
    expect(same.tables.messages.map((m) => m.id)).toEqual(snapshot.tables.messages.map((m) => m.id));
  });
});
