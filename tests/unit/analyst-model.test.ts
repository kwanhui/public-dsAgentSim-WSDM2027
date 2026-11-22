// The analyst agent's own model setting: LLM_ANALYST_MODEL, falling back to
// the persona model, and "mock" under the mock provider.

import { describe, expect, it } from "vitest";
import { analystModelName, personaModelName } from "@/lib/llm/model-names";
import { profileCsv, releaseWorldFact, renderReleasedProfiles } from "@/lib/agents/dataset-profile";

describe("analystModelName", () => {
  it("defaults to the persona model", () => {
    const env = { LLM_PROVIDER: "anthropic" } as unknown as NodeJS.ProcessEnv;
    expect(analystModelName(env)).toBe(personaModelName(env));
    expect(analystModelName({ ...env, LLM_ANALYST_MODEL: "  " })).toBe(personaModelName(env));
  });

  it("takes LLM_ANALYST_MODEL when set", () => {
    expect(analystModelName({ LLM_PROVIDER: "openai", LLM_ANALYST_MODEL: "gpt-x" } as unknown as NodeJS.ProcessEnv)).toBe("gpt-x");
  });

  it("is mock under the mock provider", () => {
    expect(analystModelName({ LLM_PROVIDER: "mock", LLM_ANALYST_MODEL: "x" } as unknown as NodeJS.ProcessEnv)).toBe("mock");
  });
});

describe("one file profile for the judge and the agent", () => {
  it("gives the analyst the same text the ledger holds for the judge", () => {
    const p = profileCsv("t.csv", ["id,kind,n", "a,x,1", "b,x,3", "c,y,"].join("\n"));
    const dataset = { file: "t.csv", description: "a test file", notes: "n counts visits." };
    expect(renderReleasedProfiles([p], [dataset])).toBe(`- ${releaseWorldFact(p, dataset)}`);
    expect(releaseWorldFact(p, dataset)).toContain("n numeric, min 1, max 3, mean 2");
  });
});
