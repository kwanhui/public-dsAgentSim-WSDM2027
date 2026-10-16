// The score pipeline, run against an in-memory PGlite
// database with the real migrations, so the SQL is exercised as well as the
// logic:
//
// - a judge failure marks the submission failed and does not use up an
//   attempt; a pending row does not either;
// - an instructor rescore scores such a row and, on the current stage,
//   applies the gate as usual;
// - the effective score (override if present, otherwise judge) is what the
//   analytics means report.
//
// The daily spend query and the sandbox join count run against the same
// database here, since both are SQL over jsonb and timestamps.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RubricResult } from "@/lib/agents/rubric";

const scoreSubmission = vi.fn();
const generateText = vi.fn(async () => ({ text: "Thanks, received.", usage: { promptTokens: 3, completionTokens: 2 } }));

vi.mock("@/lib/db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("@/lib/db/schema");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "lib/db/migrations" });
  return { db };
});
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateText(...(a as [])) }));
vi.mock("@/lib/agents/rubric", () => ({
  scoreSubmission: (...a: unknown[]) => scoreSubmission(...a),
}));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: "persona-stub", rubricModel: "rubric-stub" }),
  samplingParams: () => ({}),
  personaModelName: () => "claude-sonnet-5",
  rubricModelName: () => "claude-opus-4-8",
}));

const { db } = await import("@/lib/db/client");
const schema = await import("@/lib/db/schema");
const { eq } = await import("drizzle-orm");
const { handleGateSubmission, countScoredAttempts } = await import("@/lib/agents/stage-gate");
const { rescoreSubmission } = await import("@/lib/agents/rescore");
const { createEngagement, getEngagement, getEvents, logEvent, appendMessage, countLearnerMessages } =
  await import("@/lib/engagement/state");
const { criterionMeans } = await import("@/lib/analytics/queries");
const { fetchTokenTotalsSince } = await import("@/lib/llm/budget");
const { countSandboxJoinsToday, SANDBOX_PROFILE_KIND } = await import("@/lib/cohort/sandbox");
const { loadScenario } = await import("@/lib/scenarios/load");
const { DEFAULT_COHORT_CONFIG } = await import("@/lib/cohort/defaults");

const scenario = await loadScenario("customer-churn");
const formulation = scenario.stages[0];
const config = { ...DEFAULT_COHORT_CONFIG, gates: { minScoreRatio: 0.6, maxRetries: 1 } };
const TEXT = "A problem statement long enough to pass the length check on the route. ".repeat(2);

function judged(score: number): RubricResult {
  return {
    scores: formulation.gate.rubric.map((c) => ({
      criterionId: c.id,
      score: Math.min(score, c.maxScore),
      maxScore: c.maxScore,
      rationale: "stub",
    })),
    judgeModel: "claude-opus-4-8",
    servedModel: "claude-opus-4-8-20260801",
    promptVersion: "rubric-v2",
    promptTokens: 1000,
    completionTokens: 100,
  };
}

let seq = 0;
async function freshEngagement() {
  seq++;
  const cohortId = `cohort-${seq}`;
  await db.insert(schema.cohorts).values({
    id: cohortId,
    slug: `c-${seq}`,
    name: "Test",
    instructorId: "admin",
    configJson: config,
  });
  const [student] = await db
    .insert(schema.students)
    .values({ cohortId, learnerHash: `hash-${seq}` })
    .returning();
  return createEngagement(cohortId, student.id, scenario);
}

async function submissionRows(engagementId: string) {
  return db.select().from(schema.submissions).where(eq(schema.submissions.engagementId, engagementId));
}

beforeAll(async () => {
  await db.insert(schema.users).values({ id: "admin", email: "admin", role: "instructor" });
});

beforeEach(() => {
  scoreSubmission.mockReset();
  generateText.mockClear();
});

describe("judge failure", () => {
  it("marks the submission failed, logs it, and rethrows", async () => {
    const engagement = await freshEngagement();
    scoreSubmission.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      handleGateSubmission({ engagement, scenario, config, text: TEXT }),
    ).rejects.toThrow("provider down");

    const [row] = await submissionRows(engagement.id);
    expect(row.status).toBe("failed");
    const types = (await getEvents(engagement.id)).map((e) => e.type);
    expect(types).toContain("submission_scoring_failed");
  });

  it("does not use up an attempt: the next scored submission is attempt 1", async () => {
    const engagement = await freshEngagement();
    scoreSubmission.mockRejectedValueOnce(new Error("provider down"));
    await handleGateSubmission({ engagement, scenario, config, text: TEXT }).catch(() => {});
    scoreSubmission.mockRejectedValueOnce(new Error("provider down"));
    await handleGateSubmission({ engagement, scenario, config, text: TEXT }).catch(() => {});

    scoreSubmission.mockResolvedValueOnce(judged(0));
    const outcome = await handleGateSubmission({ engagement, scenario, config, text: TEXT });
    expect(outcome.attempt).toBe(1);
    // maxRetries 1: a low first attempt does not advance.
    expect(outcome.advanced).toBe(false);
    expect(await countScoredAttempts(engagement.id, "formulation")).toBe(1);
  });

  it("ignores a row left pending", async () => {
    const engagement = await freshEngagement();
    await db.insert(schema.submissions).values({
      engagementId: engagement.id,
      stage: "formulation",
      kind: formulation.gate.kind,
      contentText: TEXT,
    });
    expect(await countScoredAttempts(engagement.id, "formulation")).toBe(0);
  });
});

describe("rescore", () => {
  it("scores a failed submission, records the served model, and applies the gate on the current stage", async () => {
    const engagement = await freshEngagement();
    scoreSubmission.mockRejectedValueOnce(new Error("provider down"));
    await handleGateSubmission({ engagement, scenario, config, text: TEXT }).catch(() => {});
    const [failed] = await submissionRows(engagement.id);

    scoreSubmission.mockResolvedValueOnce(judged(10));
    const result = await rescoreSubmission(failed.id, config);
    expect(result).toEqual({ status: "scored", advanced: true });

    const [row] = await submissionRows(engagement.id);
    expect(row.status).toBe("scored");
    const scores = await db
      .select()
      .from(schema.rubricScores)
      .where(eq(schema.rubricScores.submissionId, failed.id));
    expect(scores.length).toBe(formulation.gate.rubric.length);
    expect(scores[0].servedModel).toBe("claude-opus-4-8-20260801");
    expect((await getEngagement(engagement.id))?.currentStage).toBe("data-collection");

    const events = await getEvents(engagement.id);
    const scored = events.find((e) => e.type === "submission_scored");
    expect(scored?.detailJson).toMatchObject({ attempt: 1, rescored: true, advanced: true });
    expect(events.map((e) => e.type)).toContain("submission_rescored");
  });

  it("stores scores without moving the stage once the engagement has moved on", async () => {
    const engagement = await freshEngagement();
    scoreSubmission.mockRejectedValueOnce(new Error("provider down"));
    await handleGateSubmission({ engagement, scenario, config, text: TEXT }).catch(() => {});
    scoreSubmission.mockResolvedValueOnce(judged(10));
    await handleGateSubmission({ engagement, scenario, config, text: TEXT });
    const failed = (await submissionRows(engagement.id)).find((s) => s.status === "failed")!;

    scoreSubmission.mockResolvedValueOnce(judged(0));
    expect(await rescoreSubmission(failed.id, config)).toEqual({ status: "scored", advanced: false });
    expect((await getEngagement(engagement.id))?.currentStage).toBe("data-collection");
  });

  it("leaves a scored submission alone", async () => {
    const engagement = await freshEngagement();
    scoreSubmission.mockResolvedValueOnce(judged(10));
    await handleGateSubmission({ engagement, scenario, config, text: TEXT });
    const [row] = await submissionRows(engagement.id);
    expect(await rescoreSubmission(row.id, config)).toEqual({ status: "already-scored" });
    expect(scoreSubmission).toHaveBeenCalledTimes(1);
  });

  it("keeps the row failed when the judge fails again", async () => {
    const engagement = await freshEngagement();
    scoreSubmission.mockRejectedValue(new Error("still down"));
    await handleGateSubmission({ engagement, scenario, config, text: TEXT }).catch(() => {});
    const [row] = await submissionRows(engagement.id);
    expect(await rescoreSubmission(row.id, config)).toEqual({ status: "judge-failed" });
    expect((await submissionRows(engagement.id))[0].status).toBe("failed");
  });
});

describe("effective score in analytics", () => {
  it("uses the override where there is one", async () => {
    const engagement = await freshEngagement();
    scoreSubmission.mockResolvedValueOnce(judged(4));
    await handleGateSubmission({ engagement, scenario, config, text: TEXT });
    const [first] = await db
      .select()
      .from(schema.rubricScores)
      .where(eq(schema.rubricScores.engagementId, engagement.id));
    await db
      .update(schema.rubricScores)
      .set({ overrideScore: 1 })
      .where(eq(schema.rubricScores.id, first.id));

    const means = await criterionMeans(engagement.cohortId);
    const overridden = means.find((m) => m.criterionId === first.criterionId);
    expect(overridden).toMatchObject({ meanScore: 1, n: 1 });
    const other = means.find((m) => m.criterionId !== first.criterionId);
    expect(other?.meanScore).toBe(Math.min(4, other!.maxScore));
  });
});

describe("metered-token queries", () => {
  it("sum today's persona and judge tokens from messages and events", async () => {
    const engagement = await freshEngagement();
    const since = new Date(Date.now() - 60_000);
    const before = await fetchTokenTotalsSince(since);
    const [channel] = await db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.engagementId, engagement.id));
    await appendMessage({
      channelId: channel.id,
      engagementId: engagement.id,
      sender: "client",
      content: "reply",
      promptTokens: 100,
      completionTokens: 10,
    });
    await logEvent(engagement.id, engagement.cohortId, "analyst_step", { promptTokens: 50, completionTokens: 5 });
    await logEvent(engagement.id, engagement.cohortId, "persona_consistency", {
      promptTokens: 20,
      completionTokens: 2,
    });
    await logEvent(engagement.id, engagement.cohortId, "submission_scored", {
      judgePromptTokens: 300,
      judgeCompletionTokens: 30,
    });
    // A non-numeric field must not break the sum.
    await logEvent(engagement.id, engagement.cohortId, "analyst_step", { promptTokens: "n/a" });

    const after = await fetchTokenTotalsSince(since);
    expect(after.persona.prompt - before.persona.prompt).toBe(150);
    expect(after.persona.completion - before.persona.completion).toBe(15);
    expect(after.judge.prompt - before.judge.prompt).toBe(320);
    expect(after.judge.completion - before.judge.completion).toBe(32);
  });

  it("count learner messages per engagement", async () => {
    const engagement = await freshEngagement();
    const [channel] = await db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.engagementId, engagement.id));
    for (const sender of ["learner", "client", "learner"]) {
      await appendMessage({ channelId: channel.id, engagementId: engagement.id, sender, content: "x" });
    }
    expect(await countLearnerMessages(engagement.id)).toBe(2);
  });

  it("count today's sandbox joins only", async () => {
    const engagement = await freshEngagement();
    await db.insert(schema.students).values([
      { cohortId: engagement.cohortId, learnerHash: `sb-${seq}-1`, profileJson: { kind: SANDBOX_PROFILE_KIND } },
      { cohortId: engagement.cohortId, learnerHash: `sb-${seq}-2`, profileJson: { kind: SANDBOX_PROFILE_KIND } },
      {
        cohortId: engagement.cohortId,
        learnerHash: `sb-${seq}-old`,
        profileJson: { kind: SANDBOX_PROFILE_KIND },
        createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
      },
    ]);
    expect(await countSandboxJoinsToday(engagement.cohortId)).toBe(2);
  });
});
