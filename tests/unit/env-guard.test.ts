import { describe, expect, it } from "vitest";
import { assertStartupEnv, demoModeActive, demoModeRefusal } from "@/lib/env-guard";
import { matchCredentials } from "@/lib/auth/credentials";

const base: NodeJS.ProcessEnv = { NODE_ENV: "test" };
const neverMatches = async () => false;

describe("DEMO_MODE", () => {
  const mock = { ...base, DEMO_MODE: "1", LLM_PROVIDER: "mock" };

  it("is allowed off Vercel with the mock provider", () => {
    expect(demoModeRefusal(mock)).toBeNull();
    expect(demoModeActive(mock)).toBe(true);
    expect(() => assertStartupEnv(mock)).not.toThrow();
  });

  it("is refused beside a paid provider unless ALLOW_DEMO_MODE_WITH_KEY=1", () => {
    const paid = { ...base, DEMO_MODE: "1", LLM_PROVIDER: "anthropic" };
    expect(demoModeRefusal(paid)).toMatch(/runs only with LLM_PROVIDER=mock/);
    expect(demoModeRefusal({ ...base, DEMO_MODE: "1" })).toMatch(/LLM_PROVIDER=anthropic/);
    expect(() => assertStartupEnv(paid)).toThrow(/ALLOW_DEMO_MODE_WITH_KEY=1/);
    expect(demoModeActive({ ...paid, ALLOW_DEMO_MODE_WITH_KEY: "1" })).toBe(true);
    expect(demoModeActive({ ...paid, ALLOW_DEMO_MODE_WITH_KEY: "1", VERCEL: "1" })).toBe(false);
  });

  it("is refused with a clear startup error when VERCEL is set", () => {
    const env = { ...base, DEMO_MODE: "1", VERCEL: "1" };
    expect(demoModeRefusal(env)).toMatch(/DEMO_MODE=1 is set on a Vercel deployment/);
    expect(demoModeActive(env)).toBe(false);
    expect(() => assertStartupEnv(env)).toThrow(/Remove DEMO_MODE/);
  });

  it("does nothing on Vercel without DEMO_MODE", () => {
    expect(() => assertStartupEnv({ ...base, VERCEL: "1" })).not.toThrow();
  });

  it("never accepts the fixed demo passwords on Vercel", async () => {
    const local = { ...base, DEMO_MODE: "1", LLM_PROVIDER: "mock" };
    expect(await matchCredentials("admin", "demo", neverMatches, local)).toMatchObject({ role: "instructor" });
    expect(await matchCredentials("admin", "demo", neverMatches, { ...local, VERCEL: "1" })).toBeNull();
    expect(await matchCredentials("reviewer", "reviewer", neverMatches, { ...local, VERCEL: "1" })).toBeNull();
  });
});

describe("LLM_DAILY_BUDGET_USD at startup", () => {
  it("stops startup with a clear message when it is not a number", () => {
    expect(() => assertStartupEnv({ ...base, LLM_DAILY_BUDGET_USD: "5 USD" })).toThrow(/not a number of US dollars/);
    expect(() => assertStartupEnv({ ...base, LLM_DAILY_BUDGET_USD: "-1" })).toThrow(/LLM_DAILY_BUDGET_USD/);
  });

  it("accepts a number or no value", () => {
    expect(() => assertStartupEnv({ ...base, LLM_DAILY_BUDGET_USD: "5" })).not.toThrow();
    expect(() => assertStartupEnv({ ...base, LLM_DAILY_BUDGET_USD: "" })).not.toThrow();
    expect(() => assertStartupEnv(base)).not.toThrow();
  });
});
