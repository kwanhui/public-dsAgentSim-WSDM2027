// Which provider and models the deployment is configured with, resolved the
// same way getLLM() in lib/llm/client.ts resolves them. Dependency-free.

/**
 * An environment value, trimmed, or undefined when it is unset or blank.
 * `cp .env.example .env.local` used to leave LLM_PERSONA_MODEL= and
 * LLM_RUBRIC_MODEL= as empty strings, and `"" ?? default` is "", so every
 * call went out with an empty model id. A blank
 * value now counts as unset everywhere the LLM settings are read.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

// The env var is what the running process uses, so the admin UI reports this
// one. The optional argument lets callers that test environment handling
// (the health endpoint) pass their own env.
export function activeProvider(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, "LLM_PROVIDER") ?? "anthropic";
}

// Effective model ids. The instructor cannot set these per cohort (they are
// deployment-level), so the configuration page shows them read-only.
export function personaModelName(env: NodeJS.ProcessEnv = process.env): string {
  const provider = activeProvider(env);
  if (provider === "mock") return "mock";
  if (provider === "anthropic") return envValue(env, "LLM_PERSONA_MODEL") ?? "claude-sonnet-5";
  return envValue(env, "LLM_PERSONA_MODEL") ?? "gpt-4o-mini";
}

/** The analyst agent's model: LLM_ANALYST_MODEL, or the persona model when
 * it is unset or blank. Recorded on every analyst event. */
export function analystModelName(env: NodeJS.ProcessEnv = process.env): string {
  if (activeProvider(env) === "mock") return "mock";
  return envValue(env, "LLM_ANALYST_MODEL") ?? personaModelName(env);
}

/** The analyst model a run actually uses and records: the run's own override
 * (set when the run was started, admin only), else the deployment's analyst
 * model. On the offline mock every role is served by the mock, so the
 * override is recorded beside it but never used. */
export function effectiveAnalystModel(
  override: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (activeProvider(env) === "mock") return "mock";
  return override?.trim() || analystModelName(env);
}

export function rubricModelName(env: NodeJS.ProcessEnv = process.env): string {
  const provider = activeProvider(env);
  if (provider === "mock") return "mock";
  if (provider === "anthropic") return envValue(env, "LLM_RUBRIC_MODEL") ?? "claude-opus-4-8";
  return envValue(env, "LLM_RUBRIC_MODEL") ?? "gpt-4o-mini";
}

/** The model id a provider response reports serving (AI SDK
 * response.modelId), or null when it reports none. */
export function servedModelId(result: { response?: { modelId?: string } } | null | undefined): string | null {
  const id = result?.response?.modelId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
