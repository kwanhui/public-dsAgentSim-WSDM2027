// Model list prices, USD per million tokens. This is the single dated source
// for every cost figure in the tool: the daily spend guard (lib/llm/budget.ts),
// the spend script (scripts/spend.ts) and the paper-metrics pipeline
// (scripts/paper-metrics, which reads this table through export-prices.ts). Dependency-free so all of
// them can import it.
//
// Sources: https://platform.claude.com/docs/en/about-claude/pricing, read
// 2026-09-30. Sonnet 5 introductory 2/10 made standard; the scheduled 3/15
// increase did not occur. gpt-4o-mini (the OpenAI default in
// lib/llm/model-names.ts): https://developers.openai.com/api/docs/pricing
// (platform.openai.com/docs/pricing redirects there), standard tier, read
// 2026-09-30: 0.15 input, 0.60 output. claude-haiku-4-5 (a cheaper analyst
// model for the second showcase agent run): list price USD 1 input and 5
// output per million tokens, from the same Anthropic pricing page, read
// 2026-09-30.

export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

// The offline mock is priced as the default persona model. It costs nothing,
// but pricing it lets the spend guard be exercised without a paid key.
const MOCK_PRICED_AS = "claude-sonnet-5";

/** The offline mock under either of its names: "mock" as configured, and
 * "mock-model-id", the id the AI SDK mock reports as the served model. */
export function isMockModel(model: string): boolean {
  return model === "mock" || model === "mock-model-id";
}

/** Strict lookup for cost estimates: an unpriced model is an error. */
export function priceFor(model: string): { input: number; output: number } {
  const p = PRICES[model];
  if (!p) throw new Error(`No list price recorded for model ${model}; add it to lib/llm/prices.ts.`);
  return p;
}

/**
 * Lenient lookup for the spend guard, which must never fail open on a model
 * it does not know: the mock is priced as the default persona model, and an
 * unknown model as the most expensive model listed.
 */
export function guardPriceFor(model: string): { input: number; output: number } {
  if (PRICES[model]) return PRICES[model];
  if (isMockModel(model)) return PRICES[MOCK_PRICED_AS];
  return Object.values(PRICES).reduce((a, b) => (a.output >= b.output ? a : b));
}

/**
 * Lookup for the instructor's spend readout, which prices each run by the
 * model that served it: the offline mock costs nothing, a dated model id a
 * provider reports ("claude-sonnet-5-20260901") is priced as its base id, and
 * anything else falls back to the guard's rule.
 */
export function readoutPriceFor(model: string): { input: number; output: number } {
  if (isMockModel(model)) return { input: 0, output: 0 };
  if (PRICES[model]) return PRICES[model];
  const base = Object.keys(PRICES)
    .filter((id) => model.startsWith(`${id}-`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? PRICES[base] : guardPriceFor(model);
}

export function tokenCostUsd(
  price: { input: number; output: number },
  promptTokens: number,
  completionTokens: number,
): number {
  return (promptTokens / 1e6) * price.input + (completionTokens / 1e6) * price.output;
}
