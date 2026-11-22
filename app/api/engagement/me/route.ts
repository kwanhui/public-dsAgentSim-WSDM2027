import { NextResponse } from "next/server";
import { learnerMessageCap } from "@/lib/cohort/limits";
import { activeProvider } from "@/lib/llm/model-names";
import { demoContact } from "@/app/privacy/provider-line";
import { learnerRationaleOf } from "@/lib/agents/rationale-filter";
import { getReleasedFiles } from "@/lib/agents/data-environment";
import { resolveLearnerContext } from "@/lib/engagement/request";
import {
  countLearnerMessages,
  getChannelMessageCounts,
  getChannels,
  getCheckins,
  getRubricScores,
  getSubmissions,
} from "@/lib/engagement/state";
import { applyRubricVisibility, closedStages } from "@/lib/engagement/rubric-visibility";
import { toPublicScenario } from "@/lib/scenarios/public";
import { effectiveScore } from "@/lib/engagement/effective-score";
import { getEngagement, loadScenarioFor } from "@/lib/engagement/state";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { engagements } from "@/lib/db/schema";
import { loadScenario } from "@/lib/scenarios/load";
import { pendingFiles } from "./pending-files";

export const runtime = "nodejs";

// The learner's engagements, newest first, for the "Your engagements" list.
// Read-only rows; a failure only costs the list.
async function learnerEngagements(studentId: string) {
  try {
    const rows = await db
      .select({
        id: engagements.id,
        scenarioId: engagements.scenarioId,
        status: engagements.status,
        createdAt: engagements.createdAt,
        completedAt: engagements.completedAt,
      })
      .from(engagements)
      .where(eq(engagements.studentId, studentId))
      .orderBy(desc(engagements.createdAt));
    const titles = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.scenarioId))) {
      titles.set(id, await loadScenario(id).then((sc) => sc.title).catch(() => id));
    }
    return rows.map((r) => ({ ...r, scenarioTitle: titles.get(r.scenarioId) ?? r.scenarioId }));
  } catch {
    return [];
  }
}

// Full workspace state bundle for the calling learner: their current
// engagement, or with ?engagement=<id> one of their earlier engagements,
// read-only.
export async function GET(req?: Request) {
  const res = await resolveLearnerContext();
  if (!res.ok) {
    const status = res.reason === "no-cohort" ? 401 : 404;
    return NextResponse.json({ error: res.reason }, { status });
  }
  const { cohort } = res.ctx;
  let { engagement, scenario } = res.ctx;
  const wanted = req ? new URL(req.url).searchParams.get("engagement") : null;
  const currentId = engagement.id;
  if (wanted && wanted !== engagement.id) {
    const other = await getEngagement(wanted);
    // Only the learner's own engagements; anything else reads as absent.
    if (!other || other.studentId !== cohort.studentId) {
      return NextResponse.json({ error: "no-engagement" }, { status: 404 });
    }
    engagement = other;
    scenario = await loadScenarioFor(other);
  }
  const allEngagements = await learnerEngagements(cohort.studentId);

  const [channels, submissions, scores, releasedFiles, checkinRows, messageCounts, messagesSent] =
    await Promise.all([
      getChannels(engagement.id),
      getSubmissions(engagement.id),
      getRubricScores(engagement.id),
      getReleasedFiles(engagement.id),
      getCheckins(engagement.id),
      getChannelMessageCounts(engagement.id),
      countLearnerMessages(engagement.id),
    ]);
  const maxLearnerMessages = learnerMessageCap(cohort.config, cohort.joinRoute);

  const showScores = cohort.config.ui.showRubricScores;
  const scoresBySubmission = new Map<string, typeof scores>();
  for (const s of scores) {
    const list = scoresBySubmission.get(s.submissionId) ?? [];
    list.push(s);
    scoresBySubmission.set(s.submissionId, list);
  }

  const startCheckin = checkinRows.find((c) => c.kind === "start");
  const completeCheckin = checkinRows.find((c) => c.kind === "complete");

  return NextResponse.json({
    engagement: {
      id: engagement.id,
      scenarioId: engagement.scenarioId,
      currentStage: engagement.currentStage,
      status: engagement.status,
      // True when this is an earlier engagement opened from the list: the
      // workspace shows it read-only, with a way back to the current one.
      past: engagement.id !== currentId,
    },
    // Every engagement this learner has, newest first, so the earlier ones
    // stay readable after a new one starts.
    engagements: allEngagements.map((e) => ({
      id: e.id,
      scenarioTitle: e.scenarioTitle,
      status: e.status,
      createdAt: e.createdAt,
      completedAt: e.completedAt,
      current: e.id === currentId,
    })),
    learner: {
      // The learner hash is the only identity the platform holds; the same
      // prefix appears in the instructor's views, so a learner asking about
      // their engagement can quote something the instructor can find.
      pseudonym: cohort.learnerHash.slice(0, 12),
      cohortName: cohort.cohortName,
      // How the seat was created; a sandbox visitor sees "Demo" instead of
      // the cohort name and a notice without an instructor in it.
      joinRoute: cohort.joinRoute,
      // The configured model provider, so the workspace notice says where
      // messages go with the same check as the privacy page.
      provider: activeProvider(),
      // How a sandbox visitor reaches the demo authors (DEMO_CONTACT).
      demoContact: cohort.joinRoute === "sandbox" ? demoContact() : null,
    },
    // The engagement's message allowance, shown under the chat composer.
    limits: {
      maxLearnerMessages,
      messagesSent,
      messagesRemaining: Math.max(0, maxLearnerMessages - messagesSent),
    },
    scenario: applyRubricVisibility(
      toPublicScenario(scenario),
      closedStages({
        stageIds: scenario.stages.map((s) => s.id),
        currentStage: engagement.currentStage,
        completed: engagement.status === "completed",
      }),
    ),
    channels: channels.map((c) => ({
      id: c.id,
      personaId: c.personaId,
      unlocked: c.unlockedAt !== null,
      messagesFromPersona: messageCounts.get(c.id)?.fromPersona ?? 0,
    })),
    releasedFiles: releasedFiles.map((file) => {
      const dataset = scenario.datasets.find((d) => d.file === file);
      return {
        file,
        description: dataset?.description ?? "",
        // The dictionary travels with the extract once the data owner has
        // released it, the way it would in a real handover. Unreleased files
        // are absent from this list entirely, so nothing leaks early.
        dictionary: dataset?.dictionary ?? "",
      };
    }),
    // The column names of files not yet released, from the stage at which
    // they become available (pending-files.ts).
    pendingFiles: pendingFiles(
      scenario.datasets,
      releasedFiles,
      scenario.stages.map((st) => st.id),
      engagement.currentStage,
      engagement.status === "completed",
    ),
    submissions: submissions.map((s) => ({
      id: s.id,
      // The instructor has looked at this submission: a score in it was
      // changed, or its engagement's flags were marked reviewed after it
      // came in. The learner sees "Reviewed by your instructor".
      reviewed:
        (scoresBySubmission.get(s.id) ?? []).some((r) => r.overriddenAt != null) ||
        (engagement.attentionReviewedAt != null &&
          new Date(engagement.attentionReviewedAt).getTime() >= new Date(s.createdAt).getTime()),
      stage: s.stage,
      kind: s.kind,
      status: s.status,
      createdAt: s.createdAt,
      text: s.contentText,
      // Reflections are a research instrument; while the cohort has them
      // switched off, stored text stays in the database but is not shown.
      reflection: cohort.config.research.reflections ? s.reflectionText : null,
      scores: showScores
        ? (scoresBySubmission.get(s.id) ?? []).map((r) => ({
            criterionId: r.criterionId,
            // The grade that stands: the instructor's override when there is
            // one, otherwise the judge's score.
            score: effectiveScore(r),
            judgeScore: r.score,
            // An instructor changed this score. The learner sees "Adjusted
            // by your instructor (judge: 4/5)" and the instructor's note,
            // rather than a new number under the judge's old reasoning.
            adjusted: r.overrideScore !== null && r.overrideScore !== undefined && r.overrideScore !== r.score,
            overrideNote: r.overrideScore !== null && r.overrideScore !== undefined ? (r.overrideNote ?? null) : null,
            maxScore: r.maxScore,
            // The learner's copy of the rationale, with facts the learner
            // has not raised filtered out; the instructor sees the full text.
            rationale: learnerRationaleOf(r),
            // The judge's one line on what would raise the score; dropped
            // once the standing grade is full marks.
            improve: effectiveScore(r) >= r.maxScore ? null : (r.improve ?? null),
          }))
        : [],
    })),
    ui: { showRubricScores: showScores },
    research: { reflections: cohort.config.research.reflections },
    // The learner is held to these, so they are stated in the stage-gate
    // panel rather than left to be inferred from a failed attempt.
    gates: {
      minScoreRatio: cohort.config.gates.minScoreRatio,
      maxRetries: cohort.config.gates.maxRetries,
    },
    checkins: {
      enabled: cohort.config.research.checkins,
      goal: startCheckin?.goal ?? null,
      start: startCheckin ? { answers: startCheckin.answersJson as Record<string, number> } : null,
      complete: completeCheckin ? { answers: completeCheckin.answersJson as Record<string, number> } : null,
    },
  });
}
