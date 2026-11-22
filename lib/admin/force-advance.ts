// The ledger fact a forced stage advance writes. Every persona reads the
// ledger, so the fact stays inside the simulated engagement: the client
// agreed to move on. That an instructor decided it is recorded only in the
// stage_forced event. Pure.

import { STAGE_TITLES, type StageId } from "@/lib/scenarios/types";

export function forcedAdvanceFact(from: StageId, to: StageId | null): string {
  const fromTitle = STAGE_TITLES[from] ?? from;
  if (!to) return `The client agreed to close the engagement after ${fromTitle}.`;
  return `The client agreed to move on from ${fromTitle} to ${STAGE_TITLES[to] ?? to}.`;
}
