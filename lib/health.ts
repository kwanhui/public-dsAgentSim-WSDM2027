import { activeProvider } from "@/lib/llm/model-names";
import { dailyBudgetProblem, dailyBudgetUsd } from "@/lib/llm/budget-config";
import { pseudonymSaltProblem } from "@/lib/logging/salt";
import { demoModeActive, demoModeRefusal } from "@/lib/env-guard";

// Field values for the public health endpoint (app/api/health/route.ts).
// They live here rather than in the route file for two reasons: a Next route
// module may only export request handlers, so nothing in it can be unit
// tested, and the rules for what counts as "healthy" are worth testing.
//
// Nothing here reads a secret's value. Key checks answer "is it set", never
// "what is it", so the response can stay public and unauthenticated.

export interface HealthBody {
  ok: boolean;
  db: boolean;
  provider: string;
  keyPresent: boolean;
  // Configuration checks: each is "is it set", never its value.
  adminHashSet: boolean;
  reviewerHashSet: boolean;
  authSecretSet: boolean;
  pseudonymSaltSet: boolean;
  cronSecretSet: boolean;
  // DEMO_MODE=1 is set (fixed demo logins). Refused, and reported unhealthy,
  // on Vercel.
  demoMode: boolean;
  // LLM_DAILY_BUDGET_USD holds a limit, and today's spend as a share of it
  // (null without a budget or when the spend could not be read).
  budgetSet: boolean;
  todaySpendRatio: number | null;
  // When the retention purge last completed (ISO), or null if never.
  lastPurgeAt: string | null;
  version: string;
  // Settings that do not stop the deployment but should be fixed, for
  // example a paid provider with no daily budget. Plain sentences, no values.
  warnings: string[];
}

export interface ConfigChecks {
  adminHashSet: boolean;
  reviewerHashSet: boolean;
  authSecretSet: boolean;
  pseudonymSaltSet: boolean;
  cronSecretSet: boolean;
}

const isSet = (v: string | undefined) => Boolean(v?.trim());

export function configChecks(env: NodeJS.ProcessEnv = process.env): ConfigChecks {
  return {
    adminHashSet: isSet(env.ADMIN_PASSWORD_HASH),
    reviewerHashSet: isSet(env.REVIEWER_PASSWORD_HASH),
    authSecretSet: isSet(env.AUTH_SECRET) || isSet(env.NEXTAUTH_SECRET),
    // The .env.example placeholder and anything under 32 characters count
    // as unset, the same rule invite redemption and the sandbox apply
    // (lib/logging/salt.ts).
    pseudonymSaltSet: pseudonymSaltProblem(env.PSEUDONYM_SALT) === null,
    cronSecretSet: isSet(env.CRON_SECRET),
  };
}

/**
 * Which checks must pass for the deployment to report healthy. Under
 * DEMO_MODE (the offline `pnpm demo`) only the database is required: the
 * demo runs on fixed credentials and the mock provider. Otherwise the
 * database, the provider key, the instructor hash, AUTH_SECRET,
 * PSEUDONYM_SALT and CRON_SECRET are all required, since without any one of
 * them sign-in, learner joins, or the retention purge silently fail. The
 * reviewer hash is optional (the account is simply off without it).
 */
export function requiredChecks(env: NodeJS.ProcessEnv = process.env): (keyof HealthBody)[] {
  if (demoModeActive(env)) return ["db"];
  return ["db", "keyPresent", "adminHashSet", "authSecretSet", "pseudonymSaltSet", "cronSecretSet"];
}

/** Configuration that is allowed but should be fixed. Pure. */
export function healthWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const provider = activeProvider(env);
  const warnings: string[] = [];
  const budgetProblem = dailyBudgetProblem(env);
  if (budgetProblem) warnings.push(budgetProblem);
  else if (provider !== "mock" && dailyBudgetUsd(env) === null) {
    warnings.push("No LLM_DAILY_BUDGET_USD is set on a paid provider, so model spend has no daily limit and the sandbox refuses joins.");
  }
  const saltProblem = env.PSEUDONYM_SALT?.trim() ? pseudonymSaltProblem(env.PSEUDONYM_SALT) : null;
  if (saltProblem) warnings.push(saltProblem);
  if (env.ALLOW_DEMO_MODE_WITH_KEY === "1" && env.DEMO_MODE === "1" && provider !== "mock") {
    warnings.push("DEMO_MODE is on beside a paid provider (ALLOW_DEMO_MODE_WITH_KEY=1). The fixed demo logins are active; use this only for a local test.");
  }
  return warnings;
}

export interface HealthReport {
  status: number;
  body: HealthBody;
}

/**
 * Whether the API key the configured provider needs is present in the
 * environment. The mock provider (`pnpm demo`) needs no key at all, so it
 * reports true; an unrecognised provider reports false, since the app cannot
 * generate anything with it.
 */
export function keyPresent(provider: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider === "mock") return true;
  if (provider === "anthropic") return Boolean(env.ANTHROPIC_API_KEY?.trim());
  if (provider === "openai") return Boolean(env.OPENAI_API_KEY?.trim());
  return false;
}

/**
 * What build is answering. On Vercel this is the short git SHA of the
 * deployed commit, which is what a reviewer report needs to be precise about;
 * off Vercel it falls back to the package version.
 */
export function deploymentVersion(
  packageVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim();
  return sha ? sha.slice(0, 7) : packageVersion;
}

/**
 * The full response. The deployment is healthy when every required check
 * holds (see requiredChecks); anything else is a 503 with the failing field
 * still visible, so one request says what is wrong.
 */
export function healthReport(input: {
  dbOk: boolean;
  packageVersion: string;
  lastPurgeAt?: Date | null;
  todaySpendRatio?: number | null;
  env?: NodeJS.ProcessEnv;
}): HealthReport {
  const env = input.env ?? process.env;
  const provider = activeProvider(env);
  const body: HealthBody = {
    ok: false,
    db: input.dbOk,
    provider,
    keyPresent: keyPresent(provider, env),
    ...configChecks(env),
    demoMode: env.DEMO_MODE === "1",
    budgetSet: dailyBudgetUsd(env) !== null,
    todaySpendRatio: input.todaySpendRatio ?? null,
    lastPurgeAt: input.lastPurgeAt ? input.lastPurgeAt.toISOString() : null,
    version: deploymentVersion(input.packageVersion, env),
    warnings: healthWarnings(env),
  };
  body.ok = requiredChecks(env).every((k) => body[k] === true) && demoModeRefusal(env) === null;
  return { status: body.ok ? 200 : 503, body };
}
