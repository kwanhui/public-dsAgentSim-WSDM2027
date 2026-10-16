import { NextResponse } from "next/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { storedElicitationEvents } from "@/lib/admin/elicitation-rows";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { db } from "@/lib/db/client";
import {
  checkins,
  cohorts,
  engagements,
  events,
  rubricScores,
  students,
  submissions,
} from "@/lib/db/schema";
import { toCsv } from "@/lib/admin/csv";
import { parseCohortConfig } from "@/lib/cohort/defaults";
import { effectiveScore } from "@/lib/engagement/effective-score";
import { joinRouteOf } from "@/lib/cohort/join-route";
import { notSandboxSeat } from "@/lib/analytics/queries";
import { isReviewer } from "@/lib/auth/roles";
import { summariseElicitation, FACT_ELICITED_EVENT } from "@/lib/engagement/elicitation";
import { elicitationRecorded, NOT_RECORDED } from "@/lib/admin/elicitation-recorded";
import { spendReadout } from "@/lib/llm/budget";
import { readUnverifiedNotes } from "@/lib/admin/unverified";
import { UNVERIFIED_CLAIM_EVENT } from "@/lib/agents/prompt-provenance";
import { loadScenario } from "@/lib/scenarios/load";
import type { StageId } from "@/lib/scenarios/types";

export const runtime = "nodejs";

const EXPORTS = ["scores", "events", "checkins", "engagements"] as const;
type ExportKind = (typeof EXPORTS)[number];

const MODES = ["all", "human"] as const;
type ModeFilter = (typeof MODES)[number];

// CSV export for analysis outside the platform. ?what=scores (default) gives
// one row per rubric criterion score; ?what=events gives the engagement
// event log; ?what=checkins gives the confidence check-ins; ?what=engagements
// gives one row per engagement with its elicitation trace (hidden facts
// obtained, and the learner message at which each was obtained), its
// unverified-result count and, for the instructor, its USD spend. Every
// export carries join_route (invite, sandbox or agent), so sandbox seats can
// be told apart from invited learners. Learners appear
// only as pseudonymous hashes. Every export carries the engagement `mode`
// column (human | agent) so analyst-agent runs can be filtered out, or
// analysed on their own, rather than silently pooled with learner work.
//
// ?mode=human drops analyst-agent runs from the rows themselves. The analytics
// page links to the export with whichever filter is on screen, so a CSV pulled
// from a page reading "human learners only" holds the same engagements the
// figures above it were computed from.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const query = new URL(req.url).searchParams;
  const requested = query.get("what");
  if (requested !== null && !EXPORTS.includes(requested as ExportKind)) {
    return NextResponse.json(
      { error: "unknown-export", requested, allowed: EXPORTS },
      { status: 400 },
    );
  }
  const what: ExportKind = (requested as ExportKind | null) ?? "scores";

  const requestedMode = query.get("mode");
  if (requestedMode !== null && !MODES.includes(requestedMode as ModeFilter)) {
    return NextResponse.json(
      { error: "unknown-mode", requested: requestedMode, allowed: MODES },
      { status: 400 },
    );
  }
  const mode: ModeFilter = (requestedMode as ModeFilter | null) ?? "all";
  const humanOnly = mode === "human";
  // ?sandbox=exclude leaves out sandbox seats, as the analytics page does by
  // default; the join_route column marks them either way.
  const excludeSandbox = query.get("sandbox") === "exclude";
  const scopeSuffix = `${humanOnly ? "-human" : ""}${excludeSandbox ? "-invited" : ""}`;

  const [cohort] = await db
    .select({ id: cohorts.id, slug: cohorts.slug, configJson: cohorts.configJson })
    .from(cohorts)
    .where(and(eq(cohorts.id, id), cohortScope(session)))
    .limit(1);
  if (!cohort)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  // The check-in export follows the cohort's research.checkins switch, the
  // same switch that shows or hides the analytics section. Stored rows are
  // kept either way; they become exportable again when it is turned on.
  if (what === "checkins" && !parseCohortConfig(cohort.configJson).research.checkins) {
    return NextResponse.json(
      {
        error: "checkins-disabled",
        message: "Check-ins are turned off for this cohort, so there is nothing to export.",
      },
      { status: 404 },
    );
  }

  // Both halves of the filter are built here so each query below reads the
  // same way whichever scope was asked for.
  const inScope = (cohortColumn: typeof engagements.cohortId | typeof events.cohortId) =>
    and(
      eq(cohortColumn, id),
      ...(humanOnly ? [eq(engagements.mode, "human")] : []),
      ...(excludeSandbox ? [notSandboxSeat] : []),
    );

  let filename: string;
  let csv: string;

  if (what === "checkins") {
    const rows = await db
      .select({
        engagementId: checkins.engagementId,
        learnerHash: students.learnerHash,
        profileJson: students.profileJson,
        scenarioId: engagements.scenarioId,
        mode: engagements.mode,
        kind: checkins.kind,
        answersJson: checkins.answersJson,
        goal: checkins.goal,
        createdAt: checkins.createdAt,
      })
      .from(checkins)
      .innerJoin(engagements, eq(engagements.id, checkins.engagementId))
      .innerJoin(students, eq(students.id, engagements.studentId))
      .where(inScope(engagements.cohortId))
      .orderBy(asc(checkins.id));
    filename = `${cohort.slug}-checkins${scopeSuffix}.csv`;
    csv = toCsv(
      [
        "engagement_id",
        "learner_hash",
        "join_route",
        "scenario_id",
        "mode",
        "kind",
        "answers_json",
        "goal",
        "created_at_iso",
      ],
      rows.map((r) => [
        r.engagementId,
        r.learnerHash,
        joinRouteOf(r.profileJson),
        r.scenarioId,
        r.mode,
        r.kind,
        JSON.stringify(r.answersJson),
        r.goal ?? "",
        r.createdAt.toISOString(),
      ]),
    );
  } else if (what === "events") {
    const rows = await db
      .select({
        engagementId: events.engagementId,
        learnerHash: students.learnerHash,
        profileJson: students.profileJson,
        scenarioId: engagements.scenarioId,
        mode: engagements.mode,
        type: events.type,
        detailJson: events.detailJson,
        timestampIso: events.timestampIso,
      })
      .from(events)
      .innerJoin(engagements, eq(engagements.id, events.engagementId))
      .innerJoin(students, eq(students.id, engagements.studentId))
      .where(inScope(events.cohortId))
      .orderBy(asc(events.id));
    filename = `${cohort.slug}-events${scopeSuffix}.csv`;
    csv = toCsv(
      [
        "engagement_id",
        "learner_hash",
        "join_route",
        "scenario_id",
        "mode",
        "event_type",
        "detail_json",
        "timestamp_iso",
      ],
      rows.map((r) => [
        r.engagementId,
        r.learnerHash,
        joinRouteOf(r.profileJson),
        r.scenarioId,
        r.mode,
        r.type,
        r.detailJson ? JSON.stringify(r.detailJson) : "",
        r.timestampIso,
      ]),
    );
  } else if (what === "engagements") {
    const rows = await db
      .select({
        engagement: engagements,
        learnerHash: students.learnerHash,
        profileJson: students.profileJson,
      })
      .from(engagements)
      .innerJoin(students, eq(students.id, engagements.studentId))
      .where(inScope(engagements.cohortId))
      .orderBy(asc(engagements.createdAt));
    const ids = rows.map((r) => r.engagement.id);
    const elicited =
      ids.length === 0
        ? []
        : await db
            .select({ engagementId: events.engagementId, type: events.type, detailJson: events.detailJson })
            .from(events)
            .where(and(eq(events.cohortId, id), eq(events.type, FACT_ELICITED_EVENT)))
            .then(async (rows) => [...rows, ...(await storedElicitationEvents(ids))]);
    // Persona prompt versions per engagement: a run from before the
    // elicitation trace exports "not recorded" and blank counts, never 0.
    const turnVersions =
      ids.length === 0
        ? []
        : await db
            .selectDistinct({
              engagementId: events.engagementId,
              promptVersion: sql<string | null>`${events.detailJson} ->> 'promptVersion'`,
            })
            .from(events)
            .where(and(eq(events.cohortId, id), eq(events.type, "persona_turn")));
    const flagged =
      ids.length === 0
        ? []
        : await db
            .select({ engagementId: rubricScores.engagementId, unverifiedClaim: rubricScores.unverifiedClaim })
            .from(rubricScores)
            .innerJoin(engagements, eq(engagements.id, rubricScores.engagementId))
            .where(and(eq(engagements.cohortId, id), eq(rubricScores.unverifiedClaim, true)));
    // Spend is operational data for the instructor; the reviewer's export
    // leaves the column empty.
    const spend = isReviewer(session) ? null : await spendReadout({ cohortId: id }).catch(() => null);
    const out: (string | number)[][] = [];
    for (const r of rows) {
      const e = r.engagement;
      const scenario = await loadScenario(e.scenarioId).catch(() => null);
      const recorded = elicitationRecorded({
        elicitationTrace: e.elicitationTrace,
        createdAt: e.createdAt,
        events: [
          ...elicited.filter((x) => x.engagementId === e.id),
          ...turnVersions
            .filter((x) => x.engagementId === e.id)
            .map((x) => ({ type: "persona_turn", detailJson: { promptVersion: x.promptVersion } })),
        ],
      });
      const summary = scenario
        ? summariseElicitation(
            scenario,
            elicited.filter((x) => x.engagementId === e.id),
            e.status === "completed" ? null : (e.currentStage as StageId),
          )
        : null;
      // Counts only where the trace was on; blank, not 0, where it was not.
      const counted = recorded ? summary : null;
      out.push([
        e.id,
        r.learnerHash,
        joinRouteOf(r.profileJson),
        e.scenarioId,
        e.mode,
        e.status,
        e.currentStage,
        e.createdAt.toISOString(),
        e.completedAt ? e.completedAt.toISOString() : "",
        summary?.total ?? "",
        summary?.reachable ?? "",
        summary ? (recorded ? "yes" : NOT_RECORDED) : "",
        counted?.obtained ?? "",
        // Of those, the facts whose key appeared in the delivered reply.
        counted?.verified ?? "",
        // "fact_id@learner_message" for each fact obtained, in scenario order.
        counted
          ? counted.facts
              .filter((f) => f.obtainedAtLearnerMessage !== null)
              .map((f) => `${f.id}@${f.obtainedAtLearnerMessage}`)
              .join(";")
          : "",
        flagged.filter((x) => x.engagementId === e.id).length,
        spend ? (spend.byEngagement.get(e.id) ?? 0).toFixed(4) : "",
      ]);
    }
    filename = `${cohort.slug}-engagements${scopeSuffix}.csv`;
    csv = toCsv(
      [
        "engagement_id",
        "learner_hash",
        "join_route",
        "scenario_id",
        "mode",
        "status",
        "current_stage",
        "created_at_iso",
        "completed_at_iso",
        "hidden_facts_total",
        "hidden_facts_reachable",
        "hidden_facts_recorded",
        "hidden_facts_obtained",
        "hidden_facts_verified",
        "hidden_facts_obtained_at",
        "unverified_criteria",
        "usd",
      ],
      out,
    );
  } else {
    const rows = await db
      .select({
        engagementId: rubricScores.engagementId,
        learnerHash: students.learnerHash,
        profileJson: students.profileJson,
        scenarioId: engagements.scenarioId,
        mode: engagements.mode,
        stage: submissions.stage,
        kind: submissions.kind,
        submissionId: rubricScores.submissionId,
        submittedAt: submissions.createdAt,
        attempt: submissions.attempt,
        gatePassed: submissions.gatePassed,
        unverifiedNote: rubricScores.unverifiedNote,
        criterionId: rubricScores.criterionId,
        score: rubricScores.score,
        rawScore: rubricScores.rawScore,
        unverifiedClaim: rubricScores.unverifiedClaim,
        maxScore: rubricScores.maxScore,
        judgeModel: rubricScores.judgeModel,
        servedModel: rubricScores.servedModel,
        promptVersion: rubricScores.promptVersion,
        overrideScore: rubricScores.overrideScore,
        overrideNote: rubricScores.overrideNote,
      })
      .from(rubricScores)
      .innerJoin(submissions, eq(submissions.id, rubricScores.submissionId))
      .innerJoin(engagements, eq(engagements.id, rubricScores.engagementId))
      .innerJoin(students, eq(students.id, engagements.studentId))
      .where(inScope(engagements.cohortId))
      .orderBy(asc(rubricScores.id));

    // The attempt number and the gate verdict are stored on the submission
    // row (migration 0012), which the retention purge keeps. Rows scored
    // since then may not have them yet (the scoring code writes the
    // submission_scored event, and lib/logging/grade-record.ts copies it
    // before each purge), so the event fills any gap. `passed` stays empty
    // under a formative policy, where passing has no meaning.
    const scoredEvents = await db
      .select({ detailJson: events.detailJson })
      .from(events)
      .where(
        and(eq(events.cohortId, id), eq(events.type, "submission_scored")),
      );
    const gateBySubmission = new Map<
      string,
      { attempt: number | null; passed: boolean | null }
    >();
    for (const e of scoredEvents) {
      const d = e.detailJson as {
        submissionId?: string;
        attempt?: number;
        passed?: boolean | null;
      } | null;
      if (!d?.submissionId) continue;
      gateBySubmission.set(d.submissionId, {
        attempt: typeof d.attempt === "number" ? d.attempt : null,
        passed: typeof d.passed === "boolean" ? d.passed : null,
      });
    }

    // The judge's note on each unverified result, likewise stored on the
    // score row since migration 0012, with the event as the fallback.
    const unverifiedNotes = readUnverifiedNotes(
      await db
        .select({ type: events.type, detailJson: events.detailJson })
        .from(events)
        .where(and(eq(events.cohortId, id), eq(events.type, UNVERIFIED_CLAIM_EVENT))),
    );

    filename = `${cohort.slug}-rubric-scores${scopeSuffix}.csv`;
    csv = toCsv(
      [
        "engagement_id",
        "learner_hash",
        "join_route",
        "scenario_id",
        "mode",
        "stage",
        "artifact_kind",
        "submission_id",
        "submitted_at_iso",
        "attempt",
        "passed",
        "criterion_id",
        "score",
        // The judge's score before any unverified-result cap (rubric-v4
        // onward; empty for older rows), and whether the judge flagged the
        // criterion as resting on a result the platform cannot check.
        "raw_score",
        "unverified_claim",
        "unverified_note",
        "effective_score",
        "max_score",
        "judge_model",
        "served_model",
        "prompt_version",
        "override_score",
        "override_note",
      ],
      rows.map((r) => {
        const fromEvent = gateBySubmission.get(r.submissionId);
        const gate = {
          attempt: r.attempt ?? fromEvent?.attempt ?? null,
          passed: r.gatePassed ?? fromEvent?.passed ?? null,
        };
        return [
          r.engagementId,
          r.learnerHash,
          joinRouteOf(r.profileJson),
          r.scenarioId,
          r.mode,
          r.stage,
          r.kind,
          r.submissionId,
          r.submittedAt.toISOString(),
          gate.attempt ?? "",
          gate.passed === null ? "" : String(gate.passed),
          r.criterionId,
          r.score,
          r.rawScore ?? "",
          r.unverifiedClaim === null ? "" : String(r.unverifiedClaim),
          r.unverifiedNote ?? unverifiedNotes.get(`${r.submissionId}:${r.criterionId}`) ?? "",
          effectiveScore(r),
          r.maxScore,
          r.judgeModel,
          r.servedModel ?? "",
          r.promptVersion,
          r.overrideScore ?? "",
          r.overrideNote ?? "",
        ];
      }),
    );
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
