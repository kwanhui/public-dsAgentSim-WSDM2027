import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveLearnerContext } from "@/lib/engagement/request";
import { addCheckin, getCheckins, logEvent } from "@/lib/engagement/state";
import { STAGE_IDS } from "@/lib/scenarios/types";

export const runtime = "nodejs";

// Six Likert items, one confidence rating (1..7) per pipeline stage.
const BodySchema = z.object({
  kind: z.enum(["start", "complete"]),
  answers: z.record(z.enum(STAGE_IDS), z.number().int().min(1).max(7)),
  // Optional one-line learning goal, meaningful only on the start check-in.
  goal: z.string().trim().max(500).optional(),
});

export async function POST(req: Request) {
  const res = await resolveLearnerContext();
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 401 });
  const { engagement, cohort } = res.ctx;

  if (!cohort.config.research.checkins) {
    return NextResponse.json({ error: "checkins-disabled" }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data.answers).length !== STAGE_IDS.length) {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }
  const { kind, answers, goal } = parsed.data;

  if (kind === "complete" && engagement.status !== "completed") {
    return NextResponse.json({ error: "engagement-not-completed" }, { status: 409 });
  }

  const existing = await getCheckins(engagement.id);
  if (existing.some((c) => c.kind === kind)) {
    return NextResponse.json({ error: "already-submitted" }, { status: 409 });
  }

  await addCheckin(engagement.id, kind, answers, kind === "start" ? goal : undefined);
  await logEvent(engagement.id, engagement.cohortId, "checkin_submitted", { kind });
  return NextResponse.json({ ok: true }, { status: 201 });
}
