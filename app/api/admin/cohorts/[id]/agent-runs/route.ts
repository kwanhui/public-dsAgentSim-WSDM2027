import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { rejectReadOnly } from "@/lib/auth/guard";
import { db } from "@/lib/db/client";
import { cohorts } from "@/lib/db/schema";
import { DEFAULT_COHORT_CONFIG, parseCohortConfig } from "@/lib/cohort/defaults";
import { checkCohortBudget } from "@/lib/llm/budget";
import { budgetRefusalMessage } from "@/lib/llm/budget-format";
import { activeProvider } from "@/lib/llm/model-names";
import { startAnalystRun, runAnalystModelName } from "@/lib/agents/analyst";
import { analystModelOverrideProblem } from "@/lib/agents/analyst-model";
import { cohortRunInFlight } from "@/lib/agents/agent-run-state";

export const runtime = "nodejs";

// Starts an analyst-agent run in the cohort, as the "Start analyst run"
// button on the agent page does, with one addition: `analystModel` runs this
// one run's analyst on another model than the deployment's LLM_ANALYST_MODEL
// (lib/agents/analyst-model.ts). Instructor only. The showcase regeneration
// (scripts/replay/agent-runs.ts) uses it to run A1 on the persona model and
// A2 on a cheaper model; the stages are then driven from the agent page.
//
// Body: { scenarioId?: string, analystModel?: string }.
// 201 { engagementId, scenarioId, analystModel } where analystModel is the
// model the run records (the mock on the mock provider).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const refused = rejectReadOnly(session);
  if (refused) return refused;

  const [cohort] = await db
    .select({ id: cohorts.id, configJson: cohorts.configJson })
    .from(cohorts)
    .where(and(eq(cohorts.id, id), cohortScope(session)))
    .limit(1);
  if (!cohort) return NextResponse.json({ error: "not found" }, { status: 404 });
  const config = parseCohortConfig(cohort.configJson);

  const body = (await req.json().catch(() => null)) as { scenarioId?: unknown; analystModel?: unknown } | null;
  const allowed =
    config.scenarios.allowed.length > 0 ? config.scenarios.allowed : DEFAULT_COHORT_CONFIG.scenarios.allowed;
  const scenarioId = typeof body?.scenarioId === "string" && body.scenarioId ? body.scenarioId : allowed[0];
  if (!allowed.includes(scenarioId)) {
    return NextResponse.json(
      { error: "scenario-not-allowed", message: `This cohort does not allow scenario ${scenarioId}.` },
      { status: 400 },
    );
  }

  let analystModel: string | null = null;
  if (body?.analystModel !== undefined && body.analystModel !== null && body.analystModel !== "") {
    if (typeof body.analystModel !== "string") {
      return NextResponse.json({ error: "invalid-analyst-model", message: "analystModel must be a string." }, { status: 400 });
    }
    const problem = analystModelOverrideProblem(body.analystModel.trim(), activeProvider());
    if (problem) return NextResponse.json({ error: "invalid-analyst-model", message: problem }, { status: 400 });
    analystModel = body.analystModel.trim();
  }

  const budget = await checkCohortBudget({ id, config });
  if (!budget.ok) {
    return NextResponse.json({ error: "budget", message: budgetRefusalMessage("agent", null) }, { status: 429 });
  }
  if (await cohortRunInFlight(id)) {
    return NextResponse.json(
      { error: "stage-in-flight", message: "A stage of another agent run in this cohort is still running." },
      { status: 409 },
    );
  }

  const engagement = await startAnalystRun(id, scenarioId, { analystModel });
  return NextResponse.json(
    { engagementId: engagement.id, scenarioId, analystModel: runAnalystModelName(analystModel), modelOverride: analystModel },
    { status: 201 },
  );
}
