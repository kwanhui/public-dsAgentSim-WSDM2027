import type { NextRequest } from "next/server";
import { handleSandboxJoin } from "@/lib/cohort/sandbox-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Try as a learner" without a slug: joins the configured sandbox cohort
// (SANDBOX_COHORT_SLUG, or the only cohort with sandbox.openJoin set). The
// documented link is /try/<slug>. See lib/cohort/sandbox.ts.
export async function GET(req: NextRequest) {
  return handleSandboxJoin(req);
}
