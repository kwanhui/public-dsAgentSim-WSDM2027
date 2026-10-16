import { describe, expect, it } from "vitest";
import { configChecks, deploymentVersion, healthReport, keyPresent, requiredChecks } from "@/lib/health";

// The health endpoint is the first thing a reviewer touches, and it is public,
// so two properties matter: it must be honest about what is missing, and it
// must never carry a secret.

// NODE_ENV is required on ProcessEnv, so every fixture starts from this
// rather than from a bare object literal.
const base: NodeJS.ProcessEnv = { NODE_ENV: "test" };

describe("keyPresent", () => {
  it("checks the Anthropic key for the anthropic provider", () => {
    expect(keyPresent("anthropic", { ...base, ANTHROPIC_API_KEY: "sk-ant-xxx" })).toBe(true);
    expect(keyPresent("anthropic", base)).toBe(false);
  });

  it("does not accept an OpenAI key in place of an Anthropic one", () => {
    expect(keyPresent("anthropic", { ...base, OPENAI_API_KEY: "sk-xxx" })).toBe(false);
    expect(keyPresent("openai", { ...base, OPENAI_API_KEY: "sk-xxx" })).toBe(true);
  });

  it("treats a blank key as missing", () => {
    expect(keyPresent("anthropic", { ...base, ANTHROPIC_API_KEY: "   " })).toBe(false);
  });

  it("reports the mock provider as keyed, since the demo needs no key", () => {
    expect(keyPresent("mock", base)).toBe(true);
  });

  it("reports an unrecognised provider as unkeyed", () => {
    expect(keyPresent("llama", { ...base, ANTHROPIC_API_KEY: "sk-ant-xxx" })).toBe(false);
  });
});

describe("deploymentVersion", () => {
  it("uses the short git SHA on Vercel", () => {
    expect(deploymentVersion("0.1.0", { ...base, VERCEL_GIT_COMMIT_SHA: "abc1234def5678" })).toBe(
      "abc1234",
    );
  });

  it("falls back to the package version off Vercel", () => {
    expect(deploymentVersion("0.1.0", base)).toBe("0.1.0");
    expect(deploymentVersion("0.1.0", { ...base, VERCEL_GIT_COMMIT_SHA: "" })).toBe("0.1.0");
  });
});

describe("healthReport", () => {
  const healthy: NodeJS.ProcessEnv = {
    ...base,
    LLM_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant-xxx",
    VERCEL_GIT_COMMIT_SHA: "0123456789",
    ADMIN_PASSWORD_HASH: "$2b$12$adminhash",
    AUTH_SECRET: "auth-secret-value",
    PSEUDONYM_SALT: "salt-value-0123456789abcdef0123456789",
    CRON_SECRET: "cron-secret-value",
    LLM_DAILY_BUDGET_USD: "5",
  };

  it("returns 200 with every field true when the deployment is ready", () => {
    const report = healthReport({ dbOk: true, packageVersion: "0.1.0", env: healthy });
    expect(report.status).toBe(200);
    expect(report.body).toEqual({
      ok: true,
      db: true,
      provider: "anthropic",
      keyPresent: true,
      adminHashSet: true,
      reviewerHashSet: false,
      authSecretSet: true,
      pseudonymSaltSet: true,
      cronSecretSet: true,
      demoMode: false,
      budgetSet: true,
      todaySpendRatio: null,
      lastPurgeAt: null,
      version: "0123456",
      warnings: [],
    });
  });

  it("returns 503 and names the database when it is unreachable", () => {
    const report = healthReport({ dbOk: false, packageVersion: "0.1.0", env: healthy });
    expect(report.status).toBe(503);
    expect(report.body.ok).toBe(false);
    expect(report.body.db).toBe(false);
    expect(report.body.keyPresent).toBe(true);
  });

  it("returns 503 and names the key when the provider has none", () => {
    const report = healthReport({
      dbOk: true,
      packageVersion: "0.1.0",
      env: { ...healthy, ANTHROPIC_API_KEY: "" },
    });
    expect(report.status).toBe(503);
    expect(report.body).toMatchObject({ ok: false, db: true, keyPresent: false });
  });

  it("defaults to the anthropic provider, matching getLLM", () => {
    const report = healthReport({
      dbOk: true,
      packageVersion: "0.1.0",
      env: { ...healthy, LLM_PROVIDER: undefined },
    });
    expect(report.body.provider).toBe("anthropic");
    expect(report.status).toBe(200);
  });

  it("carries no key material in the body", () => {
    const report = healthReport({ dbOk: true, packageVersion: "0.1.0", env: healthy });
    const json = JSON.stringify(report.body);
    for (const secret of ["sk-ant-xxx", "adminhash", "auth-secret-value", "salt-value", "cron-secret-value"]) {
      expect(json).not.toContain(secret);
    }
    expect(Object.keys(report.body).sort()).toEqual([
      "adminHashSet",
      "authSecretSet",
      "budgetSet",
      "cronSecretSet",
      "db",
      "demoMode",
      "keyPresent",
      "lastPurgeAt",
      "ok",
      "provider",
      "pseudonymSaltSet",
      "reviewerHashSet",
      "todaySpendRatio",
      "version",
      "warnings",
    ]);
  });

  it.each(["ADMIN_PASSWORD_HASH", "AUTH_SECRET", "PSEUDONYM_SALT", "CRON_SECRET"])(
    "returns 503 when %s is missing on a deployment",
    (name) => {
      const report = healthReport({
        dbOk: true,
        packageVersion: "0.1.0",
        env: { ...healthy, [name]: "" },
      });
      expect(report.status).toBe(503);
      expect(report.body.ok).toBe(false);
    },
  );

  it("treats the .env.example salt placeholder as unset", () => {
    expect(configChecks({ ...base, PSEUDONYM_SALT: "CHANGE_ME" }).pseudonymSaltSet).toBe(false);
  });

  it("does not require the reviewer hash", () => {
    const report = healthReport({ dbOk: true, packageVersion: "0.1.0", env: healthy });
    expect(report.body.reviewerHashSet).toBe(false);
    expect(report.status).toBe(200);
  });

  it("requires only the database under DEMO_MODE", () => {
    const demo = { ...base, DEMO_MODE: "1", LLM_PROVIDER: "mock" };
    expect(requiredChecks(demo)).toEqual(["db"]);
    expect(healthReport({ dbOk: true, packageVersion: "0.1.0", env: demo }).status).toBe(200);
    expect(healthReport({ dbOk: false, packageVersion: "0.1.0", env: demo }).status).toBe(503);
  });

  it("reports the last purge time", () => {
    const report = healthReport({
      dbOk: true,
      packageVersion: "0.1.0",
      env: healthy,
      lastPurgeAt: new Date("2026-09-29T03:00:00Z"),
    });
    expect(report.body.lastPurgeAt).toBe("2026-09-29T03:00:00.000Z");
  });
});

describe("demo mode and spend fields", () => {
  it("reports demoMode and stays healthy locally with only the database", () => {
    const r = healthReport({ dbOk: true, packageVersion: "0.1.0", env: { ...base, DEMO_MODE: "1", LLM_PROVIDER: "mock" } });
    expect(r.body.demoMode).toBe(true);
    expect(r.body.ok).toBe(true);
  });

  it("refuses DEMO_MODE on Vercel: unhealthy, and the full checks apply", () => {
    const env = { ...base, DEMO_MODE: "1", VERCEL: "1" };
    expect(requiredChecks(env)).toContain("adminHashSet");
    const r = healthReport({ dbOk: true, packageVersion: "0.1.0", env });
    expect(r.body.demoMode).toBe(true);
    expect(r.body.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  it("reports whether a daily budget is set and passes the spend ratio through", () => {
    expect(healthReport({ dbOk: true, packageVersion: "0.1.0", env: base }).body).toMatchObject({
      budgetSet: false,
      todaySpendRatio: null,
    });
    const withBudget = healthReport({
      dbOk: true,
      packageVersion: "0.1.0",
      todaySpendRatio: 0.42,
      env: { ...base, LLM_DAILY_BUDGET_USD: "5" },
    });
    expect(withBudget.body).toMatchObject({ budgetSet: true, todaySpendRatio: 0.42 });
  });
});

describe("salt rule and warnings", () => {
  const ready = {
    ...base,
    LLM_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "k",
    ADMIN_PASSWORD_HASH: "h",
    AUTH_SECRET: "a",
    CRON_SECRET: "c",
    PSEUDONYM_SALT: "0123456789abcdef0123456789abcdef",
  };

  it("treats the .env.example placeholder and a short salt as unset", () => {
    expect(configChecks({ ...ready, PSEUDONYM_SALT: "replace-with-32-bytes-of-randomness" }).pseudonymSaltSet).toBe(false);
    expect(configChecks({ ...ready, PSEUDONYM_SALT: "short-salt" }).pseudonymSaltSet).toBe(false);
    expect(configChecks(ready).pseudonymSaltSet).toBe(true);
    expect(healthReport({ dbOk: true, packageVersion: "0", env: { ...ready, PSEUDONYM_SALT: "short-salt" } }).status).toBe(503);
  });

  it("warns when a paid provider has no daily budget, and not on the mock", () => {
    expect(healthReport({ dbOk: true, packageVersion: "0", env: ready }).body.warnings).toEqual([
      expect.stringMatching(/No LLM_DAILY_BUDGET_USD is set on a paid provider/),
    ]);
    expect(healthReport({ dbOk: true, packageVersion: "0", env: { ...ready, LLM_DAILY_BUDGET_USD: "5" } }).body.warnings).toEqual([]);
    expect(healthReport({ dbOk: true, packageVersion: "0", env: { ...base, LLM_PROVIDER: "mock" } }).body.warnings).toEqual([]);
  });
});
