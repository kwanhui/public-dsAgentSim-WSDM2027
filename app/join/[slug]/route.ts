import { NextResponse, type NextRequest } from "next/server";
import { acceptInvite } from "@/lib/cohort/invite";
import { STUDENT_COOKIE_NAME, studentCookieOptions } from "@/lib/cohort/resolve";

export const runtime = "nodejs";

// Invite redemption runs in a Route Handler, not a Server Component page,
// because the student session cookie can only be set from a Route Handler or
// Server Action. The token travels in the email link's `t` query param; the
// slug must match the cohort the token belongs to, so an edited or mangled URL
// cannot enrol a learner into a cohort other than the one they were invited to.
// On success we set the cookie and land the learner in /workspace.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const token = req.nextUrl.searchParams.get("t");
  if (!token) {
    return NextResponse.redirect(new URL("/join/error?reason=missing", req.url));
  }

  // acceptInvite reports why a token failed (invalid / used / expired) and
  // throws only on a server misconfiguration (e.g. PSEUDONYM_SALT unset);
  // let that surface.
  const result = await acceptInvite(token, slug);
  if (!result.ok) {
    return NextResponse.redirect(new URL(`/join/error?reason=${result.reason}`, req.url));
  }

  const res = NextResponse.redirect(new URL("/workspace", req.url));
  res.cookies.set(
    STUDENT_COOKIE_NAME,
    result.accepted.cookieToken,
    studentCookieOptions(result.accepted.cookieExpiresAt),
  );
  return res;
}
