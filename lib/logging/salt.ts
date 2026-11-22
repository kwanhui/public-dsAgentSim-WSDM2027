// The rule for PSEUDONYM_SALT, applied everywhere the salt is read (learner
// creation, the HMAC helper, the sandbox address hash and the health check).
// The salt keys every learner hash and the hash of sandbox visitors' IP
// addresses, so a public or short salt makes those hashes reversible by
// enumeration. Dependency-free.

/** The value .env.example ships with; `cp .env.example .env.local` leaves it
 * in place until the deployer replaces it. */
export const SALT_PLACEHOLDER = "replace-with-32-bytes-of-randomness";
export const MIN_SALT_LENGTH = 32;

/** Why this salt is refused, or null when it is acceptable. */
export function pseudonymSaltProblem(raw: string | undefined | null): string | null {
  const salt = raw?.trim() ?? "";
  if (!salt) return "PSEUDONYM_SALT is unset.";
  if (salt === SALT_PLACEHOLDER || salt === "CHANGE_ME") {
    return "PSEUDONYM_SALT is still the placeholder from .env.example. Set it to a random value (openssl rand -hex 32).";
  }
  if (salt.length < MIN_SALT_LENGTH) {
    return `PSEUDONYM_SALT is shorter than ${MIN_SALT_LENGTH} characters. Set it to a random value (openssl rand -hex 32).`;
  }
  return null;
}

/** The salt, or an error naming what is wrong with it. */
export function requireValidSalt(raw: string | undefined | null): string {
  const problem = pseudonymSaltProblem(raw);
  if (problem) throw new Error(`${problem} Refusing to hash learner ids.`);
  return raw!.trim();
}
