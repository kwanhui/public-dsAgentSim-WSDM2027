// Admin-side roles. Pure and dependency-free so pages, route handlers and
// tests can all ask "may this session change anything?" the same way.
//
// instructor: the single deployment owner; full rights.
// reviewer:   read-only access for conference reviewers, limited to cohorts
//             whose configuration sets showcase.reviewerVisible
//             (lib/auth/cohort-scope.ts). It changes nothing (no cohort
//             edits, invites, overrides, stage forcing, agent runs or
//             rescoring). Exports of those cohorts are reads, so they stay
//             open.

export type AdminRole = "instructor" | "reviewer";

export const REVIEWER_READ_ONLY_LINE = "Signed in as reviewer (read-only)";

export const READ_ONLY_MESSAGE = "The reviewer account is read-only.";

export interface SessionLike {
  user?: object | null;
}

/** The role a session carries; null when there is no signed-in user. */
export function roleOf(session: SessionLike | null | undefined): AdminRole | null {
  if (!session?.user) return null;
  return (session.user as { role?: unknown }).role === "reviewer" ? "reviewer" : "instructor";
}

export function isReviewer(session: SessionLike | null | undefined): boolean {
  return roleOf(session) === "reviewer";
}

/** True only for a signed-in instructor. */
export function canWrite(session: SessionLike | null | undefined): boolean {
  return roleOf(session) === "instructor";
}
