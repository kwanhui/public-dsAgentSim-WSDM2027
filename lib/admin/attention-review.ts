// "Mark reviewed" on the needs-attention list: records who reviewed an
// engagement's flags and when (engagements.attention_reviewed_at/_by). The
// flags themselves are untouched; lib/admin/attention.ts counts only those
// raised after this time for the filter.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { engagements } from "@/lib/db/schema";
import { formatUtc } from "@/lib/admin/format";

export async function markAttentionReviewed(
  engagementId: string,
  reviewer: string | null,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(engagements)
    .set({ attentionReviewedAt: now, attentionReviewedBy: reviewer })
    .where(eq(engagements.id, engagementId));
}

/** "Reviewed 2026-09-30 10:12 UTC by admin", or null when never reviewed. */
export function reviewedLine(reviewedAt: Date | null, reviewer: string | null): string | null {
  if (!reviewedAt) return null;
  return `Reviewed ${formatUtc(reviewedAt)}${reviewer ? ` by ${reviewer}` : ""}`;
}
