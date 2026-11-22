// scripts/spend.ts totals the USD recorded in a database. It reads the token
// fields of the current schema (messages, and the detail_json of events),
// prices them from lib/llm/prices.ts, and can split the total by engagement or
// cohort. This seeds a throwaway in-memory PGlite database with the real
// migrations and checks the arithmetic, including usage on *_failed events and
// agreement with the daily spend guard's own side split.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import { PRICES } from "@/lib/llm/prices";
import {
  computeSpend,
  formatReport,
  sideTotals,
  usdFor,
  type Prices,
} from "@/scripts/spend";
import type { Source } from "@/scripts/paper-metrics/source";

vi.mock("@/lib/db/client", () => ({ db: {} }));

let client: PGlite;
let source: Source;

const usd = (pIn: number, pOut: number, jIn: number, jOut: number, prices: Prices = PRICES) =>
  (pIn * prices["claude-sonnet-5"].input +
    pOut * prices["claude-sonnet-5"].output +
    jIn * prices["claude-opus-4-8"].input +
    jOut * prices["claude-opus-4-8"].output) /
  1e6;

async function seed(): Promise<void> {
  const db = drizzle(client, { schema });
  await db.insert(schema.users).values({ id: "u1", email: "i@example.test", name: "I" });
  for (const [id, slug] of [
    ["cohort-a", "alpha"],
    ["cohort-b", "beta"],
  ] as const) {
    await db.insert(schema.cohorts).values({ id, slug, name: slug, instructorId: "u1", configJson: {} });
    await db.insert(schema.students).values({ id: `s-${id}`, cohortId: id, learnerHash: `h-${id}`, profileJson: {} });
    await db.insert(schema.engagements).values({
      id: `e-${id}`,
      cohortId: id,
      studentId: `s-${id}`,
      scenarioId: "customer-churn",
      currentStage: "formulation",
      mode: id === "cohort-a" ? "agent" : "human",
    });
    await db.insert(schema.channels).values({ id: `c-${id}`, engagementId: `e-${id}`, personaId: "client" });
  }
  const at = "2026-09-30T00:00:00.000Z";
  await db.insert(schema.messages).values([
    { channelId: "c-cohort-a", engagementId: "e-cohort-a", sender: "learner", content: "q", timestampIso: at },
    { channelId: "c-cohort-a", engagementId: "e-cohort-a", sender: "client", content: "a", promptTokens: 1000, completionTokens: 100, timestampIso: at },
    { channelId: "c-cohort-a", engagementId: "e-cohort-a", sender: "client", content: "reaction", promptTokens: 500, completionTokens: 50, timestampIso: at },
    { channelId: "c-cohort-b", engagementId: "e-cohort-b", sender: "client", content: "a", promptTokens: 2000, completionTokens: 200, timestampIso: at },
  ]);
  const ev = (engagementId: string, cohortId: string, type: string, detailJson: unknown) => ({
    engagementId,
    cohortId,
    type,
    detailJson,
    timestampIso: at,
  });
  await db.insert(schema.events).values([
    ev("e-cohort-a", "cohort-a", "analyst_step", { promptTokens: 300, completionTokens: 30, action: "message" }),
    ev("e-cohort-a", "cohort-a", "persona_consistency", { consistent: true, promptTokens: 400, completionTokens: 40 }),
    ev("e-cohort-a", "cohort-a", "submission_scored", { judgePromptTokens: 5000, judgeCompletionTokens: 500 }),
    // A failed call that still recorded usage is spend, and the script counts it.
    ev("e-cohort-a", "cohort-a", "analyst_stage_failed", { promptTokens: 60, completionTokens: 6 }),
    // No usage recorded: contributes nothing.
    ev("e-cohort-a", "cohort-a", "client_reaction", { outcome: "passed" }),
    ev("e-cohort-b", "cohort-b", "submission_scored", { judgePromptTokens: 1000, judgeCompletionTokens: 100 }),
    // A non-numeric field is ignored, as in the guard.
    ev("e-cohort-b", "cohort-b", "analyst_step", { promptTokens: "n/a", completionTokens: null }),
  ]);
}

beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder: "lib/db/migrations" });
  source = {
    query: async (sql, params) => (await client.query<Record<string, unknown>>(sql, params)).rows,
    close: async () => {},
  };
  await seed();
}, 30_000);

afterAll(async () => {
  await client.close();
});

describe("computeSpend", () => {
  it("totals the whole database from messages and events, on both model sides", async () => {
    const report = await computeSpend(source);
    // Persona side: messages 1000+500+2000 in, 100+50+200 out; analyst_step
    // 300/30; analyst_stage_failed 60/6.
    // Judge side: persona_consistency 400/40; submission_scored 5000+1000 / 500+100.
    expect(report.totals.persona).toEqual({ prompt: 3860, completion: 386 });
    expect(report.totals.judge).toEqual({ prompt: 6400, completion: 640 });
    expect(report.totalUsd).toBeCloseTo(usd(3860, 386, 6400, 640), 9);
    expect(report.engagements).toHaveLength(2);
  });

  it("splits by engagement and by cohort", async () => {
    const report = await computeSpend(source);
    const a = report.engagements.find((e) => e.engagementId === "e-cohort-a")!;
    const b = report.engagements.find((e) => e.engagementId === "e-cohort-b")!;
    expect(a.mode).toBe("agent");
    expect(a.usd).toBeCloseTo(usd(1860, 186, 5400, 540), 9);
    expect(b.usd).toBeCloseTo(usd(2000, 200, 1000, 100), 9);
    expect(a.bySource.analyst_stage_failed).toMatchObject({ prompt: 60, completion: 6 });
    expect(a.bySource.messages).toMatchObject({ calls: 2, prompt: 1500, completion: 150 });

    const scoped = await computeSpend(source, { cohort: "beta" });
    expect(scoped.engagements.map((e) => e.engagementId)).toEqual(["e-cohort-b"]);
    expect(scoped.totalUsd).toBeCloseTo(b.usd, 9);
    const byId = await computeSpend(source, { cohort: "cohort-a" });
    expect(byId.totalUsd).toBeCloseTo(a.usd, 9);
  });

  it("prices from lib/llm/prices.ts, and an override changes only that model", async () => {
    const now = await computeSpend(source);
    const old = await computeSpend(source, { prices: { "claude-sonnet-5": { input: 3, output: 15 } } });
    // Only the persona side moves: 3860 in and 386 out at +1/+5 per million.
    expect(old.totalUsd - now.totalUsd).toBeCloseTo((3860 * 1 + 386 * 5) / 1e6, 9);
    expect(now.prices["claude-sonnet-5"]).toEqual(PRICES["claude-sonnet-5"]);
  });

  it("refuses a model with no recorded price", async () => {
    await expect(computeSpend(source, { personaModel: "some-new-model" })).rejects.toThrow(/prices\.ts/);
  });

  it("prints the total and the per-engagement rows", async () => {
    const text = formatReport(await computeSpend(source), "engagement");
    expect(text).toMatch(/Total: USD \d+\.\d{4}/);
    expect(text).toContain("e-cohort-a");
    expect(formatReport(await computeSpend(source), "cohort")).toMatch(/alpha\s+1\s/);
  });
});

describe("side split", () => {
  it("agrees with the daily spend guard's totalsFromRows", async () => {
    const { totalsFromRows } = await import("@/lib/llm/budget");
    const messageRow = { prompt: "100", completion: "50" };
    const rows = [
      { type: "analyst_step", prompt: 10, completion: 5, judgePrompt: 0, judgeCompletion: 0 },
      { type: "persona_consistency", prompt: 7, completion: 3, judgePrompt: 0, judgeCompletion: 0 },
      { type: "submission_scored", prompt: 0, completion: 0, judgePrompt: "20", judgeCompletion: "4" },
      { type: "analyst_stage_failed", prompt: "9", completion: "1", judgePrompt: null, judgeCompletion: null },
    ];
    // The script prices as the guard does, with the analyst on the persona
    // side; the readout's separate analyst subtotal is not part of it.
    const { persona, judge } = totalsFromRows(messageRow, rows);
    expect(sideTotals(messageRow, rows)).toEqual({ persona, judge });
  });

  it("prices each side by its own model", () => {
    const totals = { persona: { prompt: 1_000_000, completion: 0 }, judge: { prompt: 0, completion: 1_000_000 } };
    expect(usdFor(totals, "claude-sonnet-5", "claude-opus-4-8", PRICES)).toBeCloseTo(
      PRICES["claude-sonnet-5"].input + PRICES["claude-opus-4-8"].output,
      9,
    );
  });
});
