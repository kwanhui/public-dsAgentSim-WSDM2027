// Reading the unverified-result flags (rubric-v5) for the admin views.

import { UNVERIFIED_CLAIM_EVENT } from "@/lib/agents/prompt-provenance";

interface EventLike {
  type: string;
  detailJson: unknown;
}

/** The judge's note per "<submissionId>:<criterionId>", from the
 * unverified_claim_flagged events. */
export function readUnverifiedNotes(events: readonly EventLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.type !== UNVERIFIED_CLAIM_EVENT) continue;
    const d = (e.detailJson ?? {}) as { submissionId?: unknown; criteria?: unknown };
    if (typeof d.submissionId !== "string" || !Array.isArray(d.criteria)) continue;
    for (const c of d.criteria as { criterionId?: unknown; note?: unknown }[]) {
      if (typeof c.criterionId === "string" && typeof c.note === "string" && c.note) {
        out.set(`${d.submissionId}:${c.criterionId}`, c.note);
      }
    }
  }
  return out;
}

/** Stored score rows flagged as resting on an unverified result. */
export function unverifiedCount(rows: readonly { unverifiedClaim: boolean | null }[]): number {
  return rows.filter((r) => r.unverifiedClaim === true).length;
}
