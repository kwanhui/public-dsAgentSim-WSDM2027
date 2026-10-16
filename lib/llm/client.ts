import { createAnthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

// The deployed Claude models reject `temperature` (400 "`temperature` is
// deprecated for this model") and the AI SDK injects a temperature: 0 default
// into generateObject requests. This fetch removes temperature, top_p and
// top_k from every Anthropic request body before it is sent.
const anthropicFetch: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if ("temperature" in body || "top_p" in body || "top_k" in body) {
        delete body.temperature;
        delete body.top_p;
        delete body.top_k;
        init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // Non-JSON body: pass through untouched.
    }
  }
  return fetch(input, init);
};

const anthropic = createAnthropic({ fetch: anthropicFetch });

// Fallback sampling temperature. Persona replies read the per-cohort
// CohortConfig.llm.temperature; this constant covers paths with no cohort
// context (the public demo walkthrough) and the rubric judge, which should
// stay near-deterministic regardless of cohort settings.
export const DEFAULT_TEMPERATURE = 0.4;
export const RUBRIC_TEMPERATURE = 0.0;

// Current Claude models (Sonnet 5, Opus 4.7+) removed the `temperature`
// sampling parameter; sending it returns a 400 ("`temperature` is deprecated
// for this model"). Spread this helper into generateObject calls instead of
// passing `temperature` directly: it omits the parameter entirely on the
// anthropic provider and preserves it for providers that still accept it
// (openai; the mock ignores it either way).
export function samplingParams(temperature: number): { temperature?: number } {
  return providerAcceptsTemperature(activeProvider()) ? { temperature } : {};
}

// Whether a sampling temperature reaches the model on this provider. The
// anthropic path strips it (see above) and the mock ignores it, so only
// openai honours the per-cohort setting; the config page hides the field
// otherwise.
export function providerAcceptsTemperature(provider: string): boolean {
  return provider === "openai";
}

// Provider and model-id resolution lives in lib/llm/model-names.ts, which
// has no SDK imports, so code that only needs the names (the judge, the
// auditor, the spend guard) can import it without the provider clients.
import { activeProvider, analystModelName, personaModelName, rubricModelName } from "./model-names";
export { activeProvider, analystModelName, personaModelName, rubricModelName };

export interface LLMClients {
  // Persona conversations: client sponsor, data owner, end-users.
  personaModel: LanguageModel;
  // The analyst agent that plays the consultant (LLM_ANALYST_MODEL, by
  // default the persona model).
  analystModel: LanguageModel;
  // Rubric judge for stage-gate submissions. Defaults to a stronger model
  // than the personas because its scores feed assessment and the paper's
  // analysis.
  rubricModel: LanguageModel;
  // The analyst model for one run whose model was chosen when it started
  // (lib/agents/analyst-model.ts); on the mock, the mock.
  analystModelFor: (modelId: string) => LanguageModel;
}

let cached: LLMClients | null = null;

export function getLLM(): LLMClients {
  if (cached) return cached;
  // Resolved through lib/llm/model-names.ts, where a blank env value counts
  // as unset, so the ids sent here are the ids the admin UI and the spend
  // guard report.
  const provider = activeProvider();
  if (provider === "mock") {
    // Offline demo/testing provider; see lib/llm/mock.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMockModel } = require("./mock") as typeof import("./mock");
    const analystModel = createMockModel();
    cached = {
      personaModel: createMockModel(),
      analystModel,
      rubricModel: createMockModel(),
      analystModelFor: () => analystModel,
    };
  } else if (provider === "anthropic") {
    cached = {
      personaModel: anthropic(personaModelName()),
      analystModel: anthropic(analystModelName()),
      rubricModel: anthropic(rubricModelName()),
      analystModelFor: (modelId: string) => anthropic(modelId),
    };
  } else if (provider === "openai") {
    cached = {
      personaModel: openai(personaModelName()),
      analystModel: openai(analystModelName()),
      rubricModel: openai(rubricModelName()),
      analystModelFor: (modelId: string) => openai(modelId),
    };
  } else {
    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }
  return cached;
}
