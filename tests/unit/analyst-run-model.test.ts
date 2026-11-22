// A per-run analyst model: POST /api/admin/cohorts/<id>/agent-runs starts an
// agent run whose analyst runs on a model other than LLM_ANALYST_MODEL
// (instructor only, priced models only, matched to the provider), and every
// stage of that run calls and records that model.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let session: unknown = null;
const generateObject = vi.fn();
const handleGateSubmission = vi.fn(async (..._args: unknown[]) => ({ advanced: true, engagementCompleted: false }));

vi.mock("@/lib/auth/config", () => ({ auth: async () => session }));
vi.mock("@/lib/db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("@/lib/db/schema");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "lib/db/migrations" });
  return { db };
});
vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({
    personaModel: "persona-stub",
    rubricModel: "rubric-stub",
    analystModel: "analyst-default-stub",
    analystModelFor: (id: string) => `analyst-stub:${id}`,
  }),
  DEFAULT_TEMPERATURE: 0.4,
  samplingParams: () => ({}),
}));
vi.mock("@/lib/agents/stage-gate", () => ({
  handleGateSubmission: (...args: unknown[]) => handleGateSubmission(...args),
}));

const { db } = await import("@/lib/db/client");
const schema = await import("@/lib/db/schema");
const { eq } = await import("drizzle-orm");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");
const { POST } = await import("@/app/api/admin/cohorts/[id]/agent-runs/route");
const { runAnalystStage } = await import("@/lib/agents/analyst");
const { analystModelOverrideProblem, runAnalystModelOverride } = await import("@/lib/agents/analyst-model");
const { effectiveAnalystModel } = await import("@/lib/llm/model-names");
const { PRICES } = await import("@/lib/llm/prices");

const INSTRUCTOR = { user: { id: "admin", role: "instructor" } };
const REVIEWER = { user: { id: "admin", role: "reviewer" } };

async function start(body: unknown, cohortId = "c1") {
  const res = await POST(
    new Request(`http://x/api/admin/cohorts/${cohortId}/agent-runs`, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: cohortId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function eventsOf(engagementId: string) {
  return db.select().from(schema.events).where(eq(schema.events.engagementId, engagementId)).orderBy(schema.events.id);
}

beforeAll(async () => {
  await db.insert(schema.users).values({ id: "admin", email: "admin", role: "instructor" });
  await db.insert(schema.cohorts).values({
    id: "c1",
    slug: "c1",
    name: "Showcase",
    instructorId: "admin",
    configJson: { ...DEFAULT_COHORT_CONFIG, scenarios: { allowed: ["customer-churn"] } },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  session = null;
});

describe("analyst model override rules", () => {
  it("allows only priced models, matched to the provider", () => {
    expect(PRICES["claude-haiku-4-5"]).toEqual({ input: 1, output: 5 });
    expect(analystModelOverrideProblem("claude-haiku-4-5", "anthropic")).toBeNull();
    expect(analystModelOverrideProblem("claude-sonnet-5", "anthropic")).toBeNull();
    expect(analystModelOverrideProblem("claude-haiku-4-5", "mock")).toBeNull();
    expect(analystModelOverrideProblem("gpt-4o-mini", "anthropic")).toMatch(/not an Anthropic model/);
    expect(analystModelOverrideProblem("claude-haiku-4-5", "openai")).toMatch(/is an Anthropic model/);
    expect(analystModelOverrideProblem("claude-unpriced-9", "anthropic")).toMatch(/No list price/);
    expect(analystModelOverrideProblem("Claude Haiku; drop", "anthropic")).toMatch(/model id/);
  });

  it("reads the override from the run's start event, and the mock serves every run", () => {
    expect(runAnalystModelOverride([])).toBeNull();
    expect(
      runAnalystModelOverride([{ type: "analyst_run_started", detailJson: { model: "x", modelOverride: "claude-haiku-4-5" } }]),
    ).toBe("claude-haiku-4-5");
    expect(runAnalystModelOverride([{ type: "analyst_run_started", detailJson: { model: "x" } }])).toBeNull();
    expect(effectiveAnalystModel("claude-haiku-4-5", { LLM_PROVIDER: "mock" } as unknown as NodeJS.ProcessEnv)).toBe("mock");
    expect(effectiveAnalystModel("claude-haiku-4-5", { LLM_PROVIDER: "anthropic" } as unknown as NodeJS.ProcessEnv)).toBe(
      "claude-haiku-4-5",
    );
    expect(effectiveAnalystModel(null, { LLM_PROVIDER: "anthropic" } as unknown as NodeJS.ProcessEnv)).toBe("claude-sonnet-5");
  });
});

describe("POST /api/admin/cohorts/<id>/agent-runs", () => {
  it("refuses a signed-out caller and the reviewer", async () => {
    session = null;
    expect((await start({ analystModel: "claude-haiku-4-5" })).status).toBe(401);
    session = REVIEWER;
    expect((await start({ analystModel: "claude-haiku-4-5" })).status).toBe(403);
  });

  it("refuses an unknown cohort, a scenario the cohort does not allow and a model the provider cannot run", async () => {
    session = INSTRUCTOR;
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    expect((await start({}, "nope")).status).toBe(404);
    expect((await start({ scenarioId: "demand-forecasting" })).body.error).toBe("scenario-not-allowed");
    expect((await start({ analystModel: "gpt-4o-mini" })).body.error).toBe("invalid-analyst-model");
    expect((await start({ analystModel: "claude-unpriced-9" })).status).toBe(400);
    expect((await start({ analystModel: 7 })).status).toBe(400);
  });

  it("starts a run on the requested analyst model, and every stage calls and records it", async () => {
    session = INSTRUCTOR;
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    const { status, body } = await start({ scenarioId: "customer-churn", analystModel: "claude-haiku-4-5" });
    expect(status).toBe(201);
    expect(body.analystModel).toBe("claude-haiku-4-5");
    const id = String(body.engagementId);

    const [eng] = await db.select().from(schema.engagements).where(eq(schema.engagements.id, id));
    expect(eng.mode).toBe("agent");
    const [student] = await db.select().from(schema.students).where(eq(schema.students.id, eng.studentId));
    expect((student.profileJson as { analystModel?: string }).analystModel).toBe("claude-haiku-4-5");
    const started = (await eventsOf(id)).find((e) => e.type === "analyst_run_started")!;
    expect(started.detailJson).toMatchObject({ model: "claude-haiku-4-5", modelOverride: "claude-haiku-4-5" });

    generateObject.mockReset().mockResolvedValue({
      object: { reasoning: "submit", action: "submit", channelPersonaId: null, text: "Problem statement ..." },
      usage: { promptTokens: 11, completionTokens: 7 },
    });
    await runAnalystStage(id, DEFAULT_COHORT_CONFIG);
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(generateObject.mock.calls[0][0]).toMatchObject({ model: "analyst-stub:claude-haiku-4-5" });
    const step = (await eventsOf(id)).find((e) => e.type === "analyst_step")!;
    expect(step.detailJson).toMatchObject({ model: "claude-haiku-4-5", modelOverride: "claude-haiku-4-5", promptTokens: 11 });
  });

  it("without analystModel, starts a run on the deployment's analyst model", async () => {
    session = INSTRUCTOR;
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    const { status, body } = await start({ scenarioId: "customer-churn" });
    expect(status).toBe(201);
    expect(body.analystModel).toBe("claude-sonnet-5");
    const id = String(body.engagementId);
    const started = (await eventsOf(id)).find((e) => e.type === "analyst_run_started")!;
    expect((started.detailJson as { modelOverride?: string }).modelOverride).toBeUndefined();
    generateObject.mockReset().mockResolvedValue({
      object: { reasoning: "submit", action: "submit", channelPersonaId: null, text: "Problem statement ..." },
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    await runAnalystStage(id, DEFAULT_COHORT_CONFIG);
    expect(generateObject.mock.calls[0][0]).toMatchObject({ model: "analyst-default-stub" });
    const step = (await eventsOf(id)).find((e) => e.type === "analyst_step")!;
    expect(step.detailJson).toMatchObject({ model: "claude-sonnet-5" });
  });

  it("on the mock provider, records the requested model beside the mock that serves it", async () => {
    session = INSTRUCTOR;
    vi.stubEnv("LLM_PROVIDER", "mock");
    const { status, body } = await start({ scenarioId: "customer-churn", analystModel: "claude-haiku-4-5" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ analystModel: "mock", modelOverride: "claude-haiku-4-5" });
  });
});
