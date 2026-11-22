// Sandbox learner path. A cohort with sandbox.openJoin set can be joined
// without an invite: the public /try route creates a fresh pseudonymous
// learner in it and lands them in the workspace. It exists so that a
// conference reviewer can try the learner side, and it is off unless an
// instructor turns it on for a cohort.
//
// Which cohort is the sandbox: the one named by SANDBOX_COHORT_SLUG when it
// is set, otherwise the only cohort with open join. With two or more open
// cohorts and no SANDBOX_COHORT_SLUG the bare /try link and the landing page
// link go nowhere, and the admin pages warn (following "the most recently
// created open cohort" would move the link silently when a second one is
// created). /try/<slug> always names its cohort.
//
// Guards, in order: the cohort must exist, be open and not archived; a daily
// spend budget must be set (lib/llm/budget.ts; the offline mock provider
// costs nothing and is exempt); the budget must not be spent; the cohort's
// sandbox.maxJoinsPerDay (UTC day) must not be reached; and one address may
// take at most SANDBOX_JOINS_PER_IP_PER_DAY seats a day (one visitor
// clearing cookies could otherwise take every seat).

import { createHmac } from "node:crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { cohorts, students } from "@/lib/db/schema";
import { parseCohortConfig, type CohortConfig } from "@/lib/cohort/defaults";
import { createPseudonymousStudent, createStudentSession, requirePseudonymSalt, type StudentSession } from "@/lib/cohort/invite";
import { utcDayStart } from "@/lib/llm/budget";

// Marks learners created through the sandbox, for the daily count and so
// instructors can tell them from invited learners in exports.
export const SANDBOX_PROFILE_KIND = "sandbox";

export interface SandboxCohort {
  id: string;
  slug: string;
  name: string;
  config: CohortConfig;
}

interface CohortRow {
  id: string;
  slug: string;
  name: string;
  configJson: unknown;
  archivedAt: Date | null;
  createdAt: Date;
}

/** Every open, unarchived cohort, from rows sorted newest first. */
export function openJoinCohorts(rows: CohortRow[]): SandboxCohort[] {
  const open: SandboxCohort[] = [];
  for (const row of rows) {
    if (row.archivedAt) continue;
    const config = parseCohortConfig(row.configJson);
    if (config.sandbox.openJoin) open.push({ id: row.id, slug: row.slug, name: row.name, config });
  }
  return open;
}

/**
 * The sandbox cohort among the open ones: the one SANDBOX_COHORT_SLUG names
 * (null when that cohort is not open), otherwise the only open cohort, and
 * null when there are several. Pure.
 */
export function pickSandboxCohort(open: SandboxCohort[], configuredSlug?: string | null): SandboxCohort | null {
  const slug = configuredSlug?.trim();
  if (slug) return open.find((c) => c.slug === slug) ?? null;
  return open.length === 1 ? open[0] : null;
}

/** The open cohort with this slug, or with no slug the configured sandbox
 * cohort. Pure apart from reading SANDBOX_COHORT_SLUG. */
export function pickOpenJoinCohort(rows: CohortRow[], slug?: string): SandboxCohort | null {
  const open = openJoinCohorts(rows);
  if (slug) return open.find((c) => c.slug === slug) ?? null;
  return pickSandboxCohort(open, process.env.SANDBOX_COHORT_SLUG);
}

async function cohortRows(): Promise<CohortRow[]> {
  return db
    .select({
      id: cohorts.id,
      slug: cohorts.slug,
      name: cohorts.name,
      configJson: cohorts.configJson,
      archivedAt: cohorts.archivedAt,
      createdAt: cohorts.createdAt,
    })
    .from(cohorts)
    .where(isNull(cohorts.archivedAt))
    .orderBy(desc(cohorts.createdAt));
}

/** The open cohort with this slug, or with no slug the configured sandbox
 * cohort (see pickSandboxCohort). */
export async function findOpenJoinCohort(slug?: string): Promise<SandboxCohort | null> {
  return pickOpenJoinCohort(await cohortRows(), slug);
}

/** Every open cohort, for the admin warning when there is more than one. */
export async function listOpenJoinCohorts(): Promise<SandboxCohort[]> {
  return openJoinCohorts(await cohortRows());
}

/** The admin warning text when more than one cohort has open join, or null. */
export function openJoinWarning(open: { name: string; slug: string }[], configuredSlug?: string | null): string | null {
  if (open.length < 2) return null;
  const names = open.map((c) => `${c.name} (${c.slug})`).join(", ");
  const slug = configuredSlug?.trim();
  if (slug && open.some((c) => c.slug === slug)) {
    return `${open.length} cohorts have open join: ${names}. The landing page and /try use ${slug} (SANDBOX_COHORT_SLUG); the others take sandbox visitors only through /try/<slug>.`;
  }
  return `${open.length} cohorts have open join: ${names}. The landing page shows no sandbox link and /try refuses until only one is open or SANDBOX_COHORT_SLUG names one.`;
}

export async function countSandboxJoinsToday(cohortId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(students)
    .where(
      and(
        eq(students.cohortId, cohortId),
        gte(students.createdAt, utcDayStart(now)),
        sql`${students.profileJson} ->> 'kind' = ${SANDBOX_PROFILE_KIND}`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Seats one address may take per UTC day, across all cohorts. */
export const SANDBOX_JOINS_PER_IP_PER_DAY = 5;

export type SandboxRefusal = "sandbox-closed" | "sandbox-no-budget" | "sandbox-full" | "sandbox-ip-limit" | "usage-limit";

/** Decide whether one more sandbox join may go ahead. Pure. */
export function sandboxJoinRefusal(input: {
  cohort: SandboxCohort | null;
  budgetOk: boolean;
  // A daily budget is set, or the provider costs nothing (mock).
  budgetSet?: boolean;
  joinsToday: number;
  joinsFromAddressToday?: number;
}): SandboxRefusal | null {
  if (!input.cohort || !input.cohort.config.sandbox.openJoin) return "sandbox-closed";
  if (input.budgetSet === false) return "sandbox-no-budget";
  if (!input.budgetOk) return "usage-limit";
  if (input.joinsToday >= input.cohort.config.sandbox.maxJoinsPerDay) return "sandbox-full";
  if ((input.joinsFromAddressToday ?? 0) >= SANDBOX_JOINS_PER_IP_PER_DAY) return "sandbox-ip-limit";
  return null;
}

// ---------------------------------------------------------------------------
// Per-address throttle. The address is stored only as an HMAC under the
// pseudonym salt, in the sandbox learner's profile, so the daily count
// survives a restart and is shared by every server instance; an in-memory
// count covers joins in flight on this instance before their rows land.
// ---------------------------------------------------------------------------

/** The client address from the proxy headers, or null. */
export function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const real = headers.get("x-real-ip")?.trim();
  return real || null;
}

export function addressHash(address: string, salt: string): string {
  return createHmac("sha256", salt).update(`sandbox-ip:${address}`).digest("hex").slice(0, 32);
}

const recentJoins = new Map<string, { dayStartMs: number; count: number }>();

/** For tests. */
export function resetAddressCounts(): void {
  recentJoins.clear();
}

export function noteAddressJoin(hash: string, now: Date = new Date()): void {
  const day = utcDayStart(now).getTime();
  const entry = recentJoins.get(hash);
  recentJoins.set(hash, { dayStartMs: day, count: entry && entry.dayStartMs === day ? entry.count + 1 : 1 });
}

export function inMemoryAddressJoins(hash: string, now: Date = new Date()): number {
  const entry = recentJoins.get(hash);
  return entry && entry.dayStartMs === utcDayStart(now).getTime() ? entry.count : 0;
}

export async function countAddressJoinsToday(hash: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(students)
    .where(
      and(
        gte(students.createdAt, utcDayStart(now)),
        sql`${students.profileJson} ->> 'kind' = ${SANDBOX_PROFILE_KIND}`,
        sql`${students.profileJson} ->> 'addressHash' = ${hash}`,
      ),
    );
  return Math.max(Number(row?.n ?? 0), inMemoryAddressJoins(hash, now));
}

export async function createSandboxLearner(
  cohortId: string,
  addressHashValue?: string | null,
): Promise<StudentSession & { studentId: string }> {
  const studentId = await createPseudonymousStudent(cohortId, requirePseudonymSalt(), {
    kind: SANDBOX_PROFILE_KIND,
    ...(addressHashValue ? { addressHash: addressHashValue } : {}),
  });
  return { studentId, ...(await createStudentSession(studentId)) };
}
