// Export columns: join_route on every export, raw_score and
// unverified_claim on the scores export, and the per-engagement export with
// the elicitation trace and USD for the instructor only. Run against a migrated PGlite database.

import { beforeAll, describe, expect, it, vi } from "vitest";

// The USD column prices the deployment's default models; a shell that sets
// LLM_PROVIDER=mock would price every call at zero.
vi.stubEnv("LLM_PROVIDER", "anthropic");

let session: unknown = null;
vi.mock("@/lib/auth/config", () => ({ auth: async () => session }));
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
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");
const { GET } = await import("@/app/api/admin/cohorts/[id]/export/route");

const INSTRUCTOR = { user: { id: "admin", role: "instructor" } };
const REVIEWER = { user: { id: "admin", role: "reviewer" } };

function parse(csv: string): Record<string, string>[] {
  const [head, ...lines] = csv.trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

async function exportCsv(what: string): Promise<Record<string, string>[]> {
  const res = await GET(new Request(`http://x/api/admin/cohorts/c1/export?what=${what}`), {
    params: Promise.resolve({ id: "c1" }),
  });
  expect(res.status).toBe(200);
  return parse(await res.text());
}

beforeAll(async () => {
  await db.insert(schema.users).values({ id: "admin", email: "admin", role: "instructor" });
  await db.insert(schema.cohorts).values({
    id: "c1",
    slug: "c1",
    name: "C1",
    instructorId: "admin",
    configJson: { ...DEFAULT_COHORT_CONFIG, showcase: { comparePair: null, reviewerVisible: true } },
  });
  await db.insert(schema.students).values([
    { id: "s-invite", cohortId: "c1", learnerHash: "hash-invite" },
    { id: "s-sandbox", cohortId: "c1", learnerHash: "hash-sandbox", profileJson: { kind: "sandbox", addressHash: "x" } },
    { id: "s-old", cohortId: "c1", learnerHash: "hash-old" },
  ]);
  await db.insert(schema.engagements).values([
    { id: "e-invite", cohortId: "c1", studentId: "s-invite", scenarioId: "customer-churn", currentStage: "data-collection" },
    { id: "e-sandbox", cohortId: "c1", studentId: "s-sandbox", scenarioId: "customer-churn", currentStage: "formulation" },
    // A run from before the elicitation trace: its persona turns carry no
    // prompt version, as in the showcase snapshot.
    { id: "e-old", cohortId: "c1", studentId: "s-old", scenarioId: "customer-churn", currentStage: "formulation", createdAt: new Date("2026-08-26T04:00:00Z") },
  ]);
  await db.insert(schema.submissions).values({
    id: "sub1",
    engagementId: "e-invite",
    stage: "formulation",
    kind: "problem-statement",
    contentText: "AUC 0.91",
    status: "scored",
  });
  await db.insert(schema.rubricScores).values([
    { submissionId: "sub1", engagementId: "e-invite", criterionId: "a", score: 5, rawScore: 5, unverifiedClaim: true, maxScore: 5, rationale: "r", judgeModel: "j", promptVersion: "rubric-v5" },
    { submissionId: "sub1", engagementId: "e-invite", criterionId: "b", score: 3, rawScore: null, unverifiedClaim: null, maxScore: 5, rationale: "r", judgeModel: "j", promptVersion: "rubric-v3" },
  ]);
  await db.insert(schema.events).values([
    { engagementId: "e-invite", cohortId: "c1", type: "fact_elicited", detailJson: { factId: "offer-cost", persona: "sarah", turnIndex: 2, learnerMessagesSoFar: 3 }, timestampIso: "2026-09-30T01:00:00Z" },
    { engagementId: "e-invite", cohortId: "c1", type: "persona_failed", detailJson: { promptTokens: 1000, completionTokens: 100 }, timestampIso: "2026-09-30T01:01:00Z" },
  ]);
  await db.insert(schema.channels).values({ id: "ch1", engagementId: "e-invite", personaId: "sarah" });
  await db.insert(schema.messages).values({ channelId: "ch1", engagementId: "e-invite", sender: "sarah", content: "x", promptTokens: 2000, completionTokens: 200, timestampIso: "2026-09-30T01:00:00Z" });
});

describe("exports", () => {
  it("scores carry join_route, raw_score and unverified_claim", async () => {
    session = INSTRUCTOR;
    const rows = await exportCsv("scores");
    expect(rows.map((r) => [r.criterion_id, r.join_route, r.score, r.raw_score, r.unverified_claim])).toEqual([
      ["a", "invite", "5", "5", "true"],
      ["b", "invite", "3", "", ""],
    ]);
  });

  it("the engagements export carries the join route, the elicitation trace and the unverified count", async () => {
    session = INSTRUCTOR;
    const rows = await exportCsv("engagements");
    const invite = rows.find((r) => r.engagement_id === "e-invite")!;
    const sandbox = rows.find((r) => r.engagement_id === "e-sandbox")!;
    expect(invite).toMatchObject({
      join_route: "invite",
      hidden_facts_obtained: "1",
      hidden_facts_obtained_at: "offer-cost@3",
      unverified_criteria: "1",
    });
    expect(Number(invite.hidden_facts_total)).toBeGreaterThan(1);
    expect(Number(invite.usd)).toBeGreaterThan(0);
    expect(sandbox).toMatchObject({
      join_route: "sandbox",
      hidden_facts_recorded: "yes",
      hidden_facts_obtained: "0",
      unverified_criteria: "0",
    });
  });

  it("exports a run from before the elicitation trace as not recorded, never 0", async () => {
    session = INSTRUCTOR;
    await db.insert(schema.events).values({
      engagementId: "e-old", cohortId: "c1", type: "persona_turn", detailJson: { persona: "sarah" }, timestampIso: "2026-08-26T04:01:00Z",
    });
    const rows = await exportCsv("engagements");
    const old = rows.find((r) => r.engagement_id === "e-old")!;
    expect(old).toMatchObject({
      hidden_facts_recorded: "not recorded",
      hidden_facts_obtained: "",
      hidden_facts_verified: "",
      hidden_facts_obtained_at: "",
    });
    expect(Number(old.hidden_facts_total)).toBeGreaterThan(1);
  });

  it("leaves USD empty in the reviewer's engagements export", async () => {
    session = REVIEWER;
    const rows = await exportCsv("engagements");
    expect(rows.every((r) => r.usd === "")).toBe(true);
  });

  it("events carry join_route", async () => {
    session = INSTRUCTOR;
    const rows = await exportCsv("events");
    expect(new Set(rows.map((r) => r.join_route))).toEqual(new Set(["invite"]));
  });
});
