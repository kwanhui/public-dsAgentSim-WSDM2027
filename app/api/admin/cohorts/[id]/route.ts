import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { rejectReadOnly } from "@/lib/auth/guard";
import { db } from "@/lib/db/client";
import { cohorts, engagements, students } from "@/lib/db/schema";
import { joinRouteOf } from "@/lib/cohort/join-route";
import { reviewerVisibleRefusal, unlabelledInvitedLearners } from "@/lib/cohort/reviewer-visibility";
import { CohortConfigSchema } from "@/lib/cohort/defaults";
import { configVersion } from "@/lib/cohort/config-version";
import { listScenarios } from "@/lib/scenarios/load";
import { listOpenJoinCohorts, openJoinWarning } from "@/lib/cohort/sandbox";

export const runtime = "nodejs";

// Replaces the cohort's configJson. The full config is validated against the
// Zod schema; a partial or malformed body is rejected rather than merged, so
// the stored config is always schema-complete.
//
// The body is `{ config, baseVersion }`. baseVersion is the fingerprint of the
// config the form loaded: a save whose base no longer matches what is stored
// would silently overwrite whatever a second tab saved in between, so it is
// refused with 409 and the form asks for a reload instead.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const body = (await req.json().catch(() => null)) as
    | { config?: unknown; baseVersion?: unknown }
    | null;
  const storedVersion = configVersion(cohort.configJson);
  const baseVersion = typeof body?.baseVersion === "string" ? body.baseVersion : null;
  if (baseVersion && baseVersion !== storedVersion) {
    return NextResponse.json(
      {
        error: "stale-config",
        version: storedVersion,
        message:
          "This cohort's settings were changed elsewhere since this page loaded. Reload to see the current values.",
      },
      { status: 409 },
    );
  }

  const parsed = CohortConfigSchema.safeParse(body?.config ?? null);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid-config",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
          .join("; "),
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  // The schema types scenarios.allowed as a string array; whether those ids
  // exist, and whether any are left, is a question about the scenario library
  // rather than the JSON shape. An empty list would leave learners with
  // nothing to start, and an unknown id fails only later, when a learner picks
  // it, so both are refused here.
  const allowed = parsed.data.scenarios.allowed;
  if (allowed.length === 0) {
    return NextResponse.json(
      {
        error: "no-scenarios",
        message: "Enable at least one scenario; learners cannot start an engagement without one.",
      },
      { status: 400 },
    );
  }
  const known = new Set((await listScenarios()).map((s) => s.id));
  const unknown = allowed.filter((sid) => !known.has(sid));
  if (unknown.length > 0) {
    return NextResponse.json(
      {
        error: "unknown-scenarios",
        unknown,
        message: `Unknown scenario ${unknown.length === 1 ? "id" : "ids"}: ${unknown.join(", ")}.`,
      },
      { status: 400 },
    );
  }

  // The reviewer account may see only an exhibit cohort: no open join and
  // no invited learners other than labelled showcase runs.
  if (parsed.data.showcase.reviewerVisible) {
    const learnerRows = await db
      .select({ id: students.id, profileJson: students.profileJson })
      .from(students)
      .where(eq(students.cohortId, id));
    const engagementRows = await db
      .select({ id: engagements.id, studentId: engagements.studentId })
      .from(engagements)
      .where(eq(engagements.cohortId, id));
    const refusal = reviewerVisibleRefusal({
      reviewerVisible: true,
      openJoin: parsed.data.sandbox.openJoin,
      invitedLearners: unlabelledInvitedLearners(
        learnerRows.map((l) => ({
          joinRoute: joinRouteOf(l.profileJson),
          engagementIds: engagementRows.filter((e) => e.studentId === l.id).map((e) => e.id),
        })),
        parsed.data.showcase.labels,
      ),
    });
    if (refusal) {
      return NextResponse.json({ error: "reviewer-visible-refused", message: refusal }, { status: 400 });
    }
  }

  await db.update(cohorts).set({ configJson: parsed.data }).where(eq(cohorts.id, id));
  // A second open-join cohort is allowed but reported, so the form can say
  // why the landing page link went away.
  const warning = parsed.data.sandbox.openJoin
    ? openJoinWarning(await listOpenJoinCohorts(), process.env.SANDBOX_COHORT_SLUG)
    : null;
  // The saved fingerprint goes back to the form so the same tab can save again
  // without being told its own write happened elsewhere.
  return NextResponse.json({ ok: true, version: configVersion(parsed.data), warning });
}
