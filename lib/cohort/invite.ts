import { requireValidSalt } from "@/lib/logging/salt";
import { randomBytes, createHmac } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { cohorts, cohortInvites, students, studentSessions } from "@/lib/db/schema";
import { parseCohortConfig } from "@/lib/cohort/defaults";
import { reviewerVisibleInviteRefusal } from "@/lib/cohort/showcase-invites";

const INVITE_TTL_DAYS = 30;
const SESSION_TTL_DAYS = 90;

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

// A double-click on "Generate invite link" dispatches the server action twice
// before React can disable the button, so both requests reach createInvite.
// The mint button guards synchronously on the client; this window is the
// server half: a request landing this soon after the cohort's newest
// still-redeemable invite is treated as the same click and handed that
// invite back rather than minting a second one.
const DUPLICATE_MINT_WINDOW_MS = 2000;

interface NewestInvite {
  token: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * Decide whether a mint request is a duplicate of the invite just created,
 * separated from the DB calls so the window logic is testable on its own.
 * Only a still-redeemable invite counts: one already redeemed, revoked or
 * expired is history, and the instructor asking again deserves a fresh link.
 * A createdAt ahead of `now` (clock skew between app and database) can only
 * mean the invite was just minted, so it counts as within the window.
 */
export function findDuplicateMint(
  newest: NewestInvite | null | undefined,
  now: Date = new Date(),
): { token: string; expiresAt: Date } | null {
  if (!newest) return null;
  if (newest.usedAt || newest.revokedAt) return null;
  if (newest.expiresAt <= now) return null;
  if (now.getTime() - newest.createdAt.getTime() > DUPLICATE_MINT_WINDOW_MS) return null;
  return { token: newest.token, expiresAt: newest.expiresAt };
}

/** Thrown when a cohort may not take invites (lib/cohort/showcase-invites.ts). */
export class InviteRefusedError extends Error {}

/** Why this cohort takes no invites or resume links right now, or null. */
export async function cohortInviteRefusal(cohortId: string): Promise<string | null> {
  const [row] = await db
    .select({ configJson: cohorts.configJson })
    .from(cohorts)
    .where(eq(cohorts.id, cohortId))
    .limit(1);
  if (!row) return "That cohort no longer exists.";
  return reviewerVisibleInviteRefusal(parseCohortConfig(row.configJson));
}

export async function createInvite(cohortId: string): Promise<{ token: string; expiresAt: Date }> {
  // Checked here rather than only in the page, so no caller can mint an
  // invite into a cohort the reviewer account can read.
  const refusal = await cohortInviteRefusal(cohortId);
  if (refusal) throw new InviteRefusedError(refusal);
  const [newest] = await db
    .select({
      token: cohortInvites.token,
      expiresAt: cohortInvites.expiresAt,
      usedAt: cohortInvites.usedAt,
      revokedAt: cohortInvites.revokedAt,
      createdAt: cohortInvites.createdAt,
    })
    .from(cohortInvites)
    .where(eq(cohortInvites.cohortId, cohortId))
    .orderBy(desc(cohortInvites.createdAt))
    .limit(1);
  const duplicate = findDuplicateMint(newest);
  if (duplicate) return duplicate;

  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(cohortInvites).values({ cohortId, token, expiresAt });
  return { token, expiresAt };
}

export interface StudentSession {
  cookieToken: string;
  cookieExpiresAt: Date;
}

/**
 * Mint a fresh browser session for an existing learner. Used both when an
 * invite is redeemed and when a resume link is followed, so a learner who
 * switched devices gets their own session row rather than sharing one.
 */
export async function createStudentSession(studentId: string): Promise<StudentSession> {
  const cookieToken = generateToken();
  const cookieExpiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(studentSessions).values({
    studentId,
    cookieToken,
    expiresAt: cookieExpiresAt,
  });
  return { cookieToken, cookieExpiresAt };
}

/** The configured pseudonym salt; refuses to run without one. */
export function requirePseudonymSalt(env: NodeJS.ProcessEnv = process.env): string {
  // Refuses an unset salt, the .env.example placeholder and anything under
  // 32 characters (lib/logging/salt.ts).
  return requireValidSalt(env.PSEUDONYM_SALT);
}

/**
 * Create a learner row with a fresh pseudonymous hash: an HMAC of a random
 * seed that is never stored, so the hash links to nothing outside the
 * platform. Shared by invite redemption and the sandbox join.
 */
export async function createPseudonymousStudent(
  cohortId: string,
  salt: string,
  profileJson?: Record<string, unknown>,
): Promise<string> {
  const studentSeed = randomBytes(16).toString("hex");
  const learnerHash = createHmac("sha256", salt).update(studentSeed).digest("hex");
  const [student] = await db
    .insert(students)
    .values({ cohortId, learnerHash, profileJson: profileJson ?? null })
    .returning({ id: students.id });
  return student.id;
}

export interface AcceptedInvite {
  studentId: string;
  cohortId: string;
  cohortSlug: string;
  cookieToken: string;
  cookieExpiresAt: Date;
}

/** Why a join link did not work, in the vocabulary the /join/error page uses. */
export type InviteFailureReason = "invalid" | "used" | "expired" | "cohort-closed" | "reviewer-visible";

export type AcceptInviteResult =
  | { ok: true; accepted: AcceptedInvite }
  | { ok: false; reason: InviteFailureReason };

interface InviteCandidate {
  cohortSlug: string;
  usedAt: Date | null;
  expiresAt: Date;
  cohortArchivedAt?: Date | null;
  /** The cohort's refusal from reviewerVisibleInviteRefusal, if any. */
  inviteRefusal?: string | null;
}

/**
 * Decide whether a looked-up invite may be redeemed, separated from the DB
 * calls so the reason mapping is testable on its own. `expectedSlug` is the
 * slug from the /join/<slug> URL: a token that belongs to a different cohort
 * means the learner is following a mangled or hand-edited link, so it counts
 * as invalid rather than silently enrolling them somewhere else.
 *
 * An archived cohort takes no new members: the admin copy says archiving ends
 * the class, so an outstanding link to one is refused rather than quietly
 * enrolling a learner into a cohort the instructor considers finished. That
 * check runs last, so a link that was already spent or expired keeps the more
 * specific message.
 */
export function classifyInvite(
  invite: InviteCandidate | null | undefined,
  expectedSlug?: string | null,
  now: Date = new Date(),
): InviteFailureReason | null {
  if (!invite) return "invalid";
  if (expectedSlug && expectedSlug !== invite.cohortSlug) return "invalid";
  if (invite.usedAt) return "used";
  // <= so the boundary matches the overview page, which buckets an invite as
  // expired at exactly expiresAt and lists as outstanding only expiresAt > now.
  if (invite.expiresAt <= now) return "expired";
  if (invite.cohortArchivedAt) return "cohort-closed";
  if (invite.inviteRefusal) return "reviewer-visible";
  return null;
}

export async function acceptInvite(
  token: string,
  expectedSlug?: string | null,
): Promise<AcceptInviteResult> {
  const salt = requirePseudonymSalt();

  const [invite] = await db
    .select({
      id: cohortInvites.id,
      cohortId: cohortInvites.cohortId,
      cohortSlug: cohorts.slug,
      cohortArchivedAt: cohorts.archivedAt,
      cohortConfig: cohorts.configJson,
      usedAt: cohortInvites.usedAt,
      expiresAt: cohortInvites.expiresAt,
    })
    .from(cohortInvites)
    .innerJoin(cohorts, eq(cohorts.id, cohortInvites.cohortId))
    .where(eq(cohortInvites.token, token))
    .limit(1);

  const failure = classifyInvite(
    invite
      ? { ...invite, inviteRefusal: reviewerVisibleInviteRefusal(parseCohortConfig(invite.cohortConfig)) }
      : invite,
    expectedSlug,
  );
  if (failure) return { ok: false, reason: failure };

  // Burn the invite before creating rows, conditional on it still being
  // unused, so two simultaneous clicks on the same link cannot both enrol.
  const burned = await db
    .update(cohortInvites)
    .set({ usedAt: new Date() })
    .where(and(eq(cohortInvites.id, invite.id), isNull(cohortInvites.usedAt)))
    .returning({ id: cohortInvites.id });
  if (burned.length === 0) return { ok: false, reason: "used" };

  const studentId = await createPseudonymousStudent(invite.cohortId, salt);
  const session = await createStudentSession(studentId);

  return {
    ok: true,
    accepted: {
      studentId,
      cohortId: invite.cohortId,
      cohortSlug: invite.cohortSlug,
      ...session,
    },
  };
}

export async function resolveStudentByCookie(cookieToken: string) {
  const [row] = await db
    .select({
      studentId: students.id,
      cohortId: students.cohortId,
      learnerHash: students.learnerHash,
      profileJson: students.profileJson,
      sessionExpiresAt: studentSessions.expiresAt,
    })
    .from(studentSessions)
    .innerJoin(students, eq(students.id, studentSessions.studentId))
    .where(eq(studentSessions.cookieToken, cookieToken))
    .limit(1);
  if (!row) return null;
  if (row.sessionExpiresAt < new Date()) return null;
  return row;
}
