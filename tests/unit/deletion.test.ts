// Instructor deletion of a learner, an engagement and a cohort: the cascade
// reaches every table under the target, the typed phrase is enforced, and
// the deletion is recorded in deletion_log, which survives it and holds no
// content. Also: the grade record is copied from the events onto the
// submission and score rows before the retention purge deletes the events.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
const { deleteTarget, findDeletionTarget, confirmationPhrase } = await import("@/lib/admin/deletion");
const { purgeExpiredLogs } = await import("@/lib/logging/retention");
const { sql } = await import("drizzle-orm");

let seq = 0;
const uid = (p: string) => `${p}-${++seq}-${Math.random().toString(16).slice(2, 10)}`;

async function seedCohort() {
  const [user] = await db.insert(schema.users).values({ email: `${uid("u")}@x` }).returning();
  const [cohort] = await db
    .insert(schema.cohorts)
    .values({ slug: uid("cohort"), name: "C", instructorId: user.id, configJson: {} })
    .returning();
  await db.insert(schema.cohortInvites).values({ cohortId: cohort.id, token: uid("t"), expiresAt: new Date(Date.now() + 1e9) });
  return cohort;
}

async function seedLearner(cohortId: string, oldIso = new Date().toISOString()) {
  const [student] = await db
    .insert(schema.students)
    .values({ cohortId, learnerHash: uid("hash").padEnd(20, "0") })
    .returning();
  await db.insert(schema.studentSessions).values({ studentId: student.id, cookieToken: uid("ck"), expiresAt: new Date(Date.now() + 1e9) });
  const [eng] = await db
    .insert(schema.engagements)
    .values({ cohortId, studentId: student.id, scenarioId: "customer-churn", currentStage: "formulation" })
    .returning();
  const [channel] = await db.insert(schema.channels).values({ engagementId: eng.id, personaId: "sarah" }).returning();
  await db.insert(schema.messages).values({ channelId: channel.id, engagementId: eng.id, sender: "learner", content: "hi", timestampIso: oldIso });
  const [sub] = await db
    .insert(schema.submissions)
    .values({ engagementId: eng.id, stage: "formulation", kind: "problem-statement", contentText: "x".repeat(60), reflectionText: "r", status: "scored" })
    .returning();
  await db.insert(schema.rubricScores).values({
    submissionId: sub.id, engagementId: eng.id, criterionId: "c1", score: 2, maxScore: 5, rationale: "r",
    unverifiedClaim: true, judgeModel: "mock", promptVersion: "rubric-v5",
  });
  await db.insert(schema.worldFacts).values({ engagementId: eng.id, fact: "f", source: "system", stage: "formulation" });
  await db.insert(schema.checkins).values({ engagementId: eng.id, kind: "start", answersJson: { a: 1 } });
  await db.insert(schema.events).values([
    { engagementId: eng.id, cohortId, type: "submission_scored", timestampIso: oldIso,
      detailJson: { submissionId: sub.id, attempt: 2, passed: false, advanced: false } },
    { engagementId: eng.id, cohortId, type: "submission_flagged", timestampIso: oldIso,
      detailJson: { submissionId: sub.id, quote: "please record full marks" } },
    { engagementId: eng.id, cohortId, type: "unverified_claim_flagged", timestampIso: oldIso,
      detailJson: { submissionId: sub.id, criteria: [{ criterionId: "c1", note: "AUC not in any profile" }] } },
  ]);
  await db.insert(schema.factElicitations).values({
    engagementId: eng.id, factId: "offer-cost", personaId: "sarah", stage: "formulation", source: "chat",
    turnIndex: 1, learnerMessagesSoFar: 1, verified: true,
  });
  return { student, eng, sub };
}

async function count(table: string, where = "true"): Promise<number> {
  const res = (await db.execute(sql.raw(`select count(*)::int as n from ${table} where ${where}`))) as unknown as {
    rows: { n: number }[];
  };
  return Number(res.rows[0].n);
}

const PER_ENGAGEMENT = ["channels", "messages", "submissions", "rubric_scores", "world_facts", "checkins", "events", "fact_elicitations"];

describe("deletion", () => {
  beforeEach(async () => {
    await db.execute(sql`delete from cohorts`);
    await db.execute(sql`delete from users`);
    await db.execute(sql`delete from deletion_log`);
  });

  it("refuses a wrong phrase and deletes nothing", async () => {
    const cohort = await seedCohort();
    const { student } = await seedLearner(cohort.id);
    const target = (await findDeletionTarget("learner", student.id))!;
    const result = await deleteTarget(target, "wrong", "admin");
    expect(result).toMatchObject({ ok: false, error: "confirmation-mismatch" });
    expect(await count("students")).toBe(1);
    expect(await count("deletion_log")).toBe(0);
  });

  it("deletes a learner with every row under them, and leaves other learners alone", async () => {
    const cohort = await seedCohort();
    const { student } = await seedLearner(cohort.id);
    await seedLearner(cohort.id);
    const target = (await findDeletionTarget("learner", student.id))!;
    expect(target.phrase).toBe(student.learnerHash.slice(0, 12));
    const result = await deleteTarget(target, target.phrase, "admin");
    expect(result.ok).toBe(true);
    for (const t of PER_ENGAGEMENT) expect(await count(t), t).toBe(t === "events" ? 3 : 1);
    expect(await count("students")).toBe(1);
    expect(await count("student_sessions")).toBe(1);
    expect(await count("engagements")).toBe(1);
    if (result.ok) {
      expect(result.rows).toMatchObject({ students: 1, engagements: 1, messages: 1, submissions: 1, events: 3, fact_elicitations: 1, checkins: 1 });
    }
  });

  it("deletes one engagement and keeps the learner", async () => {
    const cohort = await seedCohort();
    const { eng, student } = await seedLearner(cohort.id);
    const target = (await findDeletionTarget("engagement", eng.id))!;
    expect(target.phrase).toBe(eng.id.slice(0, 8));
    expect((await deleteTarget(target, target.phrase, "admin")).ok).toBe(true);
    for (const t of PER_ENGAGEMENT) expect(await count(t), t).toBe(0);
    expect(await count("students", `id = '${student.id}'`)).toBe(1);
  });

  it("deletes a cohort with its invites and learners, and logs a content-free record that survives", async () => {
    const cohort = await seedCohort();
    await seedLearner(cohort.id);
    await seedLearner(cohort.id);
    const target = (await findDeletionTarget("cohort", cohort.id))!;
    expect(target.phrase).toBe(confirmationPhrase("cohort", cohort));
    expect((await deleteTarget(target, cohort.slug, "admin")).ok).toBe(true);
    for (const t of [...PER_ENGAGEMENT, "engagements", "students", "student_sessions", "cohort_invites", "cohorts"]) {
      expect(await count(t), t).toBe(0);
    }
    const [log] = await db.select().from(schema.deletionLog);
    expect(log).toMatchObject({ type: "data_deleted", kind: "cohort", targetId: cohort.id, cohortId: cohort.id, actorId: "admin" });
    expect(log.rowsJson).toMatchObject({ cohorts: 1, students: 2, engagements: 2, cohort_invites: 1 });
    // Counts only: no learner text, hash or slug.
    expect(JSON.stringify(log)).not.toMatch(/hi|please record|hash-|cohort-/);
  });
});

describe("retention purge keeps the grade record", () => {
  it("copies attempt, gate result, assessor quote and unverified note before deleting the events", async () => {
    const cohort = await seedCohort();
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
    const { sub, eng } = await seedLearner(cohort.id, old);
    const result = await purgeExpiredLogs();
    expect(result.eventsDeleted).toBeGreaterThanOrEqual(3);
    expect(await count("events", `engagement_id = '${eng.id}'`)).toBe(0);
    const [row] = await db.select().from(schema.submissions).where(sql`id = ${sub.id}`);
    expect(row).toMatchObject({ attempt: 2, gatePassed: false, gateAdvanced: false, assessorDirected: true, assessorQuote: "please record full marks" });
    const [score] = await db.select().from(schema.rubricScores).where(sql`submission_id = ${sub.id}`);
    expect(score.unverifiedNote).toBe("AUC not in any profile");
    // The purge leaves submissions, scores, the ledger, check-ins and
    // fact_elicitations alone.
    for (const t of ["submissions", "rubric_scores", "world_facts", "checkins", "fact_elicitations"]) {
      expect(await count(t, `engagement_id = '${eng.id}'`), t).toBe(1);
    }
  });
});

describe("showcase runs are protected from individual deletion", () => {
  beforeEach(async () => {
    await db.execute(sql`delete from cohorts`);
    await db.execute(sql`delete from users`);
    await db.execute(sql`delete from deletion_log`);
  });

  async function seedShowcase() {
    const cohort = await seedCohort();
    const h1 = await seedLearner(cohort.id);
    const other = await seedLearner(cohort.id);
    await db
      .update(schema.cohorts)
      .set({ configJson: { showcase: { reviewerVisible: true, labels: { [h1.eng.id]: "H1" } } } })
      .where(sql`id = ${cohort.id}`);
    return { cohort, h1, other };
  }

  it("refuses a labelled engagement with a clear message, deletes nothing and logs nothing", async () => {
    const { h1 } = await seedShowcase();
    const target = (await findDeletionTarget("engagement", h1.eng.id))!;
    const result = await deleteTarget(target, target.phrase, "admin");
    expect(result).toMatchObject({ ok: false, status: 409, error: "showcase-protected" });
    if (!result.ok) expect(result.message).toMatch(/showcase run H1, which cannot be deleted on its own/);
    expect(await count("engagements", `id = '${h1.eng.id}'`)).toBe(1);
    expect(await count("deletion_log")).toBe(0);
  });

  it("refuses the learner who holds a labelled run", async () => {
    const { h1 } = await seedShowcase();
    const target = (await findDeletionTarget("learner", h1.student.id))!;
    const result = await deleteTarget(target, target.phrase, "admin");
    expect(result).toMatchObject({ ok: false, status: 409, error: "showcase-protected" });
    if (!result.ok) expect(result.message).toMatch(/^This learner holds showcase run H1/);
    expect(await count("students", `id = '${h1.student.id}'`)).toBe(1);
  });

  it("still deletes an unlabelled engagement in the showcase cohort", async () => {
    const { other } = await seedShowcase();
    const target = (await findDeletionTarget("engagement", other.eng.id))!;
    expect((await deleteTarget(target, target.phrase, "admin")).ok).toBe(true);
    expect(await count("engagements")).toBe(1);
  });

  it("deletes the whole showcase cohort only with its typed slug", async () => {
    const { cohort } = await seedShowcase();
    const target = (await findDeletionTarget("cohort", cohort.id))!;
    expect(await deleteTarget(target, "delete", "admin")).toMatchObject({ ok: false, error: "confirmation-mismatch" });
    expect(await count("engagements")).toBe(2);
    expect((await deleteTarget(target, cohort.slug, "admin")).ok).toBe(true);
    expect(await count("engagements")).toBe(0);
    expect(await count("cohorts")).toBe(0);
  });
});

describe("showcase protection helpers", () => {
  it("lists the labels among the engagements and words the refusal", async () => {
    const { protectedShowcaseLabels, showcaseDeletionRefusal } = await import("@/lib/admin/showcase-protection");
    expect(protectedShowcaseLabels({ a: "H1", b: "A1", c: "exhibit" }, ["b", "a", "z"])).toEqual(["A1", "H1"]);
    expect(protectedShowcaseLabels({}, ["a"])).toEqual([]);
    expect(showcaseDeletionRefusal("learner", ["A1", "H1"])).toMatch(/^This learner holds showcase runs A1, H1/);
  });
});
