import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { healthReport } from "@/lib/health";
import { lastPurgeAt } from "@/lib/logging/retention";
import { todaySpendRatio } from "@/lib/llm/budget";
import pkg from "@/package.json";

// Public liveness probe for the reviewer path. One unauthenticated request
// tells a reviewer (or the person checking the deployment before a
// submission) whether the app can reach its database, holds the API key its
// provider needs, and has the secrets that sign-in, learner joins and the
// retention purge depend on, plus when the purge last ran. 200 when every
// required check holds (lib/health.ts), 503 otherwise, with the failing
// field still in the body.
//
// No secret is returned: every check is a boolean, never the value.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  try {
    // A real round trip against whichever driver is configured (Vercel
    // Postgres in production, PGlite under `pnpm demo`), so a reachable
    // process with an unreachable database still reports db: false.
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  // The last purge time is informational; a failed lookup (for example a
  // database not yet migrated to the purge_runs table) reports null.
  const purgedAt = dbOk ? await lastPurgeAt().catch(() => null) : null;

  // Today's spend against LLM_DAILY_BUDGET_USD, from the same cached figure
  // the spend guard uses; null without a budget or on a failed read.
  const spendRatio = dbOk ? await todaySpendRatio().catch(() => null) : null;

  const report = healthReport({
    dbOk,
    packageVersion: pkg.version,
    lastPurgeAt: purgedAt,
    todaySpendRatio: spendRatio,
  });
  return NextResponse.json(report.body, {
    status: report.status,
    headers: { "cache-control": "no-store" },
  });
}
