// Each successful retention purge is recorded, so /api/health can report
// when the purge last ran (a purge that never runs is otherwise silent).

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

const { purgeExpiredLogs, lastPurgeAt } = await import("@/lib/logging/retention");

describe("retention purge record", () => {
  it("is empty before any purge and set after one", async () => {
    expect(await lastPurgeAt()).toBeNull();
    const before = Date.now();
    const result = await purgeExpiredLogs();
    expect(result).toMatchObject({ messagesDeleted: 0, eventsDeleted: 0 });
    const at = await lastPurgeAt();
    expect(at).not.toBeNull();
    expect(at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

const { db } = await import("@/lib/db/client");
const schema = await import("@/lib/db/schema");
const { sql } = await import("drizzle-orm");
const { createHash } = await import("node:crypto");
const { RETENTION_ACTOR, isPurgeExempt } = await import("@/lib/logging/retention");

let seq = 0;
const uid = (p: string) => `${p}-${++seq}-${Math.random().toString(16).slice(2, 10)}`;
const DAY = 24 * 60 * 60 * 1000;

async function seedRun(opts: { config?: unknown; kind?: string; ageDays: number }) {
  const [user] = await db.insert(schema.users).values({ email: `${uid("u")}@x` }).returning();
  const [cohort] = await db
    .insert(schema.cohorts)
    .values({ slug: uid("c"), name: "C", instructorId: user.id, configJson: opts.config ?? {} })
    .returning();
  const old = new Date(Date.now() - opts.ageDays * DAY);
  const [student] = await db
    .insert(schema.students)
    .values({
      cohortId: cohort.id,
      learnerHash: uid("h").padEnd(20, "0"),
      profileJson: opts.kind ? { kind: opts.kind } : null,
      createdAt: old,
    })
    .returning();
  const [eng] = await db
    .insert(schema.engagements)
    .values({ cohortId: cohort.id, studentId: student.id, scenarioId: "customer-churn", currentStage: "data-collection" })
    .returning();
  const [channel] = await db.insert(schema.channels).values({ engagementId: eng.id, personaId: "data-owner" }).returning();
  await db.insert(schema.messages).values({
    channelId: channel.id, engagementId: eng.id, sender: "learner", content: "my scope", timestampIso: old.toISOString(),
  });
  await db.insert(schema.events).values({ engagementId: eng.id, cohortId: cohort.id, type: "persona_turn", timestampIso: old.toISOString() });
  await db.insert(schema.dataReleases).values({
    engagementId: eng.id, file: "churn_extract.csv", personaId: "data-owner", stage: "data-collection",
    scopeText: "Hi Marcus, I need subscriber_id and tenure to rank churn risk.", createdAt: old,
  });
  return { cohort, student, eng };
}

async function count(q: string): Promise<number> {
  const res = (await db.execute(sql.raw(q))) as unknown as { rows: { n: number }[] };
  return Number(res.rows[0].n);
}

describe("retention purge scope", () => {
  it("blanks a release's scope text past the window and keeps the row, its length and its hash", async () => {
    const text = "Hi Marcus, I need subscriber_id and tenure to rank churn risk.";
    const { eng } = await seedRun({ ageDays: 200 });
    const fresh = await seedRun({ ageDays: 1 });
    const result = await purgeExpiredLogs();
    expect(result.scopeTextsCleared).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(schema.dataReleases).where(sql`${schema.dataReleases.engagementId} = ${eng.id}`);
    expect(row.scopeText).toBeNull();
    expect(row.scopeTextChars).toBe(text.length);
    expect(row.scopeTextSha256).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    expect(row.scopeTextPurgedAt).not.toBeNull();
    const [kept] = await db.select().from(schema.dataReleases).where(sql`${schema.dataReleases.engagementId} = ${fresh.eng.id}`);
    expect(kept.scopeText).toBe(text);
    // No learner-written text outside submissions survives for the old run.
    expect(await count(`select count(*)::int as n from messages where engagement_id = '${eng.id}'`)).toBe(0);
  });

  it("leaves a reviewer-visible showcase cohort alone", async () => {
    const config = { showcase: { reviewerVisible: true, labels: {} } };
    expect(isPurgeExempt(config)).toBe(true);
    expect(isPurgeExempt({ showcase: { reviewerVisible: false } })).toBe(false);
    const { eng } = await seedRun({ config, ageDays: 400 });
    await purgeExpiredLogs();
    expect(await count(`select count(*)::int as n from messages where engagement_id = '${eng.id}'`)).toBe(1);
    expect(await count(`select count(*)::int as n from events where engagement_id = '${eng.id}'`)).toBe(1);
    expect(await count(`select count(*)::int as n from data_releases where engagement_id = '${eng.id}' and scope_text is not null`)).toBe(1);
  });

  it("deletes a sandbox seat older than 30 days with its engagement, and records it", async () => {
    const old = await seedRun({ kind: "sandbox", ageDays: 31 });
    const young = await seedRun({ kind: "sandbox", ageDays: 5 });
    const invited = await seedRun({ ageDays: 31 });
    const result = await purgeExpiredLogs();
    expect(result.sandboxSeatsDeleted).toBe(1);
    expect(await count(`select count(*)::int as n from students where id = '${old.student.id}'`)).toBe(0);
    expect(await count(`select count(*)::int as n from engagements where id = '${old.eng.id}'`)).toBe(0);
    expect(await count(`select count(*)::int as n from data_releases where engagement_id = '${old.eng.id}'`)).toBe(0);
    expect(await count(`select count(*)::int as n from students where id = '${young.student.id}'`)).toBe(1);
    expect(await count(`select count(*)::int as n from students where id = '${invited.student.id}'`)).toBe(1);
    expect(
      await count(`select count(*)::int as n from deletion_log where target_id = '${old.student.id}' and actor_id = '${RETENTION_ACTOR}'`),
    ).toBe(1);
  });
});
