// The reviewer account, whose password is printed in the paper, may see only
// an exhibit cohort: the config route refuses reviewerVisible on a cohort
// with open join or with invited learners other than labelled showcase runs.

import { describe, expect, it, vi } from "vitest";
import { reviewerVisibleRefusal, unlabelledInvitedLearners } from "@/lib/cohort/reviewer-visibility";

describe("reviewerVisibleRefusal", () => {
  it("allows an exhibit cohort", () => {
    expect(reviewerVisibleRefusal({ reviewerVisible: true, openJoin: false, invitedLearners: 0 })).toBeNull();
  });

  it("refuses open join and invited learners", () => {
    expect(reviewerVisibleRefusal({ reviewerVisible: true, openJoin: true, invitedLearners: 0 })).toMatch(/open join/);
    expect(reviewerVisibleRefusal({ reviewerVisible: true, openJoin: false, invitedLearners: 3 })).toMatch(/has 3/);
  });

  it("has nothing to say when the flag is off", () => {
    expect(reviewerVisibleRefusal({ reviewerVisible: false, openJoin: true, invitedLearners: 9 })).toBeNull();
  });

  it("counts invited learners unless every engagement they have is a labelled showcase run", () => {
    const labels = { e1: "H1", e2: "exhibit" };
    expect(
      unlabelledInvitedLearners(
        [
          { joinRoute: "invite", engagementIds: ["e1"] },
          { joinRoute: "invite", engagementIds: ["e2", "e3"] },
          { joinRoute: "invite", engagementIds: [] },
          { joinRoute: "agent", engagementIds: ["e4"] },
          { joinRoute: "sandbox", engagementIds: ["e5"] },
        ],
        labels,
      ),
    ).toBe(2);
  });
});

// The route itself, against PGlite.
const session: unknown = { user: { id: "admin", role: "instructor" } };
vi.mock("@/lib/auth/config", () => ({ auth: async () => session }));
vi.mock("@/lib/scenarios/load", () => ({ listScenarios: async () => [{ id: "customer-churn" }] }));
vi.mock("@/lib/db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("@/lib/db/schema");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "lib/db/migrations" });
  return { db };
});

describe("PATCH cohort config", () => {
  // The first import of the route and its dependencies has come within a
  // second of the 5 s default timeout under a loaded run, so allow 20 s.
  it("refuses reviewerVisible for a course cohort with an invited learner, and allows it once the run is labelled", async () => {
    const { db } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");
    const { PATCH } = await import("@/app/api/admin/cohorts/[id]/route");
    await db.insert(schema.users).values({ id: "admin" });
    await db.insert(schema.cohorts).values({ id: "c1", slug: "course", name: "Course", instructorId: "admin", configJson: DEFAULT_COHORT_CONFIG });
    await db.insert(schema.students).values({ id: "s1", cohortId: "c1", learnerHash: "h".repeat(20) });
    await db.insert(schema.engagements).values({ id: "e1", cohortId: "c1", studentId: "s1", scenarioId: "customer-churn", currentStage: "formulation" });
    const save = (showcase: object) =>
      PATCH(
        new Request("http://x", {
          method: "PATCH",
          body: JSON.stringify({
            config: { ...DEFAULT_COHORT_CONFIG, scenarios: { allowed: ["customer-churn"] }, showcase: { comparePair: null, reviewerVisible: true, ...showcase } },
          }),
        }),
        { params: Promise.resolve({ id: "c1" }) },
      );
    const refused = await save({ labels: {} });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "reviewer-visible-refused" });
    const allowed = await save({ labels: { e1: "H1" } });
    expect(allowed.status).toBe(200);
  }, 20_000);
});
