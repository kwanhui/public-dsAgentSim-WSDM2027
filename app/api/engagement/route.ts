import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveCohortFromRequest } from "@/lib/cohort/resolve";
import { createEngagement, getActiveEngagement, getCohortArchivedAt } from "@/lib/engagement/state";
import { loadScenario } from "@/lib/scenarios/load";

export const runtime = "nodejs";

const BodySchema = z.object({ scenarioId: z.string() });

// Starts an engagement for the calling learner. One active engagement per
// learner; the scenario must be allowed by the cohort config.
export async function POST(req: Request) {
  const cohort = await resolveCohortFromRequest();
  if (!cohort) return NextResponse.json({ error: "not-joined" }, { status: 401 });

  // An archived cohort takes no new engagements; ones already under way are
  // untouched (this route only ever starts engagements).
  if (await getCohortArchivedAt(cohort.cohortId)) {
    return NextResponse.json({ error: "cohort-archived" }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-request" }, { status: 400 });
  const { scenarioId } = parsed.data;

  if (!cohort.config.scenarios.allowed.includes(scenarioId)) {
    return NextResponse.json({ error: "scenario-not-allowed" }, { status: 403 });
  }

  const existing = await getActiveEngagement(cohort.studentId);
  if (existing) {
    return NextResponse.json({ error: "engagement-exists", engagementId: existing.id }, { status: 409 });
  }

  let scenario;
  try {
    scenario = await loadScenario(scenarioId);
  } catch {
    return NextResponse.json({ error: "unknown-scenario" }, { status: 404 });
  }

  const engagement = await createEngagement(cohort.cohortId, cohort.studentId, scenario);
  return NextResponse.json({ engagementId: engagement.id }, { status: 201 });
}
