// The regenerated showcase carries state that the first snapshots did not:
// the hidden-fact trace (fact_elicitations, with how each reveal was found and
// whether it came early), the scoped data releases (data_releases, with the
// learner's own scope text), the needs-attention review stamp (migration
// 0015), the grade record kept on submissions and rubric scores so that it
// survives the retention purge, and the engagement's elicitation_trace flag.
// This exports a cohort holding all of them from one PGlite database, passes
// the snapshot through JSON as the file on disk would, restores it into a
// second, fresh database, and checks that the second export matches the first.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import {
  SNAPSHOT_TABLES,
  exportCohort,
  parseSnapshot,
  restoreCohort,
  type Snapshot,
  type SnapshotDb,
} from "@/scripts/showcase-snapshot";

const COHORT_ID = "cohort-regen";
const ENGAGEMENT_ID = "engagement-h1";
const SUBMISSION_ID = "submission-h1-formulation";

const clients: PGlite[] = [];

async function freshDb(): Promise<SnapshotDb> {
  const client = new PGlite();
  clients.push(client);
  await migrate(drizzle(client), { migrationsFolder: "lib/db/migrations" });
  return drizzle(client, { schema }) as unknown as SnapshotDb;
}

async function seed(db: SnapshotDb): Promise<void> {
  await db.insert(schema.users).values({ id: "instructor-1", email: "instructor@example.test" });
  await db.insert(schema.cohorts).values({
    id: COHORT_ID,
    slug: "showcase-regen",
    name: "Showcase (regenerated)",
    instructorId: "instructor-1",
    configJson: {
      research: { checkins: false, reflections: false },
      scenarios: { allowed: ["customer-churn"] },
      showcase: { reviewerVisible: true, labels: { [ENGAGEMENT_ID]: "H1" } },
    },
    createdAt: new Date("2026-09-29T01:00:00Z"),
  });
  await db.insert(schema.students).values({
    id: "student-h1",
    cohortId: COHORT_ID,
    learnerHash: "hash-h1",
    createdAt: new Date("2026-09-29T01:01:00Z"),
  });
  await db.insert(schema.engagements).values({
    id: ENGAGEMENT_ID,
    cohortId: COHORT_ID,
    studentId: "student-h1",
    scenarioId: "customer-churn",
    currentStage: "deployment",
    status: "completed",
    elicitationTrace: true,
    createdAt: new Date("2026-09-29T01:02:00Z"),
    completedAt: new Date("2026-09-29T02:00:00Z"),
    attentionReviewedAt: new Date("2026-09-29T03:00:00Z"),
    attentionReviewedBy: "instructor@example.test",
  });
  await db.insert(schema.channels).values({
    id: "channel-data",
    engagementId: ENGAGEMENT_ID,
    personaId: "data-owner",
    unlockedAt: new Date("2026-09-29T01:10:00Z"),
    createdAt: new Date("2026-09-29T01:02:00Z"),
  });
  await db.insert(schema.messages).values({
    channelId: "channel-data",
    engagementId: ENGAGEMENT_ID,
    sender: "learner",
    content: "I need subscriber_id, tenure_months and contract_type to predict churn.",
    timestampIso: "2026-09-29T01:11:00.000Z",
  });
  await db.insert(schema.submissions).values({
    id: SUBMISSION_ID,
    engagementId: ENGAGEMENT_ID,
    stage: "formulation",
    kind: "problem-statement",
    contentText: "Predict churn 30 days ahead.",
    reflectionText: "research-flagged",
    status: "scored",
    attempt: 2,
    gatePassed: true,
    gateAdvanced: true,
    assessorDirected: true,
    assessorQuote: "Dear assessor",
    createdAt: new Date("2026-09-29T01:20:00Z"),
  });
  await db.insert(schema.rubricScores).values({
    submissionId: SUBMISSION_ID,
    engagementId: ENGAGEMENT_ID,
    criterionId: "concerns-captured",
    score: 2,
    maxScore: 5,
    rationale: "Full rationale for the instructor.",
    learnerRationale: "Filtered rationale for the learner.",
    unverifiedClaim: true,
    rawScore: 4,
    unverifiedNote: "AUC not in the release profile.",
    statedNotElicited: ["save-definition"],
    judgeModel: "mock",
    promptVersion: "rubric-v7",
    createdAt: new Date("2026-09-29T01:21:00Z"),
  });
  await db.insert(schema.factElicitations).values([
    {
      engagementId: ENGAGEMENT_ID,
      factId: "duplicate-rows",
      personaId: "data-owner",
      stage: "data-collection",
      source: "turn",
      turnIndex: 3,
      learnerMessagesSoFar: 4,
      verified: true,
      matchedKey: "duplicate rows",
      detection: "reported",
      early: false,
      messageId: 1,
      createdAt: new Date("2026-09-29T01:12:00Z"),
      verifiedAt: new Date("2026-09-29T01:12:00Z"),
    },
    {
      engagementId: ENGAGEMENT_ID,
      factId: "save-definition",
      personaId: "client-sponsor",
      stage: "formulation",
      source: "reaction",
      turnIndex: 1,
      learnerMessagesSoFar: 1,
      verified: true,
      matchedKey: "6 more months",
      detection: "detected",
      early: true,
      createdAt: new Date("2026-09-29T01:05:00Z"),
      verifiedAt: null,
    },
  ]);
  await db.insert(schema.dataReleases).values({
    engagementId: ENGAGEMENT_ID,
    file: "churn_extract.csv",
    personaId: "data-owner",
    stage: "data-collection",
    scopeMessageId: 1,
    scopeText: "I need subscriber_id, tenure_months and contract_type to predict churn.",
    createdAt: new Date("2026-09-29T01:11:30Z"),
  });
  await db.insert(schema.checkins).values({
    engagementId: ENGAGEMENT_ID,
    kind: "start",
    answersJson: { formulation: 3 },
  });
  await db.insert(schema.events).values([
    {
      engagementId: ENGAGEMENT_ID,
      cohortId: COHORT_ID,
      type: "data_released",
      detailJson: { file: "churn_extract.csv", scopeText: "subscriber_id, tenure_months" },
      timestampIso: "2026-09-29T01:11:30.000Z",
    },
    {
      engagementId: ENGAGEMENT_ID,
      cohortId: COHORT_ID,
      type: "checkin_submitted",
      detailJson: { kind: "start" },
      timestampIso: "2026-09-29T01:02:30.000Z",
    },
  ]);
}

let source: SnapshotDb;
let snapshot: Snapshot;

beforeAll(async () => {
  source = await freshDb();
  await seed(source);
  snapshot = parseSnapshot(JSON.stringify(await exportCohort(source, COHORT_ID)));
}, 60_000);

afterAll(async () => {
  for (const client of clients) await client.close();
});

describe("snapshot of a regenerated showcase", () => {
  it("exports the trace, the releases and the round-4 columns", () => {
    expect(SNAPSHOT_TABLES).toContain("factElicitations");
    expect(SNAPSHOT_TABLES).toContain("dataReleases");
    expect(snapshot.counts.factElicitations).toBe(2);
    expect(snapshot.counts.dataReleases).toBe(1);
    const detected = snapshot.tables.factElicitations.find((r) => r.factId === "save-definition");
    expect(detected).toMatchObject({ detection: "detected", early: true });
    expect(snapshot.tables.dataReleases[0].scopeText).toMatch(/tenure_months/);
    expect(snapshot.tables.engagements[0]).toMatchObject({
      elicitationTrace: true,
      attentionReviewedBy: "instructor@example.test",
      attentionReviewedAt: "2026-09-29T03:00:00.000Z",
    });
    expect(snapshot.tables.submissions[0]).toMatchObject({
      attempt: 2,
      gatePassed: true,
      gateAdvanced: true,
      assessorDirected: true,
      assessorQuote: "Dear assessor",
    });
    expect(snapshot.tables.rubricScores[0]).toMatchObject({
      learnerRationale: "Filtered rationale for the learner.",
      unverifiedNote: "AUC not in the release profile.",
      statedNotElicited: ["save-definition"],
      rawScore: 4,
    });
  });

  it("still strips check-ins, reflection text and check-in events", () => {
    expect(snapshot.tables.checkins).toEqual([]);
    expect(snapshot.tables.submissions[0].reflectionText).toBeNull();
    expect(snapshot.tables.events.map((e) => e.type)).toEqual(["data_released"]);
  });

  it("restores into a fresh database and exports the same rows", async () => {
    const target = await freshDb();
    const result = await restoreCohort(target, snapshot);
    expect(result.inserted.factElicitations).toBe(2);
    expect(result.inserted.dataReleases).toBe(1);

    const again = parseSnapshot(JSON.stringify(await exportCohort(target, COHORT_ID)));
    expect(again.counts).toEqual(snapshot.counts);
    for (const name of SNAPSHOT_TABLES) {
      expect(again.tables[name], name).toEqual(snapshot.tables[name]);
    }

    // Timestamps come back as dates, not strings, and the serial sequences
    // of the new tables move past the restored ids.
    const [row] = await target.select().from(schema.factElicitations).limit(1);
    expect(row.createdAt).toBeInstanceOf(Date);
    const [release] = await target
      .insert(schema.dataReleases)
      .values({ engagementId: ENGAGEMENT_ID, file: "other.csv", personaId: "data-owner", stage: "data-collection" })
      .returning();
    expect(release.id).toBeGreaterThan(Number(snapshot.tables.dataReleases[0].id));
  }, 60_000);

  it("reads a snapshot file written before the two tables existed", () => {
    const old = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    delete (old.tables as Partial<Snapshot["tables"]>).factElicitations;
    delete (old.tables as Partial<Snapshot["tables"]>).dataReleases;
    const parsed = parseSnapshot(JSON.stringify(old));
    expect(parsed.tables.factElicitations).toEqual([]);
    expect(parsed.tables.dataReleases).toEqual([]);
  });
});
