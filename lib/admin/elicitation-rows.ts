// The stored fact_elicitations rows, which the retention purge keeps, in the
// fact_elicited event shape that summariseElicitation reads. The admin pages
// and the export pass these alongside the events, so the elicitation trace
// survives the purge of the events. The summary takes the earliest message
// per fact, so a fact present in both counts once.

import { inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { factElicitations } from "@/lib/db/schema";

export interface ElicitationEventRow {
  engagementId: string;
  type: string;
  detailJson: unknown;
}

export async function storedElicitationEvents(engagementIds: string[]): Promise<ElicitationEventRow[]> {
  if (engagementIds.length === 0) return [];
  const rows = await db
    .select()
    .from(factElicitations)
    .where(inArray(factElicitations.engagementId, engagementIds))
    .catch(() => []);
  return rows.map((r) => ({
    engagementId: r.engagementId,
    type: "fact_elicited",
    detailJson: {
      factId: r.factId,
      persona: r.personaId,
      turnIndex: r.turnIndex,
      learnerMessagesSoFar: r.learnerMessagesSoFar,
      verified: r.verified,
      matchedKey: r.matchedKey,
      // How the reveal was found and whether the auditor flagged it early
      // (migration 0014), so the summaries count detected and early reveals.
      detection: r.detection,
      early: r.early,
    },
  }));
}
