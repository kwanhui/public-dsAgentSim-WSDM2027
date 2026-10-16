import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { cohorts } from "@/lib/db/schema";
import { resolveStudentByCookie } from "./invite";
import { parseCohortConfig, type CohortConfig } from "./defaults";
import { joinRouteOf, type JoinRoute } from "./join-route";

export const STUDENT_COOKIE_NAME = "agenticpracticum_student";

/**
 * Cookie attributes for the learner session, shared by invite redemption and
 * resume-link redemption so both entry paths produce an identical cookie.
 */
export function studentCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    expires,
    path: "/",
  };
}

export interface ResolvedCohort {
  cohortId: string;
  cohortSlug: string;
  cohortName: string;
  studentId: string;
  learnerHash: string;
  // How this seat was created (invite link or the public sandbox).
  joinRoute: JoinRoute;
  config: CohortConfig;
}

export async function resolveCohortFromRequest(): Promise<ResolvedCohort | null> {
  const jar = await cookies();
  const cookieToken = jar.get(STUDENT_COOKIE_NAME)?.value;
  if (!cookieToken) return null;

  const student = await resolveStudentByCookie(cookieToken);
  if (!student) return null;

  const [cohort] = await db
    .select({ id: cohorts.id, slug: cohorts.slug, name: cohorts.name, configJson: cohorts.configJson })
    .from(cohorts)
    .where(eq(cohorts.id, student.cohortId))
    .limit(1);
  if (!cohort) return null;

  const config = parseCohortConfig(cohort.configJson);

  return {
    cohortId: cohort.id,
    cohortSlug: cohort.slug,
    cohortName: cohort.name,
    studentId: student.studentId,
    learnerHash: student.learnerHash,
    joinRoute: joinRouteOf(student.profileJson),
    config,
  };
}
