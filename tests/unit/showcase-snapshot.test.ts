// The showcase cohort is the paper's central exhibit, and a reviewer poking at
// it is the expected case, not an accident. This exercises the round trip that
// puts it back: seed a small cohort, export it, damage it the way a reviewer
// would (start another engagement, plant a world fact), restore, and check the
// database is byte-for-byte the cohort the snapshot holds.
//
// It runs against a throwaway in-memory PGlite database, the same driver
// `pnpm demo` uses, so the real migrations, the real constraints, and the real
// serial sequences are all in play. Nothing here touches a deployment.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
  SNAPSHOT_TABLES,
  exportCohort,
  findCohort,
  isResearchFlaggedEvent,
  parseSnapshot,
  restoreCohort,
  stripResearchFlagged,
  type Snapshot,
  type SnapshotDb,
} from "@/scripts/showcase-snapshot";

const COHORT_ID = "cohort-showcase";
const OTHER_COHORT_ID = "cohort-bystander";
const STUDENT_ID = "student-1";
const ENGAGEMENT_ID = "engagement-1";
const SUBMISSION_ID = "submission-1";

let client: PGlite;
let db: SnapshotDb;

/**
 * A cohort small enough to read in the assertions but wide enough to cover
 * every table the script claims to carry: an engagement with two channels and
 * their messages, a scored submission, the world-fact ledger, both check-ins,
 * and the event log.
 */
async function seed(): Promise<void> {
  await db.insert(schema.users).values({
    id: "instructor-1",
    email: "instructor@example.test",
    name: "Instructor",
    createdAt: new Date("2026-08-01T00:00:00Z"),
  });

  for (const [id, slug, name] of [
    [COHORT_ID, "showcase-meridian-mobile-churn", "Showcase — Meridian Mobile churn"],
    [OTHER_COHORT_ID, "some-other-class", "Some other class"],
  ] as const) {
    await db.insert(schema.cohorts).values({
      id,
      slug,
      name,
      instructorId: "instructor-1",
      configJson: {
        research: { checkins: true, reflections: true },
        scenarios: { allowed: ["customer-churn"] },
        // A restore marks the showcase reviewer-visible; seeded that way so a
        // round trip compares equal.
        showcase: { reviewerVisible: true },
      },
      createdAt: new Date("2026-08-02T01:00:00Z"),
    });
  }

  await db.insert(schema.cohortInvites).values({
    id: "invite-1",
    cohortId: COHORT_ID,
    token: "invite-token-1",
    expiresAt: new Date("2026-09-01T00:00:00Z"),
    usedAt: new Date("2026-08-03T02:00:00Z"),
    createdAt: new Date("2026-08-02T02:00:00Z"),
  });

  await db.insert(schema.students).values({
    id: STUDENT_ID,
    cohortId: COHORT_ID,
    learnerHash: "learner-hash-1",
    profileJson: { display: "H1" },
    createdAt: new Date("2026-08-03T02:00:00Z"),
    lastActiveAt: new Date("2026-08-03T03:00:00Z"),
  });

  await db.insert(schema.studentSessions).values({
    id: "session-1",
    studentId: STUDENT_ID,
    cookieToken: "cookie-token-1",
    expiresAt: new Date("2026-09-03T02:00:00Z"),
    createdAt: new Date("2026-08-03T02:00:00Z"),
  });

  await db.insert(schema.engagements).values({
    id: ENGAGEMENT_ID,
    cohortId: COHORT_ID,
    studentId: STUDENT_ID,
    scenarioId: "customer-churn",
    currentStage: "deployment",
    status: "completed",
    mode: "human",
    createdAt: new Date("2026-08-03T02:05:00Z"),
    completedAt: new Date("2026-08-03T02:40:00Z"),
  });

  await db.insert(schema.channels).values([
    {
      id: "channel-client",
      engagementId: ENGAGEMENT_ID,
      personaId: "client-sponsor",
      unlockedAt: new Date("2026-08-03T02:05:00Z"),
      createdAt: new Date("2026-08-03T02:05:00Z"),
    },
    {
      id: "channel-data",
      engagementId: ENGAGEMENT_ID,
      personaId: "data-owner",
      unlockedAt: new Date("2026-08-03T02:12:00Z"),
      createdAt: new Date("2026-08-03T02:05:00Z"),
    },
  ]);

  await db.insert(schema.messages).values([
    {
      channelId: "channel-client",
      engagementId: ENGAGEMENT_ID,
      sender: "learner",
      content: "What does churn actually mean for you?",
      promptTokens: 0,
      completionTokens: 0,
      timestampIso: "2026-08-03T02:06:00.000Z",
    },
    {
      channelId: "channel-client",
      engagementId: ENGAGEMENT_ID,
      sender: "client-sponsor",
      content: "A save only counts if they stay six more months.",
      promptTokens: 1200,
      completionTokens: 180,
      timestampIso: "2026-08-03T02:06:20.000Z",
    },
    {
      channelId: "channel-data",
      engagementId: ENGAGEMENT_ID,
      sender: "learner",
      content: "Can I have postpaid attributes, usage, billing, and churn labels?",
      promptTokens: 0,
      completionTokens: 0,
      timestampIso: "2026-08-03T02:13:00.000Z",
    },
  ]);

  await db.insert(schema.submissions).values({
    id: SUBMISSION_ID,
    engagementId: ENGAGEMENT_ID,
    stage: "formulation",
    kind: "problem-statement",
    contentText: "Predict postpaid churn 30 days ahead so retention can target offers.",
    reflectionText: "I nearly forgot to ask what a save is worth.",
    status: "scored",
    createdAt: new Date("2026-08-03T02:10:00Z"),
  });

  await db.insert(schema.rubricScores).values([
    {
      submissionId: SUBMISSION_ID,
      engagementId: ENGAGEMENT_ID,
      criterionId: "decision-framing",
      score: 5,
      maxScore: 5,
      rationale: "Names the decision and the horizon.",
      judgeModel: "claude-opus-4-8",
      promptVersion: "rubric-v2",
      createdAt: new Date("2026-08-03T02:10:30Z"),
    },
    {
      submissionId: SUBMISSION_ID,
      engagementId: ENGAGEMENT_ID,
      criterionId: "scope-discipline",
      score: 4,
      maxScore: 5,
      rationale: "Scope stated, cost of an offer not carried through.",
      judgeModel: "claude-opus-4-8",
      promptVersion: "rubric-v2",
      overrideScore: 5,
      overrideNote: "Cost appears in the client channel.",
      overriddenAt: new Date("2026-08-04T09:00:00Z"),
      createdAt: new Date("2026-08-03T02:10:30Z"),
    },
  ]);

  await db.insert(schema.worldFacts).values([
    {
      engagementId: ENGAGEMENT_ID,
      fact: "A save counts only if the subscriber stays six more months.",
      source: "client-sponsor",
      stage: "formulation",
      createdAt: new Date("2026-08-03T02:06:20Z"),
    },
    {
      engagementId: ENGAGEMENT_ID,
      fact: "churn_extract.csv released: 6000 rows, 18 columns.",
      source: "system",
      stage: "data-collection",
      createdAt: new Date("2026-08-03T02:14:00Z"),
    },
  ]);

  await db.insert(schema.checkins).values([
    {
      engagementId: ENGAGEMENT_ID,
      kind: "start",
      answersJson: { formulation: 3, modelling: 5 },
      goal: "Ask better scoping questions.",
      createdAt: new Date("2026-08-03T02:05:10Z"),
    },
    {
      engagementId: ENGAGEMENT_ID,
      kind: "complete",
      answersJson: { formulation: 6, modelling: 6 },
      createdAt: new Date("2026-08-03T02:41:00Z"),
    },
  ]);

  await db.insert(schema.events).values([
    {
      engagementId: ENGAGEMENT_ID,
      cohortId: COHORT_ID,
      type: "stage_advanced",
      detailJson: { from: "formulation", to: "data-collection" },
      timestampIso: "2026-08-03T02:11:00.000Z",
    },
    {
      engagementId: ENGAGEMENT_ID,
      cohortId: null,
      type: "data_released",
      detailJson: { file: "churn_extract.csv" },
      timestampIso: "2026-08-03T02:14:00.000Z",
    },
  ]);
}

/** Everything the snapshot carries, in a form two runs can be compared by. */
async function dumpTables(cohortId: string): Promise<string> {
  const snapshot = await exportCohort(db, cohortId);
  return JSON.stringify(snapshot.tables);
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as SnapshotDb;
  await migrate(drizzle(client), { migrationsFolder: "lib/db/migrations" });
  await seed();
});

afterAll(async () => {
  await client.close();
});

describe("exportCohort", () => {
  it("finds the cohort by slug or by id", async () => {
    const bySlug = await findCohort(db, "showcase-meridian-mobile-churn");
    const byId = await findCohort(db, COHORT_ID);
    expect(bySlug?.id).toBe(COHORT_ID);
    expect(byId?.slug).toBe("showcase-meridian-mobile-churn");
    expect(await findCohort(db, "no-such-cohort")).toBeNull();
  });

  it("carries every table the cohort owns, with primary keys intact", async () => {
    const snapshot = await exportCohort(db, COHORT_ID);
    expect(snapshot.counts).toEqual({
      cohorts: 1,
      cohortInvites: 1,
      students: 1,
      studentSessions: 1,
      engagements: 1,
      channels: 2,
      messages: 3,
      submissions: 1,
      rubricScores: 2,
      worldFacts: 2,
      factElicitations: 0,
      dataReleases: 0,
      // The database holds two check-ins, but they are research-flagged and
      // never travel in a snapshot.
      checkins: 0,
      events: 2,
    });
    expect(snapshot.tables.engagements[0].id).toBe(ENGAGEMENT_ID);
    expect(snapshot.tables.submissions[0].id).toBe(SUBMISSION_ID);
    // The seeded reflection and the two research switches are stripped.
    expect(snapshot.tables.submissions[0].reflectionText).toBeNull();
    expect(snapshot.tables.cohorts[0].configJson).toMatchObject({
      research: { checkins: false, reflections: false },
    });
    // Serial ids travel too, so a restored engagement keeps the message
    // ordering the transcripts were read in.
    expect(snapshot.tables.messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("leaves other cohorts alone", async () => {
    const snapshot = await exportCohort(db, COHORT_ID);
    const ids = snapshot.tables.cohorts.map((c) => c.id);
    expect(ids).toEqual([COHORT_ID]);
    const other = await exportCohort(db, OTHER_COHORT_ID);
    expect(other.counts.engagements).toBe(0);
    expect(other.counts.events).toBe(0);
  });

  it("refuses a cohort that is not there", async () => {
    await expect(exportCohort(db, "cohort-that-never-was")).rejects.toThrow(/No cohort/);
  });
});

describe("parseSnapshot", () => {
  it("rejects a file that is not one of ours", () => {
    expect(() => parseSnapshot(JSON.stringify({ format: "something-else" }))).toThrow(/format/);
  });

  it("rejects a snapshot missing a table", async () => {
    const snapshot = await exportCohort(db, COHORT_ID);
    const damaged = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    delete (damaged.tables as Partial<Snapshot["tables"]>).worldFacts;
    expect(() => parseSnapshot(JSON.stringify(damaged))).toThrow(/worldFacts/);
  });
});

describe("restoreCohort", () => {
  it("puts the cohort back exactly as the snapshot holds it", async () => {
    const before = await dumpTables(COHORT_ID);
    const otherBefore = await dumpTables(OTHER_COHORT_ID);
    // The file on disk is what a restore reads, so go through JSON rather than
    // handing the in-memory rows straight back.
    const snapshot = parseSnapshot(JSON.stringify(await exportCohort(db, COHORT_ID)));

    // What a reviewer does to the exhibit: start another engagement, and talk
    // a persona into a commitment that was never part of the curated run.
    await db.insert(schema.engagements).values({
      id: "engagement-reviewer",
      cohortId: COHORT_ID,
      studentId: STUDENT_ID,
      scenarioId: "customer-churn",
      currentStage: "formulation",
      status: "active",
      mode: "agent",
    });
    await db.insert(schema.worldFacts).values({
      engagementId: ENGAGEMENT_ID,
      fact: "The client waived the six-month save rule.",
      source: "client-sponsor",
      stage: "formulation",
    });
    await db
      .update(schema.cohorts)
      .set({ name: "Renamed by a reviewer" })
      .where(eq(schema.cohorts.id, COHORT_ID));
    expect(await dumpTables(COHORT_ID)).not.toBe(before);

    const result = await restoreCohort(db, snapshot);
    expect(result.inserted.engagements).toBe(1);
    expect(result.inserted.messages).toBe(3);
    expect(result.deleted.engagements).toBe(2);

    expect(await dumpTables(COHORT_ID)).toBe(before);
    expect(await dumpTables(OTHER_COHORT_ID)).toBe(otherBefore);

    const stray = await db
      .select()
      .from(schema.engagements)
      .where(eq(schema.engagements.id, "engagement-reviewer"));
    expect(stray).toHaveLength(0);

    const planted = await db
      .select()
      .from(schema.worldFacts)
      .where(
        and(
          eq(schema.worldFacts.engagementId, ENGAGEMENT_ID),
          eq(schema.worldFacts.fact, "The client waived the six-month save rule."),
        ),
      );
    expect(planted).toHaveLength(0);

    const [cohort] = await db
      .select()
      .from(schema.cohorts)
      .where(eq(schema.cohorts.id, COHORT_ID));
    expect(cohort.name).toBe("Showcase — Meridian Mobile churn");
  });

  it("resets the serial sequences so the next write does not collide", async () => {
    const [row] = await db
      .insert(schema.worldFacts)
      .values({
        engagementId: ENGAGEMENT_ID,
        fact: "A fact written after the restore.",
        source: "system",
        stage: "formulation",
      })
      .returning({ id: schema.worldFacts.id });
    expect(row.id).toBeGreaterThan(2);
    await db.delete(schema.worldFacts).where(eq(schema.worldFacts.id, row.id));
  });

  it("restores into a database the cohort has been deleted from", async () => {
    const before = await dumpTables(COHORT_ID);
    const snapshot = parseSnapshot(JSON.stringify(await exportCohort(db, COHORT_ID)));

    await db.delete(schema.cohorts).where(eq(schema.cohorts.id, COHORT_ID));
    expect(await findCohort(db, COHORT_ID)).toBeNull();

    await restoreCohort(db, snapshot);
    expect(await dumpTables(COHORT_ID)).toBe(before);
  });

  it("leaves the database untouched when the restore fails part way", async () => {
    const before = await dumpTables(COHORT_ID);
    const snapshot = parseSnapshot(JSON.stringify(await exportCohort(db, COHORT_ID)));
    // A message pointing at a channel that the snapshot does not carry: the
    // foreign key rejects it, and the whole restore has to roll back rather
    // than leave the cohort half-replaced.
    snapshot.tables.messages.push({
      ...snapshot.tables.messages[0],
      id: 999,
      channelId: "channel-that-does-not-exist",
    });

    await expect(restoreCohort(db, snapshot)).rejects.toThrow();
    expect(await dumpTables(COHORT_ID)).toBe(before);
  });
});

describe("research-flagged data", () => {
  it("is left out of an export: no check-ins, no reflection text, switches off", async () => {
    const snapshot = await exportCohort(db, COHORT_ID);
    expect(snapshot.tables.checkins).toEqual([]);
    expect(snapshot.counts.checkins).toBe(0);
    expect(snapshot.tables.submissions[0].reflectionText).toBeNull();
    expect(snapshot.tables.submissions[0].contentText).toMatch(/Predict postpaid churn/);
    expect(snapshot.tables.cohorts[0].configJson).toMatchObject({
      research: { checkins: false, reflections: false },
    });
  });

  it("is stripped from an older snapshot file on restore", async () => {
    const clean = await exportCohort(db, COHORT_ID);
    // What a snapshot taken before this rule looks like: check-ins present,
    // a reflection on the submission, and both features switched on.
    const old = JSON.parse(JSON.stringify(clean)) as Snapshot;
    old.tables.checkins = [
      {
        id: 50,
        engagementId: ENGAGEMENT_ID,
        kind: "start",
        answersJson: { formulation: 3 },
        goal: "Ask better scoping questions.",
        createdAt: "2026-08-03T02:05:10.000Z",
      },
    ];
    old.counts.checkins = 1;
    old.tables.events = [
      ...old.tables.events,
      { id: 990, engagementId: ENGAGEMENT_ID, cohortId: COHORT_ID, type: "checkin_submitted", detailJson: { kind: "start" }, timestampIso: "2026-08-03T02:05:10.000Z" },
    ];
    old.tables.submissions[0].reflectionText = "I nearly forgot to ask what a save is worth.";
    old.tables.cohorts[0].configJson = {
      ...(old.tables.cohorts[0].configJson as object),
      research: { checkins: true, reflections: true, consistencyAuditRate: 0.25 },
    };

    const result = await restoreCohort(db, parseSnapshot(JSON.stringify(old)));
    expect(result.inserted.checkins).toBe(0);
    expect((await db.select().from(schema.events)).filter((e) => e.type === "checkin_submitted")).toHaveLength(0);

    const checkins = await db.select().from(schema.checkins);
    expect(checkins).toHaveLength(0);
    const [submission] = await db
      .select()
      .from(schema.submissions)
      .where(eq(schema.submissions.id, SUBMISSION_ID));
    expect(submission.reflectionText).toBeNull();
    const [cohort] = await db.select().from(schema.cohorts).where(eq(schema.cohorts.id, COHORT_ID));
    // The other research settings are kept; only the two switches change.
    expect(cohort.configJson).toMatchObject({
      research: { checkins: false, reflections: false, consistencyAuditRate: 0.25 },
    });
  });

  it("does not modify the snapshot it is given", () => {
    const snapshot = {
      format: "agenticpracticum-cohort-snapshot",
      formatVersion: 1,
      exportedAt: "2026-09-30T00:00:00.000Z",
      cohort: { id: "c", slug: "c", name: "c" },
      counts: { checkins: 1 },
      tables: {
        cohorts: [{ id: "c", configJson: { research: { checkins: true, reflections: true } } }],
        submissions: [{ id: "s", reflectionText: "text" }],
        checkins: [{ id: 1 }],
      },
    } as unknown as Snapshot;
    const stripped = stripResearchFlagged(snapshot);
    expect(stripped.tables.checkins).toEqual([]);
    expect(snapshot.tables.checkins).toHaveLength(1);
    expect(snapshot.tables.submissions[0].reflectionText).toBe("text");
    expect(snapshot.counts.checkins).toBe(1);
  });

  it("flags check-in and reflection event types and nothing else", () => {
    expect(isResearchFlaggedEvent("checkin_submitted")).toBe(true);
    expect(isResearchFlaggedEvent("reflection_saved")).toBe(true);
    expect(isResearchFlaggedEvent("gate_submitted")).toBe(false);
    expect(isResearchFlaggedEvent(undefined)).toBe(false);
  });
});

describe("SNAPSHOT_TABLES", () => {
  it("lists parents before their children, which is what the insert order relies on", () => {
    const order = SNAPSHOT_TABLES.indexOf.bind(SNAPSHOT_TABLES);
    expect(order("cohorts")).toBeLessThan(order("students"));
    expect(order("students")).toBeLessThan(order("engagements"));
    expect(order("engagements")).toBeLessThan(order("channels"));
    expect(order("channels")).toBeLessThan(order("messages"));
    expect(order("submissions")).toBeLessThan(order("rubricScores"));
  });
});

describe("reviewer visibility of a restored showcase", () => {
  it("marks the cohort reviewer-visible and keeps the pinned pair", async () => {
    const { markReviewerVisible } = await import("@/scripts/showcase-snapshot");
    const { parseCohortConfig } = await import("@/lib/cohort/defaults");
    const snapshot = {
      format: "agenticpracticum-cohort-snapshot",
      formatVersion: 1,
      exportedAt: "2026-09-30T00:00:00Z",
      cohort: { id: "c", slug: "c", name: "c" },
      counts: {},
      tables: { cohorts: [{ id: "c", configJson: { showcase: { comparePair: { human: "h", agent: "a" } } } }] },
    } as never;
    const out = markReviewerVisible(snapshot) as unknown as { tables: { cohorts: { configJson: unknown }[] } };
    const config = parseCohortConfig({
      scenarios: { allowed: [] },
      gates: { minScoreRatio: 0.6, maxRetries: 2 },
      ui: { showRubricScores: true },
      research: { consistencyAuditRate: 0.25 },
      ...(out.tables.cohorts[0].configJson as object),
    });
    expect(config.showcase).toEqual({ comparePair: { human: "h", agent: "a" }, reviewerVisible: true, labels: {}, scriptedReplays: [], h1Patch: null });
    // The input is not modified.
    expect((snapshot as { tables: { cohorts: { configJson: { showcase: object } }[] } }).tables.cohorts[0].configJson.showcase).not.toHaveProperty("reviewerVisible");
  });
});
