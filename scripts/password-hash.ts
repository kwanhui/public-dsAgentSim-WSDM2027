// Pure helpers behind scripts/change-admin-password.ts, kept apart so they
// can be tested without running the script.

export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordArgs {
  // Which account the hash is for.
  target: "ADMIN_PASSWORD_HASH" | "REVIEWER_PASSWORD_HASH";
  // Push the hash to the linked Vercel project's production environment
  // instead of printing it.
  vercel: boolean;
}

export function parsePasswordArgs(argv: string[]): PasswordArgs | { error: string } {
  const known = new Set(["--reviewer", "--vercel", "--local"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    return {
      error: `Unknown argument ${unknown[0]}. The password is read from a prompt or stdin, never from the command line. Options: --reviewer, --vercel.`,
    };
  }
  return {
    target: argv.includes("--reviewer") ? "REVIEWER_PASSWORD_HASH" : "ADMIN_PASSWORD_HASH",
    vercel: argv.includes("--vercel"),
  };
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.trim() !== password) return "Leading or trailing spaces are not allowed.";
  return null;
}

/**
 * The line to paste into .env.local. Next loads .env files through
 * dotenv-expand, which reads "$name" as a variable reference and would
 * corrupt a bcrypt hash ($2b$12$...), so every "$" is escaped.
 */
export function envLocalLine(name: string, hash: string): string {
  return `${name}=${hash.replace(/\$/g, "\\$")}`;
}
