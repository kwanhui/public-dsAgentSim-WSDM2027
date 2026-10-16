import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/lib/auth/edge-config";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const isAdminRoute = req.nextUrl.pathname.startsWith("/admin");
  const isLoginRoute = req.nextUrl.pathname.startsWith("/admin/login");
  const isAuthed = !!req.auth;

  if (isAdminRoute && !isLoginRoute && !isAuthed) {
    // A fresh URL, not a clone: the original query must ride inside
    // callbackUrl (so login lands back on e.g. ?run=<id> intact) and must not
    // also linger on the login URL itself as stray params.
    const url = new URL("/admin/login", req.nextUrl);
    url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  if (isLoginRoute && isAuthed) {
    return NextResponse.redirect(new URL("/admin", req.nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/admin/:path*"],
};
