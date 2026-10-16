// A per-run analyst model. The deployment's analyst model is LLM_ANALYST_MODEL
// (lib/llm/model-names.ts), one setting for the whole server. An instructor
// can start a single run on another model through
// POST /api/admin/cohorts/<id>/agent-runs (the showcase regeneration runs A1
// on the persona model and A2 on a cheaper one). The choice is recorded on
// the run's analyst_run_started event as modelOverride, read back for every
// stage, and every analyst event of the run records the model it used.
// Pure.

import { PRICES } from "@/lib/llm/prices";

export const ANALYST_RUN_STARTED_EVENT = "analyst_run_started";

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,79}$/;

/** Why a requested analyst model is refused on this provider, or null when
 * it is allowed. Only a priced model is allowed, so the spend guard, the
 * spend readout and the paper-metrics pipeline can cost it. */
export function analystModelOverrideProblem(model: string, provider: string): string | null {
  if (!MODEL_ID.test(model)) return "The analyst model must be a model id such as claude-haiku-4-5.";
  if (!PRICES[model]) {
    return `No list price is recorded for ${model}; only priced models can run the analyst (${Object.keys(PRICES).join(", ")}).`;
  }
  const claude = model.startsWith("claude-");
  if (provider === "anthropic" && !claude) return `${model} is not an Anthropic model; the provider is anthropic.`;
  if (provider === "openai" && claude) return `${model} is an Anthropic model; the provider is openai.`;
  return null;
}

/** The analyst model override a run was started with, from its events, or
 * null when it runs on the deployment's analyst model. */
export function runAnalystModelOverride(
  events: readonly { type: string; detailJson: unknown }[],
): string | null {
  const started = events.find((e) => e.type === ANALYST_RUN_STARTED_EVENT);
  const override = (started?.detailJson as { modelOverride?: unknown } | null)?.modelOverride;
  return typeof override === "string" && override.trim() ? override.trim() : null;
}
