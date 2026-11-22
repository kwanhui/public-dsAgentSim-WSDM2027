// Usage:
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
//   tsx scripts/replay/spend-report.ts --base-url <url> --cohort-id <uuid> [--budget <usd>] --out <spend.json>
//   DB_DRIVER=pglite PGLITE_DIR=<dir> tsx scripts/replay/spend-report.ts --offline [--out <spend.json>]
//
// Reports what a regeneration (or a probe run) spent, with the computations
// of lib/llm/budget.ts, so the figure is the one the spend guard and the
// instructor's readout use:
//
//   online   (server still running) the instructor's readout per engagement
//            (spendReadout, through the cohort's engagements export: each run
//            priced by the models its events record, the mock at 0), and the
//            guard's share of LLM_DAILY_BUDGET_USD spent today from
//            /api/health (todaySpendRatio, rounded to 1%).
//   offline  (server stopped, PGlite directory closed) the guard's own figure
//            over everything in the database: fetchTokenTotalsSince(epoch)
//            priced with spendUsd at the configured persona and judge models.
//            The guard prices analyst tokens as the persona model, and the
//            mock as the persona model, so it is an upper bound for a run
//            whose analyst is cheaper than the personas.
//
// Both print a summary line and merge their part into --out.
import { existsSync, readFileSync } from "node:fs";

import { StepLog, flag, signInAdmin, writeJson } from "./common";
import { parseCsv } from "./csv";

type Json = Record<string, unknown>;

function merge(out: string | undefined, part: Json): void {
  if (!out) return;
  const prev = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Json) : {};
  writeJson(out, { ...prev, ...part });
}

async function online(argv: string[]) {
  const base = flag(argv, "base-url") ?? "";
  const cohortId = flag(argv, "cohort-id") ?? "";
  if (!base || !cohortId) throw new Error("online mode needs --base-url and --cohort-id");
  const budget = flag(argv, "budget") ? Number(flag(argv, "budget")) : null;
  const log = new StepLog("spend", flag(argv, "log"));
  const admin = await signInAdmin(base, log);
  try {
    const res = await admin.context.request.get(`/api/admin/cohorts/${cohortId}/export?what=engagements`);
    if (!res.ok()) throw new Error(`engagements export failed: HTTP ${res.status()}`);
    const rows = parseCsv(await res.text());
    const byEngagement = rows.map((r) => ({
      engagementId: r.engagement_id,
      mode: r.mode,
      scenarioId: r.scenario_id,
      usd: Number(r.usd || 0),
    }));
    const readoutTotal = byEngagement.reduce((a, r) => a + r.usd, 0);
    const health = (await (await admin.context.request.get("/api/health")).json().catch(() => ({}))) as Json;
    const ratio = typeof health.todaySpendRatio === "number" ? health.todaySpendRatio : null;
    for (const r of byEngagement) log.line(`readout ${r.engagementId} ${r.mode} USD ${r.usd.toFixed(4)}`);
    log.line(
      `SPEND (lib/llm/budget.ts spendReadout, cohort ${cohortId}): USD ${readoutTotal.toFixed(4)} over ${byEngagement.length} engagement(s);`,
      ratio === null
        ? "guard: no daily budget set"
        : `guard: ${Math.round(ratio * 100)}% of today's budget${budget !== null ? ` (about USD ${(ratio * budget).toFixed(2)} of ${budget})` : ""}`,
    );
    merge(flag(argv, "out"), {
      online: {
        at: new Date().toISOString(),
        cohortId,
        readoutUsd: Number(readoutTotal.toFixed(6)),
        byEngagement,
        guardTodaySpendRatio: ratio,
        dailyBudgetUsd: budget,
      },
    });
  } finally {
    await admin.browser.close().catch(() => undefined);
  }
}

async function offline(argv: string[]) {
  if (process.env.DB_DRIVER !== "pglite" || !process.env.PGLITE_DIR) {
    throw new Error("--offline reads a stopped server's PGlite directory: set DB_DRIVER=pglite and PGLITE_DIR");
  }
  const { fetchTokenTotalsSince, spendUsd } = await import("@/lib/llm/budget");
  const { personaModelName, rubricModelName } = await import("@/lib/llm/model-names");
  const totals = await fetchTokenTotalsSince(new Date(0));
  const models = { persona: personaModelName(), judge: rubricModelName() };
  const usd = spendUsd(totals, models);
  console.log(
    `SPEND (lib/llm/budget.ts guard, whole database): USD ${usd.toFixed(4)} at ${models.persona} (persona side, incl. analyst) and ${models.judge} (judge side); tokens persona ${totals.persona.prompt}+${totals.persona.completion}, judge ${totals.judge.prompt}+${totals.judge.completion}`,
  );
  merge(flag(argv, "out"), { offline: { at: new Date().toISOString(), guardUsd: Number(usd.toFixed(6)), models, totals } });
  const { closeDb } = await import("@/lib/db/client");
  await closeDb();
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--offline")) await offline(argv);
  else await online(argv);
}

main().catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(1);
});
