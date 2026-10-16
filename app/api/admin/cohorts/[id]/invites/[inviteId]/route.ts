import { NextResponse } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { rejectReadOnly } from "@/lib/auth/guard";
import { db } from "@/lib/db/client";
import { cohorts, cohortInvites } from "@/lib/db/schema";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; inviteId: string }> },
) {
  const { id, inviteId } = await params;
  const session = await auth();
  const refused = rejectReadOnly(session);
  if (refused) return refused;

  const [cohort] = await db
    .select({ id: cohorts.id })
    .from(cohorts)
    .where(and(eq(cohorts.id, id), cohortScope(session)))
    .limit(1);
  if (!cohort) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // An invite redeemed between the page load and this click cannot be revoked,
  // and that is a different situation from a link that is not there at all:
  // the first is a learner who just joined, the second a stale page. They are
  // reported apart so the invite list can say which happened.
  const [invite] = await db
    .select({ id: cohortInvites.id, usedAt: cohortInvites.usedAt })
    .from(cohortInvites)
    .where(and(eq(cohortInvites.id, inviteId), eq(cohortInvites.cohortId, id)))
    .limit(1);
  if (!invite) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  if (invite.usedAt) {
    return NextResponse.json({ error: "already-redeemed" }, { status: 409 });
  }

  // Revoking keeps the row so the instructor can still account for every link
  // they handed out. Expiring it in the same write is what makes it
  // unredeemable: acceptInvite already refuses an expired token, so no second
  // check has to be kept in step with this one.
  const now = new Date();
  const result = await db
    .update(cohortInvites)
    .set({ revokedAt: now, expiresAt: now })
    .where(
      and(
        eq(cohortInvites.id, inviteId),
        eq(cohortInvites.cohortId, id),
        isNull(cohortInvites.usedAt),
      ),
    )
    .returning({ id: cohortInvites.id });

  // Lost the race with a redemption between the read above and this update.
  if (result.length === 0) {
    return NextResponse.json({ error: "already-redeemed" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
