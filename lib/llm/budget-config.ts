// The daily budget setting, apart from lib/llm/budget.ts so that dependency-
// free modules (the health report, the startup guard) can read it without
// the database client.

/** LLM_DAILY_BUDGET_USD as a number, or null when unset or blank (no
 * limit). A value that is set but not a non-negative number also reads as
 * null here, and stops startup (dailyBudgetProblem, lib/env-guard.ts), so it
 * never silently means "no limit" on a running server. */
export function dailyBudgetUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.LLM_DAILY_BUDGET_USD?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Why LLM_DAILY_BUDGET_USD is refused, or null when it is unset or valid. */
export function dailyBudgetProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.LLM_DAILY_BUDGET_USD?.trim();
  if (!raw) return null;
  if (dailyBudgetUsd(env) !== null) return null;
  return `LLM_DAILY_BUDGET_USD is set to "${raw}", which is not a number of US dollars. Use a plain number such as 5, or leave it unset for no limit.`;
}
