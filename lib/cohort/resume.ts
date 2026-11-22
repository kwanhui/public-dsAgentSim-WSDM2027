import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { cohorts, students } from "@/lib/db/schema";
import { parseCohortConfig } from "@/lib/cohort/defaults";
import { reviewerVisibleInviteRefusal } from "@/lib/cohort/showcase-invites";
import { normalizeOrigin } from "@/lib/cohort/base-url";

/**
 * Resume links.
 *
 * A learner's only credential is the httpOnly session cookie set when they
 * redeem their one-time invite. Clearing cookies or moving to another device
 * would otherwise strand them mid-engagement, and a fresh invite would start
 * a new pseudonymous learner instead of returning them to their own work.
 *
 * A resume link is a signed ticket, not a session: it carries the student id
 * and an expiry, signed with AUTH_SECRET, and /resume/<token> exchanges it for
 * a new session row. Nothing is stored, so no schema change is needed, and the
 * long-lived cookie token never travels through a URL, browser history, or an
 * instructor's chat log.
 */

const RESUME_TTL_DAYS = 14;
const TOKEN_VERSION = "v1";

export const RESUME_LINK_TTL_DAYS = RESUME_TTL_DAYS;

export type ResumeFailureReason = "invalid" | "expired";

export type VerifiedResumeToken =
  | { ok: true; studentId: string; expiresAt: Date }
  | { ok: false; reason: ResumeFailureReason };

function requireSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret === "CHANGE_ME") {
    throw new Error("AUTH_SECRET is unset; refuse to sign resume links.");
  }
  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function payloadFor(studentId: string, expiresAt: Date): string {
  return `${TOKEN_VERSION}.${studentId}.${expiresAt.getTime()}`;
}

export function signResumeToken(studentId: string, expiresAt: Date, secret = requireSecret()): string {
  const payload = payloadFor(studentId, expiresAt);
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload, secret)}`;
}

export function verifyResumeToken(
  token: string | null | undefined,
  options: { secret?: string; now?: Date } = {},
): VerifiedResumeToken {
  if (!token) return { ok: false, reason: "invalid" };
  const secret = options.secret ?? requireSecret();
  const now = options.now ?? new Date();

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [encodedPayload, signature] = parts;

  const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  const expected = sign(payload, secret);
  const given = Buffer.from(signature, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, reason: "invalid" };
  }

  const fields = payload.split(".");
  if (fields.length !== 3) return { ok: false, reason: "invalid" };
  const [version, studentId, expiryText] = fields;
  if (version !== TOKEN_VERSION || !studentId) return { ok: false, reason: "invalid" };

  const expiryMs = Number(expiryText);
  if (!Number.isFinite(expiryMs)) return { ok: false, reason: "invalid" };
  const expiresAt = new Date(expiryMs);
  if (expiresAt <= now) return { ok: false, reason: "expired" };

  return { ok: true, studentId, expiresAt };
}

function baseUrl(): string {
  return normalizeOrigin(process.env.AUTH_URL) ?? "http://localhost:3000";
}

/**
 * Mint a resume URL an instructor can hand back to a learner who lost their
 * session. Throws if the student no longer exists, so a stale admin page
 * cannot produce a link that fails only once the learner clicks it.
 *
 * `origin` is the base URL the caller resolved from the request (see
 * lib/cohort/base-url.ts). It wins over AUTH_URL, so a link minted during a
 * tunnel or LAN demo points at the host the instructor is actually on rather
 * than at a localhost value left in the environment.
 */
/** Thrown when the learner's cohort may not issue resume links. */
export class ResumeRefusedError extends Error {}

export async function createResumeLink(studentId: string, origin?: string | null): Promise<string> {
  const [student] = await db
    .select({ id: students.id, cohortConfig: cohorts.configJson })
    .from(students)
    .innerJoin(cohorts, eq(cohorts.id, students.cohortId))
    .where(eq(students.id, studentId))
    .limit(1);
  if (!student) {
    throw new Error(`No such student: ${studentId}`);
  }
  // No resume link into a cohort the reviewer account can read
  // (lib/cohort/showcase-invites.ts).
  const refusal = reviewerVisibleInviteRefusal(parseCohortConfig(student.cohortConfig));
  if (refusal) throw new ResumeRefusedError(refusal);
  const expiresAt = new Date(Date.now() + RESUME_TTL_DAYS * 24 * 60 * 60 * 1000);
  const base = normalizeOrigin(origin) ?? baseUrl();
  return `${base}/resume/${signResumeToken(student.id, expiresAt)}`;
}
