import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth/config";
import { cohortScope, sessionInstructorId } from "@/lib/auth/cohort-scope";
import { rejectReadOnly } from "@/lib/auth/guard";
import { db } from "@/lib/db/client";
import { cohorts } from "@/lib/db/schema";
import { deleteTarget, findDeletionTarget } from "@/lib/admin/deletion";
import { DELETION_KINDS } from "@/lib/admin/deletion-phrase";

export const runtime = "nodejs";

const BodySchema = z.object({
  kind: z.enum(DELETION_KINDS as [string, ...string[]]),
  id: z.string().min(1),
  confirm: z.string(),
});

// Deletes a learner, an engagement or a cohort, with everything under it
// (lib/admin/deletion.ts). Instructor only: the reviewer gets 403 before
// anything is read. The body carries the phrase the instructor typed, which
// must match the target's confirmation phrase.
export async function POST(req: Request) {
  const session = await auth();
  const refused = rejectReadOnly(session);
  if (refused) return refused;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-request" }, { status: 400 });
  const { kind, id, confirm } = parsed.data as { kind: "learner" | "engagement" | "cohort"; id: string; confirm: string };

  const target = await findDeletionTarget(kind, id);
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });
  // The target's cohort must be one this instructor owns.
  const [owned] = await db
    .select({ id: cohorts.id })
    .from(cohorts)
    .where(and(eq(cohorts.id, target.cohortId), cohortScope(session)))
    .limit(1);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = await deleteTarget(target, confirm, sessionInstructorId(session));
  if (!result.ok) {
    return NextResponse.json({ error: result.error, message: result.message }, { status: result.status });
  }
  return NextResponse.json({ ok: true, rows: result.rows });
}
