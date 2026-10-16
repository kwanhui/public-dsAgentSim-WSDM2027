// Whether an analyst-agent stage is running, read from the event log. A
// stage run holds its request open for as long as the model takes, so the
// only server-side record that one is under way is a pair of events that
// bracket it: a start with no finish after it means a stage is executing.
// Used by the agent page (app/admin/cohorts/[id]/agent) and the agent-run
// route, which both refuse to start a run while another stage is in flight.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { engagements } from "@/lib/db/schema";
import { getEvents } from "@/lib/engagement/state";

export const STAGE_STARTED_EVENT = "analyst_stage_started";
export const STAGE_FINISHED_EVENT = "analyst_stage_finished";
// A start event whose finish never arrived (a redeployed server, a killed
// request) must not block the cohort for the rest of the demo.
export const STAGE_STALE_MS = 10 * 60 * 1000;

// Local regeneration resume only (scripts/replay/local-server.sh sets it when
// REGEN_RESUME=1): the server was restarted on an earlier run's database, so a
// stage-start event older than this process belongs to a request that died
// with the previous server. Off elsewhere, where another instance may really
// be running that stage.
function startedBeforeThisProcess(at: Date): boolean {
  return process.env.STAGE_ORPHAN_AFTER_RESTART === "1" && at.getTime() < Date.now() - process.uptime() * 1000;
}

/** When the newest bracket on this run is a start, the time it started;
 * null when no stage is running (or the start is stale). Pure. */
export function inFlightSince(events: readonly { type: string; timestampIso: string }[]): Date | null {
  let since: Date | null = null;
  for (const e of events) {
    if (e.type === STAGE_STARTED_EVENT) since = new Date(e.timestampIso);
    else if (e.type === STAGE_FINISHED_EVENT) since = null;
  }
  if (!since || startedBeforeThisProcess(since)) return null;
  return Date.now() - since.getTime() < STAGE_STALE_MS ? since : null;
}

export async function cohortRunInFlight(cohortId: string): Promise<boolean> {
  const runs = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(and(eq(engagements.cohortId, cohortId), eq(engagements.mode, "agent")));
  for (const run of runs) {
    if (inFlightSince(await getEvents(run.id)) !== null) return true;
  }
  return false;
}
