// A cohort the reviewer account can read takes no invites and no resume
// links (lib/cohort/showcase-invites.ts), except while the showcase
// regeneration script drives the server with SHOWCASE_REGEN=1. Also: "Mark
// reviewed" stores who and when, and the daily purge clears old sandbox
// address hashes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const { eq } = await import("drizzle-orm");
const { acceptInvite, classifyInvite, createInvite, InviteRefusedError } = await import("@/lib/cohort/invite");
const { createResumeLink, ResumeRefusedError } = await import("@/lib/cohort/resume");
const { reviewerVisibleInviteRefusal, REVIEWER_VISIBLE_INVITE_REFUSAL } = await import("@/lib/cohort/showcase-invites");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");
const { markAttentionReviewed } = await import("@/lib/admin/attention-review");
const { clearOldAddressHashes, ADDRESS_HASH_RETENTION_DAYS } = await import("@/lib/logging/retention");
const { joinErrorCopy } = await import("@/app/join/error/copy");

let seq = 0;
const uid = (p: string) => `${p}-${++seq}-${Math.random().toString(16).slice(2, 10)}`;
const showcaseConfig = (visible: boolean) => ({
  ...DEFAULT_COHORT_CONFIG,
  showcase: { ...DEFAULT_COHORT_CONFIG.showcase, reviewerVisible: visible },
});

async function seedCohort(visible: boolean) {
  const [user] = await db.insert(schema.users).values({ email: `${uid("u")}@x` }).returning();
  const [cohort] = await db
    .insert(schema.cohorts)
    .values({ slug: uid("cohort"), name: "C", instructorId: user.id, configJson: showcaseConfig(visible) })
    .returning();
  return cohort;
}

beforeEach(() => {
  vi.stubEnv("PSEUDONYM_SALT", "x".repeat(40));
  vi.stubEnv("AUTH_SECRET", "y".repeat(40));
  vi.stubEnv("SHOWCASE_REGEN", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("reviewer-visible cohorts take no invites", () => {
  it("refuses only a reviewer-visible cohort, and not while the regeneration runs", () => {
    expect(reviewerVisibleInviteRefusal(showcaseConfig(false), {} as NodeJS.ProcessEnv)).toBeNull();
    expect(reviewerVisibleInviteRefusal(showcaseConfig(true), {} as NodeJS.ProcessEnv)).toBe(REVIEWER_VISIBLE_INVITE_REFUSAL);
    expect(reviewerVisibleInviteRefusal(showcaseConfig(true), { SHOWCASE_REGEN: "1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it("classifies a redemption into such a cohort with its own reason and copy", () => {
    const invite = { cohortSlug: "s", usedAt: null, expiresAt: new Date(Date.now() + 1e9) };
    expect(classifyInvite({ ...invite, inviteRefusal: "no" }, "s")).toBe("reviewer-visible");
    expect(classifyInvite({ ...invite, inviteRefusal: null }, "s")).toBeNull();
    expect(joinErrorCopy("reviewer-visible").title).toBe("This invite link cannot be used");
  });

  it("will not mint an invite into a reviewer-visible cohort", async () => {
    const cohort = await seedCohort(true);
    await expect(createInvite(cohort.id)).rejects.toBeInstanceOf(InviteRefusedError);
    expect(await db.select().from(schema.cohortInvites).where(eq(schema.cohortInvites.cohortId, cohort.id))).toHaveLength(0);
  });

  it("mints one while SHOWCASE_REGEN=1, for the scripted showcase runs", async () => {
    vi.stubEnv("SHOWCASE_REGEN", "1");
    const cohort = await seedCohort(true);
    const invite = await createInvite(cohort.id);
    const joined = await acceptInvite(invite.token, cohort.slug);
    expect(joined.ok).toBe(true);
  });

  it("refuses to redeem an invite issued before reviewer access was turned on", async () => {
    const cohort = await seedCohort(false);
    const invite = await createInvite(cohort.id);
    await db.update(schema.cohorts).set({ configJson: showcaseConfig(true) }).where(eq(schema.cohorts.id, cohort.id));
    expect(await acceptInvite(invite.token, cohort.slug)).toEqual({ ok: false, reason: "reviewer-visible" });
    const [row] = await db.select().from(schema.cohortInvites).where(eq(schema.cohortInvites.token, invite.token));
    expect(row.usedAt).toBeNull();
  });

  it("will not sign a resume link for a learner in a reviewer-visible cohort", async () => {
    const open = await seedCohort(false);
    const invite = await createInvite(open.id);
    const joined = await acceptInvite(invite.token, open.slug);
    if (!joined.ok) throw new Error("join failed");
    await expect(createResumeLink(joined.accepted.studentId, "http://localhost:3000")).resolves.toMatch(/\/resume\//);
    await db.update(schema.cohorts).set({ configJson: showcaseConfig(true) }).where(eq(schema.cohorts.id, open.id));
    await expect(createResumeLink(joined.accepted.studentId, "http://localhost:3000")).rejects.toBeInstanceOf(ResumeRefusedError);
  });
});

describe("Mark reviewed and the address-hash purge", () => {
  it("stores who reviewed an engagement's flags and when", async () => {
    const cohort = await seedCohort(false);
    const [student] = await db.insert(schema.students).values({ cohortId: cohort.id, learnerHash: uid("h") }).returning();
    const [eng] = await db
      .insert(schema.engagements)
      .values({ cohortId: cohort.id, studentId: student.id, scenarioId: "customer-churn", currentStage: "formulation" })
      .returning();
    const at = new Date("2026-09-30T02:00:00Z");
    await markAttentionReviewed(eng.id, "admin", at);
    const [row] = await db.select().from(schema.engagements).where(eq(schema.engagements.id, eng.id));
    expect(row.attentionReviewedAt?.toISOString()).toBe(at.toISOString());
    expect(row.attentionReviewedBy).toBe("admin");
  });

  it("removes the IP address hash from sandbox seats older than the window and keeps the seat", async () => {
    const cohort = await seedCohort(false);
    const old = new Date(Date.now() - (ADDRESS_HASH_RETENTION_DAYS + 1) * 86_400_000);
    const [stale] = await db
      .insert(schema.students)
      .values({ cohortId: cohort.id, learnerHash: uid("h"), createdAt: old, profileJson: { kind: "sandbox", addressHash: "abc" } })
      .returning();
    const [fresh] = await db
      .insert(schema.students)
      .values({ cohortId: cohort.id, learnerHash: uid("h"), profileJson: { kind: "sandbox", addressHash: "def" } })
      .returning();
    expect(await clearOldAddressHashes()).toBeGreaterThanOrEqual(1);
    const [a] = await db.select().from(schema.students).where(eq(schema.students.id, stale.id));
    const [b] = await db.select().from(schema.students).where(eq(schema.students.id, fresh.id));
    expect(a.profileJson).toEqual({ kind: "sandbox" });
    expect(b.profileJson).toEqual({ kind: "sandbox", addressHash: "def" });
  });
});
