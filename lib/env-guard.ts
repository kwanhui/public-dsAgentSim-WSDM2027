// Startup checks on the environment that must stop the app rather than let
// it run in an unsafe state. Dependency-free, so next.config.ts, the
// instrumentation hook, the credential check and the health endpoint all
// apply the same rule.

// Relative, not "@/": next.config.ts imports this file before path aliases apply.
import { dailyBudgetProblem } from "./llm/budget-config";

/**
 * DEMO_MODE=1 turns on the fixed admin/demo and reviewer/reviewer logins for
 * the offline `pnpm demo`. Beside a paid key that hands out instructor
 * access to anyone who has read the README, so it is refused on Vercel
 * always, and elsewhere unless the provider is the offline mock
 * (LLM_PROVIDER=mock). ALLOW_DEMO_MODE_WITH_KEY=1 lifts the second rule for
 * a local test against a real provider. Returns the error to raise, or null
 * when the setting is allowed.
 */
export function demoModeRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DEMO_MODE !== "1") return null;
  if (env.VERCEL?.trim()) {
    return "DEMO_MODE=1 is set on a Vercel deployment. DEMO_MODE enables fixed demo logins and is for the local `pnpm demo` only. Remove DEMO_MODE from the project's environment variables and redeploy.";
  }
  const provider = env.LLM_PROVIDER?.trim() || "anthropic";
  if (provider !== "mock" && env.ALLOW_DEMO_MODE_WITH_KEY !== "1") {
    return `DEMO_MODE=1 is set with LLM_PROVIDER=${provider}. DEMO_MODE enables fixed demo logins, so it runs only with LLM_PROVIDER=mock. For a local test against a real provider, also set ALLOW_DEMO_MODE_WITH_KEY=1; never on a shared deployment.`;
  }
  return null;
}

/** True when the offline demo logins are active: DEMO_MODE=1 and allowed. */
export function demoModeActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEMO_MODE === "1" && demoModeRefusal(env) === null;
}

/** Every reason the environment is refused at startup. */
export function startupProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  return [demoModeRefusal(env), dailyBudgetProblem(env)].filter((p): p is string => p !== null);
}

/** Throws at startup when the environment is refused. */
export function assertStartupEnv(env: NodeJS.ProcessEnv = process.env): void {
  const problems = startupProblems(env);
  if (problems.length > 0) throw new Error(problems.join("\n"));
}
