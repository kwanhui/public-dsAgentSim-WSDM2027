// The instructor's spend readout and the compare view's wall clock on the
// committed showcase must match the paper's basis: USD over all
// metered calls with each call priced at the model that served it, and
// agent time as the sum of successful stage attempts (A1 about 6.4 min).

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("@/lib/db/schema");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "lib/db/migrations" });
  return { db };
});

const { db } = await import("@/lib/db/client");
const { parseSnapshot, restoreCohort } = await import("@/scripts/showcase-snapshot");
const { spendReadout } = await import("@/lib/llm/budget");
const { loadSide, rowsForCohort } = await import("@/app/admin/compare/side-data");

const snapshot = parseSnapshot(readFileSync("demo/showcase-snapshot.json", "utf8"));
const config = snapshot.tables.cohorts[0].configJson as { showcase: { labels: Record<string, string> } };
const idOf = (label: string) => Object.entries(config.showcase.labels).find(([, l]) => l === label)![0];

describe("showcase readouts", () => {
  it("prices every metered call at its own model", async () => {
    await restoreCohort(db as never, snapshot);
    const spend = await spendReadout({ cohortId: snapshot.tables.cohorts[0].id as string });
    const usd = (label: string) => spend.byEngagement.get(idOf(label)) ?? NaN;
    expect(usd("H1")).toBeCloseTo(1.3343, 4);
    expect(usd("A1")).toBeCloseTo(1.6371, 4);
    expect(usd("A2")).toBeCloseTo(2.0228, 4);
    expect(usd("exhibit")).toBeCloseTo(0.5446, 4);
  }, 30_000);

  it("reports A1 and A2 active time from successful attempts, and labels H1 a scripted replay", async () => {
    const cohortRow = snapshot.tables.cohorts[0];
    const cohortById = new Map([
      [cohortRow.id as string, { id: cohortRow.id as string, name: "Showcase", configJson: cohortRow.configJson, archivedAt: null }],
    ]);
    const rows = await rowsForCohort(cohortRow.id as string);
    const side = async (label: string) => loadSide(rows.find((r) => r.engagement.id === idOf(label))!, cohortById);
    const a1 = await side("A1");
    expect(a1.totals.durationMs).toBe(385_302);
    // The 2026-10-07 regeneration (second attempt) ran without an interruption.
    expect(a1.totals.interruptedAttempts).toBe(0);
    expect(a1.kind).toBe("agent");
    const a2 = await side("A2");
    expect(Math.round((a2.totals.durationMs ?? 0) / 100) / 10).toBe(496.4);
    const h1 = await side("H1");
    expect(h1.kind).toBe("scripted");
    const exhibit = await side("exhibit");
    expect(exhibit.kind).toBe("scripted");
  }, 30_000);
});
