import { NextResponse } from "next/server";
import { forbidden, redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { canWrite, READ_ONLY_MESSAGE, roleOf, type SessionLike } from "@/lib/auth/roles";

// Write guards for the admin side. Every mutating server action calls
// requireWriter() before it touches anything, and every mutating admin route
// handler calls rejectReadOnly(). tests/unit/reviewer-guard.test.ts scans the
// app directory for both, so a new action or route cannot skip the check
// without a test failing.

/**
 * For server actions. Answers a reviewer with 403 (Next's forbidden()) and
 * sends a signed-out caller to the login page. Returns the instructor id when
 * the session carries one.
 *
 * `allowMissingSession` is for the one action (cohort creation) that already
 * carries the instructor id from the page render and must not lose a
 * filled-in form to a transient session read; a reviewer is still refused.
 */
export async function requireWriter(
  options: { allowMissingSession?: boolean } = {},
): Promise<{ instructorId: string | null }> {
  const session = await auth();
  if (!session?.user) {
    if (options.allowMissingSession) return { instructorId: null };
    redirect("/admin/login");
  }
  if (!canWrite(session)) forbidden();
  return { instructorId: (session.user as { id?: string }).id ?? null };
}

/**
 * For route handlers. Returns the response to send when the caller may not
 * write (401 signed out, 403 reviewer), or null when they may.
 */
export function rejectReadOnly(session: SessionLike | null): NextResponse | null {
  const role = roleOf(session);
  if (role === null) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (role !== "instructor") {
    return NextResponse.json({ error: "read-only", message: READ_ONLY_MESSAGE }, { status: 403 });
  }
  return null;
}
