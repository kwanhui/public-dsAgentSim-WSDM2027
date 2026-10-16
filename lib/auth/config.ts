import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { matchCredentials } from "@/lib/auth/credentials";
import type { AdminRole } from "@/lib/auth/roles";

// Single-instructor auth with an optional read-only reviewer account.
// ADMIN_EMAIL / ADMIN_PASSWORD_HASH: the instructor (hash via
//   `pnpm change-admin-password`).
// REVIEWER_USERNAME / REVIEWER_PASSWORD_HASH: the reviewer, disabled while
//   the hash is unset. It sees only the instructor's reviewer-visible cohorts
//   (lib/auth/cohort-scope.ts) and changes nothing.
// The credential rules live in lib/auth/credentials.ts.

export const ADMIN_USER_ID = "admin";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin";

async function ensureAdminUserRow() {
  await db
    .insert(users)
    .values({ id: ADMIN_USER_ID, email: ADMIN_EMAIL, role: "instructor" })
    .onConflictDoNothing({ target: users.id })
    .catch(() => {
      // DB unprovisioned; sign-in will fail at the DB write boundary instead.
    });
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "text", placeholder: "admin" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds) {
        const match = await matchCredentials(creds?.email, creds?.password, compare);
        if (!match) return null;
        await ensureAdminUserRow();
        // Both accounts act on the instructor's cohorts (every cohort query
        // filters through cohortScope); the role decides which cohorts they
        // may read and whether they may change them.
        return {
          id: ADMIN_USER_ID,
          email: match.email,
          name: match.role === "reviewer" ? "Reviewer" : "Admin",
          role: match.role,
        };
      },
    }),
  ],
  pages: {
    signIn: "/admin/login",
    error: "/admin/login",
  },
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id;
        token.role = (user as { role?: AdminRole }).role === "reviewer" ? "reviewer" : "instructor";
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string; role?: string }).id = (token.id as string) ?? ADMIN_USER_ID;
        (session.user as { role?: string }).role =
          token.role === "reviewer" ? "reviewer" : "instructor";
      }
      return session;
    },
  },
});
