// `cp .env.example .env.local` used to leave the model
// overrides as empty strings, and every call then went out with an empty
// model id. A blank or whitespace-only value must count as unset.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "dotenv";
import { activeProvider, envValue, personaModelName, rubricModelName } from "@/lib/llm/model-names";
import { keyPresent } from "@/lib/health";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("blank LLM settings", () => {
  it("envValue trims and treats blank as unset", () => {
    expect(envValue(env({ A: "" }), "A")).toBeUndefined();
    expect(envValue(env({ A: "   " }), "A")).toBeUndefined();
    expect(envValue(env({}), "A")).toBeUndefined();
    expect(envValue(env({ A: " x " }), "A")).toBe("x");
  });

  it("falls back to the default models when the overrides are blank", () => {
    const blank = env({ LLM_PROVIDER: "anthropic", LLM_PERSONA_MODEL: "", LLM_RUBRIC_MODEL: " " });
    expect(personaModelName(blank)).toBe("claude-sonnet-5");
    expect(rubricModelName(blank)).toBe("claude-opus-4-8");
    const openai = env({ LLM_PROVIDER: "openai", LLM_PERSONA_MODEL: "", LLM_RUBRIC_MODEL: "" });
    expect(personaModelName(openai)).toBe("gpt-4o-mini");
    expect(rubricModelName(openai)).toBe("gpt-4o-mini");
  });

  it("treats a blank provider as the default provider", () => {
    expect(activeProvider(env({ LLM_PROVIDER: "" }))).toBe("anthropic");
    expect(activeProvider(env({ LLM_PROVIDER: " mock " }))).toBe("mock");
  });

  it("keeps a set override", () => {
    expect(personaModelName(env({ LLM_PERSONA_MODEL: " claude-x " }))).toBe("claude-x");
  });

  it(".env.example copied as is resolves to real model ids", () => {
    const parsed = parse(readFileSync(join(__dirname, "..", "..", ".env.example"), "utf8"));
    const copied = env(parsed);
    expect(personaModelName(copied)).toBe("claude-sonnet-5");
    expect(rubricModelName(copied)).toBe("claude-opus-4-8");
    expect(parsed.LLM_PERSONA_MODEL).toBeUndefined();
    expect(parsed.LLM_RUBRIC_MODEL).toBeUndefined();
    expect(keyPresent(activeProvider(copied), copied)).toBe(false);
  });
});
