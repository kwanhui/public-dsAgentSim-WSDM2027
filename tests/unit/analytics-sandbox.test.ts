// Analytics leaves sandbox seats out by default,
// as it already left out analyst-agent runs. PGlite with the real migrations.

import { beforeAll, describe, expect, it, vi } from "vitest";

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
const { modeCounts, stageFunnel, learnerMessageCounts } = await import("@/lib/analytics/queries");

beforeAll(async () => {
  await db.insert(schema.users).values({ id: "u", email: "u", role: "instructor" });
  await db.insert(schema.cohorts).values({ id: "c", slug: "c", name: "C", instructorId: "u", configJson: {} });
  await db.insert(schema.students).values([
    { id: "invited", cohortId: "c", learnerHash: "h1" },
    { id: "visitor", cohortId: "c", learnerHash: "h2", profileJson: { kind: "sandbox" } },
    { id: "agent", cohortId: "c", learnerHash: "agent:1", profileJson: { kind: "analyst-agent" } },
  ]);
  await db.insert(schema.engagements).values([
    { id: "e1", cohortId: "c", studentId: "invited", scenarioId: "customer-churn", currentStage: "formulation" },
    { id: "e2", cohortId: "c", studentId: "visitor", scenarioId: "customer-churn", currentStage: "formulation" },
    { id: "e3", cohortId: "c", studentId: "agent", scenarioId: "customer-churn", currentStage: "formulation", mode: "agent" },
  ]);
  await db.insert(schema.channels).values([
    { id: "ch1", engagementId: "e1", personaId: "p" },
    { id: "ch2", engagementId: "e2", personaId: "p" },
  ]);
  await db.insert(schema.messages).values([
    { channelId: "ch1", engagementId: "e1", sender: "learner", content: "a", timestampIso: "2026-09-30T00:00:00Z" },
    { channelId: "ch2", engagementId: "e2", sender: "learner", content: "b", timestampIso: "2026-09-30T00:00:00Z" },
  ]);
});

describe("sandbox seats in analytics", () => {
  it("counts invited, sandbox and agent engagements apart", async () => {
    expect(await modeCounts("c")).toEqual({ human: 1, agent: 1, sandbox: 1 });
  });

  it("leaves sandbox seats and agent runs out by default", async () => {
    expect((await stageFunnel("c")).reduce((n, r) => n + r.count, 0)).toBe(1);
    expect((await learnerMessageCounts("c")).map((r) => r.engagementId)).toEqual(["e1"]);
  });

  it("includes sandbox seats on request", async () => {
    expect((await stageFunnel("c", { includeSandbox: true })).reduce((n, r) => n + r.count, 0)).toBe(2);
    expect((await stageFunnel("c", { includeSandbox: true, includeAgentRuns: true })).reduce((n, r) => n + r.count, 0)).toBe(3);
  });
});
