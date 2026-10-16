// Minimal Auth.js config for the Edge runtime (middleware).
// The full config in `config.ts` uses bcryptjs which is not Edge-compatible.
// The middleware only needs to know whether a JWT session exists, not how
// to create one.

import type { NextAuthConfig } from "next-auth";

export default {
  providers: [],
  pages: {
    signIn: "/admin/login",
    error: "/admin/login",
  },
  session: { strategy: "jwt" },
} satisfies NextAuthConfig;
