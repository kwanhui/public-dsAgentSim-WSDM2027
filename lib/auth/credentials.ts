import type { AdminRole } from "./roles";
import { demoModeActive } from "@/lib/env-guard";

// Credential check behind the admin sign-in form, kept apart from the
// NextAuth wiring so it can be tested with an injected environment and hash
// comparison.
//
// Two accounts exist:
//   ADMIN_EMAIL (default "admin") with ADMIN_PASSWORD_HASH: the instructor.
//   REVIEWER_USERNAME (default "reviewer") with REVIEWER_PASSWORD_HASH: the
//   read-only reviewer. Disabled while its hash is unset.
// Under DEMO_MODE=1 (the offline `pnpm demo`) an account without a hash takes
// a fixed password instead: admin/demo and reviewer/reviewer. DEMO_MODE is
// refused on Vercel (lib/env-guard.ts): the fixed passwords never work there.

export interface CredentialMatch {
  role: AdminRole;
  email: string;
}

type Compare = (password: string, hash: string) => Promise<boolean>;

interface Account {
  role: AdminRole;
  username: string;
  hash: string;
  demoPassword: string;
}

export function adminAccounts(env: NodeJS.ProcessEnv = process.env): Account[] {
  return [
    {
      role: "instructor",
      username: (env.ADMIN_EMAIL ?? "admin").toLowerCase().trim(),
      hash: env.ADMIN_PASSWORD_HASH ?? "",
      demoPassword: "demo",
    },
    {
      role: "reviewer",
      username: (env.REVIEWER_USERNAME ?? "reviewer").toLowerCase().trim(),
      hash: env.REVIEWER_PASSWORD_HASH ?? "",
      demoPassword: "reviewer",
    },
  ];
}

export async function matchCredentials(
  rawEmail: unknown,
  rawPassword: unknown,
  compare: Compare,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialMatch | null> {
  const email = typeof rawEmail === "string" ? rawEmail.toLowerCase().trim() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";
  if (!email || !password) return null;

  // The instructor account is listed first, so a reviewer username that
  // collides with ADMIN_EMAIL can never shadow the instructor.
  const account = adminAccounts(env).find((a) => a.username === email);
  if (!account) return null;

  if (account.hash) {
    return (await compare(password, account.hash)) ? { role: account.role, email } : null;
  }
  if (demoModeActive(env) && password === account.demoPassword) {
    return { role: account.role, email };
  }
  return null;
}
