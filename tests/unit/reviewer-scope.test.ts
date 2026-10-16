// The reviewer account (password printed in the paper) reads only cohorts
// whose configuration sets showcase.reviewerVisible. Three layers:
//
// 1. Every admin page and read route is enumerated here, with whether it
//    reads cohort data. Those that do must filter through cohortScope(); a
//    new admin route fails this test until it is listed.
// 2. No file in app/ filters on cohorts.instructorId directly (the one
//    exception creates a cohort), so a query cannot bypass the scope.
// 3. Behaviour on a migrated PGlite database: the scope condition, the CSV
//    export and the agent activity route, as a reviewer and as the
//    instructor.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const appFiles = walk(join(ROOT, "app"))
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => ({ file: relative(ROOT, f), text: readFileSync(f, "utf8") }));

// Every page and route handler a signed-in reviewer can request under
// /admin and /api/admin, and whether it reads cohort data.
const REVIEWER_REACHABLE: Record<string, "cohort-data" | "no-cohort-data"> = {
  "app/admin/page.tsx": "cohort-data",
  "app/admin/cohorts/[id]/page.tsx": "cohort-data",
  "app/admin/cohorts/[id]/analytics/page.tsx": "cohort-data",
  "app/admin/cohorts/[id]/config/page.tsx": "cohort-data",
  "app/admin/cohorts/[id]/agent/page.tsx": "cohort-data",
  "app/admin/cohorts/[id]/agent/activity/route.ts": "cohort-data",
  "app/admin/compare/page.tsx": "cohort-data",
  "app/admin/engagements/[id]/page.tsx": "cohort-data",
  "app/api/admin/cohorts/[id]/export/route.ts": "cohort-data",
  // Refuse the reviewer before any read (rejectReadOnly), and scoped anyway.
  "app/api/admin/cohorts/[id]/route.ts": "cohort-data",
  "app/api/admin/cohorts/[id]/agent-runs/route.ts": "cohort-data",
  "app/api/admin/cohorts/[id]/invites/[inviteId]/route.ts": "cohort-data",
  "app/api/admin/deletions/route.ts": "cohort-data",
  // 404 for the reviewer before any read; scoped to the instructor's cohorts.
  "app/admin/deletions/page.tsx": "cohort-data",
  // Redirects a reviewer to /admin; inserts, never lists.
  "app/admin/cohorts/page.tsx": "no-cohort-data",
  "app/admin/cohorts/new/page.tsx": "no-cohort-data",
  "app/admin/login/page.tsx": "no-cohort-data",
  "app/admin/scenarios/page.tsx": "no-cohort-data",
  "app/admin/[...rest]/page.tsx": "no-cohort-data",
};

describe("reviewer-reachable admin routes", () => {
  const routes = appFiles
    .filter((s) => /^app\/(admin|api\/admin)\//.test(s.file) && /\/(page\.tsx|route\.ts)$/.test(s.file))
    .map((s) => s.file)
    .sort();

  it("are all enumerated here", () => {
    expect(routes).toEqual(Object.keys(REVIEWER_REACHABLE).sort());
  });

  it.each(Object.entries(REVIEWER_REACHABLE).filter(([, kind]) => kind === "cohort-data"))(
    "%s filters cohorts through cohortScope()",
    (file) => {
      const text = appFiles.find((s) => s.file === file)!.text;
      expect(text).toMatch(/cohortScope\(session\)|findEngagement\([^)]*scope\)/);
    },
  );

  it("the cohort layout also scopes its lookup, so a hidden cohort's sub-pages 404", () => {
    const text = appFiles.find((s) => s.file === "app/admin/cohorts/[id]/layout.tsx")!.text;
    expect(text).toContain("cohortScope(session)");
  });

  it("no app file filters on cohorts.instructorId directly", () => {
    const offenders = appFiles
      .filter((s) => /eq\(\s*cohorts\.instructorId/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

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
const { cohortScope, mayReadCohort } = await import("@/lib/auth/cohort-scope");
const { DEFAULT_COHORT_CONFIG, parseCohortConfig } = await import("@/lib/cohort/defaults");

const REVIEWER = { user: { id: "admin", role: "reviewer" } };
const INSTRUCTOR = { user: { id: "admin", role: "instructor" } };
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

const showcaseConfig = { ...DEFAULT_COHORT_CONFIG, showcase: { comparePair: null, reviewerVisible: true, labels: {}, scriptedReplays: [], h1Patch: null } };

beforeAll(async () => {
  await db.insert(schema.users).values({ id: "admin", email: "admin", role: "instructor" });
  await db.insert(schema.cohorts).values([
    { id: "show", slug: "show", name: "Showcase", instructorId: "admin", configJson: showcaseConfig },
    { id: "course", slug: "course", name: "Course", instructorId: "admin", configJson: DEFAULT_COHORT_CONFIG },
    // Stored before the flag existed: no showcase key at all.
    { id: "old", slug: "old", name: "Old", instructorId: "admin", configJson: { scenarios: { allowed: [] } } },
  ]);
  for (const cohortId of ["show", "course"]) {
    const [s] = await db
      .insert(schema.students)
      .values({ cohortId, learnerHash: `agent:${cohortId}`, profileJson: { kind: "analyst-agent" } })
      .returning();
    await db.insert(schema.engagements).values({
      id: `run-${cohortId}`,
      cohortId,
      studentId: s.id,
      scenarioId: "customer-churn",
      currentStage: "formulation",
      mode: "agent",
    });
  }
});

describe("cohortScope on the database", () => {
  const visible = async (s: unknown) =>
    (await db.select({ id: schema.cohorts.id }).from(schema.cohorts).where(cohortScope(s as never)))
      .map((r) => r.id)
      .sort();

  it("gives the instructor every cohort it owns", async () => {
    expect(await visible(INSTRUCTOR)).toEqual(["course", "old", "show"]);
  });

  it("gives the reviewer only reviewer-visible cohorts", async () => {
    expect(await visible(REVIEWER)).toEqual(["show"]);
  });

  it("gives a signed-out session nothing", async () => {
    expect(await visible(null)).toEqual([]);
  });

  it("matches the pure rule, and old configs parse as hidden", () => {
    expect(parseCohortConfig({ ...DEFAULT_COHORT_CONFIG, showcase: { comparePair: null } }).showcase.reviewerVisible).toBe(false);
    expect(mayReadCohort(REVIEWER, parseCohortConfig(showcaseConfig))).toBe(true);
    expect(mayReadCohort(REVIEWER, DEFAULT_COHORT_CONFIG)).toBe(false);
    expect(mayReadCohort(INSTRUCTOR, DEFAULT_COHORT_CONFIG)).toBe(true);
    expect(mayReadCohort(null, showcaseConfig)).toBe(false);
  });
});

describe("reviewer requests on read routes", () => {
  const exportCsv = async (cohortId: string) => {
    const { GET } = await import("@/app/api/admin/cohorts/[id]/export/route");
    return GET(new Request(`http://x/api/admin/cohorts/${cohortId}/export?what=scores`), params({ id: cohortId }));
  };
  const activity = async (cohortId: string) => {
    const { GET } = await import("@/app/admin/cohorts/[id]/agent/activity/route");
    return GET(new Request(`http://x/admin/cohorts/${cohortId}/agent/activity?run=run-${cohortId}`), params({ id: cohortId }));
  };

  it("exports the showcase cohort to the reviewer", async () => {
    session = REVIEWER;
    expect((await exportCsv("show")).status).toBe(200);
  });

  it.each(["course", "old"])("answers 404 to the reviewer for the %s cohort export", async (id) => {
    session = REVIEWER;
    expect((await exportCsv(id)).status).toBe(404);
  });

  it("exports the course cohort to the instructor", async () => {
    session = INSTRUCTOR;
    expect((await exportCsv("course")).status).toBe(200);
  });

  it("hides a course cohort's agent activity from the reviewer", async () => {
    session = REVIEWER;
    expect((await activity("course")).status).toBe(404);
    expect((await activity("show")).status).toBe(200);
  });
});
