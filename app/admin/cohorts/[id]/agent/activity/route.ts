import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { db } from "@/lib/db/client";
import { cohorts, engagements } from "@/lib/db/schema";
import { getEvents } from "@/lib/engagement/state";
import { isAnalystFailureEvent } from "@/lib/agents/analyst";
import { STAGE_FINISHED_EVENT, STAGE_STARTED_EVENT, inFlightSince } from "@/lib/agents/agent-run-state";
import { loadScenario } from "@/lib/scenarios/load";
import { STAGE_TITLES, type Scenario, type StageId } from "@/lib/scenarios/types";
import { formatUtc, truncateWords } from "@/lib/admin/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The latest analyst activity on one agent run, as a single line. The agent
// page polls this while "Run current stage" holds its request open, so the
// presenter sees what the agent is doing instead of a bare spinner. Read-only:
// the run's own request writes the events, this route only renders the newest.

const ACTIVITY_LINE_MAX_CHARS = 160;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const runId = new URL(req.url).searchParams.get("run") ?? "";
  if (!runId) return NextResponse.json({ error: "missing run" }, { status: 400 });

  const [run] = await db
    .select({
      id: engagements.id,
      scenarioId: engagements.scenarioId,
      status: engagements.status,
      currentStage: engagements.currentStage,
    })
    .from(engagements)
    .innerJoin(cohorts, eq(cohorts.id, engagements.cohortId))
    .where(
      and(
        eq(engagements.id, runId),
        eq(engagements.cohortId, id),
        cohortScope(session),
        eq(engagements.mode, "agent"),
      ),
    )
    .limit(1);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  // The scenario names the personas; a run whose scenario file is gone still
  // gets a line, with the raw persona id in place of a name.
  let scenario: Scenario | null = null;
  try {
    scenario = await loadScenario(run.scenarioId);
  } catch {
    scenario = null;
  }

  const events = await getEvents(run.id);
  // Machine-readable run state for the regeneration drivers
  // (scripts/replay/agent-run.ts), which poll it while a real-model stage
  // runs: the run's status and stage, whether a stage is in flight, and
  // whether the newest attempt failed (the agent page's retry banner).
  const lastReal = [...events]
    .reverse()
    .find((e) => e.type !== STAGE_STARTED_EVENT && e.type !== STAGE_FINISHED_EVENT);
  const state = {
    status: run.status,
    stage: run.currentStage,
    inFlight: inFlightSince(events) !== null,
    failed: Boolean(lastReal && isAnalystFailureEvent(lastReal.type)),
  };
  for (let i = events.length - 1; i >= 0; i--) {
    const line = describeEvent(events[i], scenario);
    if (line) {
      return NextResponse.json({
        line: `${line} · ${formatUtc(events[i].timestampIso, { seconds: true })}`,
        ...state,
      });
    }
  }
  return NextResponse.json({ line: null, ...state });
}

type EventRow = Awaited<ReturnType<typeof getEvents>>[number];

function personaName(scenario: Scenario | null, personaId: unknown): string {
  if (typeof personaId !== "string" || personaId.length === 0) return "a stakeholder";
  return scenario?.personas.find((p) => p.id === personaId)?.name ?? personaId;
}

function snippet(text: unknown): string {
  return typeof text === "string" && text.trim().length > 0
    ? `: ${truncateWords(text, ACTIVITY_LINE_MAX_CHARS)}`
    : "";
}

// One line per event type worth narrating; anything else returns null and the
// scan keeps looking backwards.
function describeEvent(e: EventRow, scenario: Scenario | null): string | null {
  const d = (e.detailJson ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "analyst_step":
      return d.action === "message"
        ? `Analyst messaged ${personaName(scenario, d.channelPersonaId)}${snippet(d.reasoning)}`
        : `Analyst submitted the gate artifact${snippet(d.reasoning)}`;
    case "analyst_step_rejected":
      return `Analyst action rejected (${typeof d.reason === "string" ? d.reason : "invalid"}); it takes another step`;
    case "persona_turn":
      return `${personaName(scenario, d.personaId)} replied`;
    case "client_reaction":
      return `${personaName(scenario, d.personaId)} reacted to the submission`;
    case "submission_scored":
      return typeof d.scoreRatio === "number"
        ? `Rubric judge scored the submission at ${Math.round(d.scoreRatio * 100)}%`
        : "Rubric judge scored the submission";
    case "stage_advanced": {
      const to = typeof d.to === "string" ? d.to : null;
      return to
        ? `Stage advanced to ${STAGE_TITLES[to as StageId] ?? to}`
        : "Stage advanced";
    }
    case "engagement_completed":
      return "Engagement completed";
    case "analyst_step_failed":
    case "analyst_stage_failed":
      return `Stage run failed (${typeof d.errorClass === "string" ? d.errorClass : "Error"})`;
    case "analyst_stage_started":
      return "Stage run started";
    default:
      return null;
  }
}
