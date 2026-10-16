import { and, eq, sql, type SQL } from "drizzle-orm";
import { cohorts } from "@/lib/db/schema";
import { roleOf, type SessionLike } from "@/lib/auth/roles";
import type { CohortConfig } from "@/lib/cohort/defaults";

// Which cohorts an admin session may read. The instructor reads every
// cohort it owns. The reviewer account, whose password is printed in the
// paper, reads only cohorts whose configuration sets
// showcase.reviewerVisible: a
// course cohort or the public sandbox on the same deployment stays out of
// its lists, monitors, compare view, analytics and exports.
//
// Every admin page and route that reads cohort data filters through
// cohortScope(); tests/unit/reviewer-scope.test.ts scans app/ for any cohort
// query that does not.

/** The instructor id a session acts for; null when signed out. */
export function sessionInstructorId(session: SessionLike | null | undefined): string | null {
  if (!session?.user) return null;
  const id = (session.user as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Whether this session may read a cohort with this configuration. Pure. */
export function mayReadCohort(
  session: SessionLike | null | undefined,
  config: Pick<CohortConfig, "showcase">,
): boolean {
  const role = roleOf(session);
  if (role === null) return false;
  if (role === "instructor") return true;
  return config.showcase.reviewerVisible === true;
}

// jsonb test for the flag; a config saved before the flag existed has no key
// and is therefore hidden from the reviewer.
export const reviewerVisibleSql: SQL = sql`coalesce((${cohorts.configJson} -> 'showcase' ->> 'reviewerVisible') = 'true', false)`;

/**
 * The WHERE condition on `cohorts` for everything this session may read.
 * Join `cohorts` into any query that reads engagements, learners, events or
 * scores and add this condition. A signed-out session matches nothing.
 */
export function cohortScope(session: SessionLike | null | undefined): SQL {
  const instructorId = sessionInstructorId(session);
  if (!instructorId) return sql`false`;
  const owned = eq(cohorts.instructorId, instructorId);
  return roleOf(session) === "reviewer" ? (and(owned, reviewerVisibleSql) as SQL) : owned;
}
