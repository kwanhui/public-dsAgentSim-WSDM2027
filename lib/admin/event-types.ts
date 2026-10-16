// Event type names the admin views read, kept free of dependencies so pure
// helpers and their tests can import them. The analyst's step failure was
// logged as analyst_stage_failed in older runs and analyst_step_failed
// in newer ones (lib/agents/analyst.ts).

export const ANALYST_FAILURE_TYPES = ["analyst_step_failed", "analyst_stage_failed"] as const;

export function isAnalystFailureType(type: string): boolean {
  return (ANALYST_FAILURE_TYPES as readonly string[]).includes(type);
}
