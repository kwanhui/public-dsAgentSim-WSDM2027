import { NextResponse } from "next/server";
import { STUDENT_COOKIE_NAME } from "@/lib/cohort/resolve";

export const runtime = "nodejs";

// Ends the learner's session on this device by clearing the student cookie.
// The session row is left alone so the engagement stays intact for the
// instructor. Invite tokens are single-use, so the learner needs a fresh
// invite to come back: the workspace control says so before it calls this.
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete({ name: STUDENT_COOKIE_NAME, path: "/" });
  return res;
}
