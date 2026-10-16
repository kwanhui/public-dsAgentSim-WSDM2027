import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { students } from "@/lib/db/schema";
import { createStudentSession } from "@/lib/cohort/invite";
import { verifyResumeToken } from "@/lib/cohort/resume";
import { STUDENT_COOKIE_NAME, studentCookieOptions } from "@/lib/cohort/resolve";

export const runtime = "nodejs";

// Re-entry for a learner who lost their session cookie (cleared cookies, new
// device, new browser). The signed ticket in the path is exchanged for a fresh
// session row and the same cookie invite redemption sets, so the learner lands
// back in their own engagement rather than starting a second one.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const verified = verifyResumeToken(token);
  if (!verified.ok) {
    const reason = verified.reason === "expired" ? "resume-expired" : "resume-invalid";
    return NextResponse.redirect(new URL(`/join/error?reason=${reason}`, req.url));
  }

  const [student] = await db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.id, verified.studentId))
    .limit(1);
  if (!student) {
    return NextResponse.redirect(new URL("/join/error?reason=resume-invalid", req.url));
  }

  const session = await createStudentSession(student.id);
  const res = NextResponse.redirect(new URL("/workspace", req.url));
  res.cookies.set(
    STUDENT_COOKIE_NAME,
    session.cookieToken,
    studentCookieOptions(session.cookieExpiresAt),
  );
  return res;
}
