// Data assembly for the compare view: one engagement's stages, attempts,
// transcripts and recorded conditions, read from its own rows.

import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { storedElicitationEvents } from "@/lib/admin/elicitation-rows";
import { db } from "@/lib/db/client";
import { cohorts, engagements, rubricScores, students, submissions } from "@/lib/db/schema";
import {
  getChannels,
  getEvents,
  getMessages,
  getRubricScores,
  getSubmissions,
  type Channel,
  type Engagement,
  type Message,
  type RubricScore,
  type Submission,
} from "@/lib/engagement/state";
import { parseCohortConfig, type CohortConfig } from "@/lib/cohort/defaults";
import { submissionTotals } from "@/lib/engagement/effective-score";
import { loadScenario } from "@/lib/scenarios/load";
import { STAGE_IDS, stageIndex, type Scenario, type StageId } from "@/lib/scenarios/types";
import { readGateOutcomes, type GateOutcome } from "@/lib/admin/format";
import {
  activeTimeMs,
  analystBrackets,
  failedAttemptSpans,
  failedCount,
  failuresIn,
  interruptedCount,
  overlapMs,
} from "@/lib/admin/wall-clock";
import { runKind, type RunKind } from "@/lib/admin/run-kind";
import { summariseElicitation, type ElicitationSummary } from "@/lib/engagement/elicitation";
import { elicitationRecorded } from "@/lib/admin/elicitation-recorded";
import {
  analystModelFromEvents,
  auditorPromptFromEvents,
  eventTokens,
  judgeModelFromScores,
  judgePromptFromScores,
  personaPromptFromEvents,
  meteredTokens,
  personaModelFromEvents,
  runRubricTotal,
} from "@/lib/admin/run-provenance";

export interface Row {
  engagement: Engagement;
  learnerHash: string;
}

export type CohortRow = {
  id: string;
  name: string;
  configJson: unknown;
  archivedAt: Date | null;
};

type EventRow = Awaited<ReturnType<typeof getEvents>>[number];

export interface Attempt {
  submission: Submission;
  scores: RubricScore[];
  total: number;
  max: number;
  outcome: GateOutcome | null;
}

export interface StageCell {
  reached: boolean;
  attempts: Attempt[];
  score: number;
  max: number;
  learnerMessages: number;
  // Persona replies in chat, and the client's reactions to gate submissions
  // (which land in the same channel), counted apart.
  personaMessages: number;
  gateReactions: number;
  // Wall clock (lib/admin/wall-clock): for an agent run the successful
  // stage attempts only; otherwise the stage window with failed analyst
  // attempts cut out.
  durationMs: number | null;
  failedAttempts: number;
  // Attempts that started and never finished (the run was stopped and the
  // stage resumed later); left out of durationMs.
  interruptedAttempts: number;
  inProgress: boolean;
  tokens: number;
}

export interface SideData {
  engagement: Engagement;
  learnerHash: string;
  cohortName: string;
  cohortArchived: boolean;
  config: CohortConfig;
  scenario: Scenario;
  isAgent: boolean;
  // Analyst agent, scripted replay by the authors, or learner
  // (lib/admin/run-kind.ts).
  kind: RunKind;
  currentIndex: number;
  // What the run recorded; null means the run carries no record.
  personaModel: string | null;
  // The analyst model of an agent run (analyst_run_started); null for a run
  // without an analyst.
  analystModel: string | null;
  judgeModel: string | null;
  judgePrompt: string | null;
  auditorPrompt: string | null;
  personaPrompt: string | null;
  // Hidden facts obtained (fact_elicited events).
  elicitation: ElicitationSummary;
  // False for a run from before the elicitation trace: its count reads
  // "not recorded", never 0 of N (lib/admin/elicitation-recorded.ts).
  elicitationRecorded: boolean;
  // USD for the run, priced as the spend guard prices it; null for the
  // reviewer, who sees no spend.
  usd: number | null;
  channels: {
    channel: Channel;
    label: string;
    personaName: string;
    messages: Message[];
  }[];
  stages: Record<StageId, StageCell>;
  totals: {
    score: number;
    max: number;
    learnerMessages: number;
    personaMessages: number;
    durationMs: number | null;
    failedAttempts: number;
    interruptedAttempts: number;
    // Every metered call in the run, the total the paper reports.
    meteredTokens: number;
  };
}

// One engagement by id, restricted to the cohorts this session may read
// (cohortScope) and including archived ones: a deep link into an archived
// cohort keeps working.
export async function findEngagement(id: string, scope: SQL): Promise<Row | null> {
  const [row] = await db
    .select({ engagement: engagements, learnerHash: students.learnerHash })
    .from(engagements)
    .innerJoin(students, eq(students.id, engagements.studentId))
    .innerJoin(cohorts, eq(cohorts.id, engagements.cohortId))
    .where(and(eq(engagements.id, id), scope))
    .limit(1);
  return row ?? null;
}

export async function rowsForCohort(cohortId: string): Promise<Row[]> {
  return db
    .select({ engagement: engagements, learnerHash: students.learnerHash })
    .from(engagements)
    .innerJoin(students, eq(students.id, engagements.studentId))
    .where(eq(engagements.cohortId, cohortId))
    .orderBy(desc(engagements.createdAt));
}

// Rubric totals for the picker labels, in one query over every listed run.
export async function rubricTotalsFor(
  engagementIds: string[],
): Promise<Map<string, { score: number; max: number }>> {
  const out = new Map<string, { score: number; max: number }>();
  if (engagementIds.length === 0) return out;
  const rows = await db
    .select({
      engagementId: rubricScores.engagementId,
      submissionId: rubricScores.submissionId,
      score: rubricScores.score,
      maxScore: rubricScores.maxScore,
      overrideScore: rubricScores.overrideScore,
      stage: submissions.stage,
      createdAt: submissions.createdAt,
    })
    .from(rubricScores)
    .innerJoin(submissions, eq(submissions.id, rubricScores.submissionId))
    .where(inArray(rubricScores.engagementId, engagementIds));
  const byEngagement = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byEngagement.get(r.engagementId) ?? [];
    list.push(r);
    byEngagement.set(r.engagementId, list);
  }
  for (const [engagementId, list] of byEngagement) {
    const subs = new Map(list.map((r) => [r.submissionId, { id: r.submissionId, stage: r.stage, createdAt: r.createdAt }]));
    out.set(engagementId, runRubricTotal([...subs.values()], list));
  }
  return out;
}

export async function loadSide(
  row: Row,
  cohortById: Map<string, CohortRow>,
  opts: { usd?: number | null } = {},
): Promise<SideData> {
  const { engagement, learnerHash } = row;
  const scenario = await loadScenario(engagement.scenarioId);
  const [chans, submissionRows, scoreRows, eventRows] = await Promise.all([
    getChannels(engagement.id),
    getSubmissions(engagement.id),
    getRubricScores(engagement.id),
    getEvents(engagement.id),
  ]);
  const transcripts = await Promise.all(chans.map((c) => getMessages(c.id)));

  const cohort = cohortById.get(engagement.cohortId);
  const config = parseCohortConfig(cohort?.configJson);

  const currentIndex = stageIndex(engagement.currentStage as StageId);
  const completed = engagement.status === "completed";
  const starts = stageStarts(engagement, eventRows);
  const gateOutcomes = readGateOutcomes(eventRows);
  const failedSpans = failedAttemptSpans(eventRows);
  // Stage attempts of an agent run; empty for a human run or an agent run
  // from before analyst_stage_finished was logged.
  const brackets = analystBrackets(eventRows, { running: !completed });
  const bracketed = brackets.length > 0;

  const stages = {} as Record<StageId, StageCell>;
  for (const [i, stage] of STAGE_IDS.entries()) {
    const reached = completed || i <= currentIndex;
    const start = starts.get(stage) ?? null;
    const end = stageEnd(stage, starts, engagement, eventRows);
    const inWindow = (iso: string) => {
      if (!start) return false;
      const t = new Date(iso).getTime();
      return t >= start.getTime() && (end === null || t < end.getTime());
    };

    const attempts: Attempt[] = submissionRows
      .filter((s) => s.stage === stage)
      .map((stored) => {
        const scores = scoreRows.filter((r) => r.submissionId === stored.id);
        // Reflections stay in the database when a cohort switches them off,
        // but are shown only while the cohort collects them.
        const submission = config.research.reflections
          ? stored
          : { ...stored, reflectionText: null };
        return {
          submission,
          scores,
          total: submissionTotals(scores).effective,
          max: scores.reduce((sum, r) => sum + r.maxScore, 0),
          outcome: gateOutcomes.get(submission.id) ?? null,
        };
      });
    const scored = [...attempts].reverse().find((att) => att.scores.length > 0);

    let learnerMessages = 0;
    let personaMessages = 0;
    let tokens = 0;
    const gateReactions = eventRows.filter((e) => e.type === "client_reaction" && inWindow(e.timestampIso)).length;
    for (const msgs of transcripts) {
      for (const m of msgs) {
        if (!inWindow(m.timestampIso)) continue;
        if (m.sender === "learner") learnerMessages++;
        else personaMessages++;
        tokens += m.promptTokens + m.completionTokens;
      }
    }
    for (const e of eventRows) {
      if (!inWindow(e.timestampIso)) continue;
      tokens += eventTokens(e);
    }

    stages[stage] = {
      reached,
      attempts,
      score: scored?.total ?? 0,
      max: scored?.max ?? 0,
      learnerMessages,
      personaMessages: Math.max(0, personaMessages - gateReactions),
      gateReactions,
      tokens,
      inProgress: reached && !completed && i === currentIndex,
      durationMs: bracketed
        ? start && end
          ? activeTimeMs(brackets, stage)
          : null
        : start && end
          ? end.getTime() - start.getTime() - overlapMs(failedSpans, start.getTime(), end.getTime())
          : null,
      failedAttempts: bracketed
        ? failedCount(brackets, stage)
        : start
          ? failuresIn(eventRows, start.getTime(), end ? end.getTime() : null)
          : 0,
      interruptedAttempts: bracketed ? interruptedCount(brackets, stage) : 0,
    };
  }

  const runEnd = engagement.completedAt ?? lastActivity(eventRows, transcripts);
  const totals = {
    score: STAGE_IDS.reduce((sum, s) => sum + stages[s].score, 0),
    max: STAGE_IDS.reduce((sum, s) => sum + stages[s].max, 0),
    learnerMessages: STAGE_IDS.reduce((sum, s) => sum + stages[s].learnerMessages, 0),
    personaMessages: STAGE_IDS.reduce((sum, s) => sum + stages[s].personaMessages, 0),
    meteredTokens: meteredTokens(transcripts.flat(), eventRows),
    durationMs: bracketed
      ? activeTimeMs(brackets)
      : runEnd
        ? runEnd.getTime() -
          engagement.createdAt.getTime() -
          overlapMs(failedSpans, engagement.createdAt.getTime(), runEnd.getTime())
        : null,
    failedAttempts: bracketed ? failedCount(brackets) : failuresIn(eventRows, engagement.createdAt.getTime(), null),
    interruptedAttempts: bracketed ? interruptedCount(brackets) : 0,
  };

  const storedElicitation = await storedElicitationEvents([engagement.id]);
  return {
    engagement,
    learnerHash,
    cohortName: cohort?.name ?? "unknown cohort",
    cohortArchived: Boolean(cohort?.archivedAt),
    config,
    scenario,
    isAgent: engagement.mode === "agent",
    kind: runKind(config.showcase, engagement),
    currentIndex,
    personaModel: personaModelFromEvents(eventRows),
    analystModel: analystModelFromEvents(eventRows),
    judgeModel: judgeModelFromScores(scoreRows),
    judgePrompt: judgePromptFromScores(scoreRows),
    auditorPrompt: auditorPromptFromEvents(eventRows),
    personaPrompt: personaPromptFromEvents(eventRows),
    elicitation: summariseElicitation(
      scenario,
      [...eventRows, ...storedElicitation],
      completed ? null : (engagement.currentStage as StageId),
    ),
    elicitationRecorded: elicitationRecorded({
      elicitationTrace: engagement.elicitationTrace,
      createdAt: engagement.createdAt,
      events: [...eventRows, ...storedElicitation],
    }),
    usd: opts.usd ?? null,
    channels: chans.map((c, i) => {
      const persona = scenario.personas.find((p) => p.id === c.personaId);
      return {
        channel: c,
        label: persona?.channelName ?? c.personaId,
        personaName: persona?.name ?? c.personaId,
        messages: transcripts[i],
      };
    }),
    stages,
    totals,
  };
}

// Stage start times from the event log: the engagement starts at the first
// stage, and every advance (judged or instructor-forced) opens the next one.
function stageStarts(engagement: Engagement, events: EventRow[]): Map<StageId, Date> {
  const starts = new Map<StageId, Date>();
  starts.set(STAGE_IDS[0], engagement.createdAt);
  for (const e of events) {
    if (e.type !== "stage_advanced" && e.type !== "stage_forced") continue;
    const to = (e.detailJson as { to?: string } | null)?.to;
    if (!to || !STAGE_IDS.includes(to as StageId)) continue;
    if (!starts.has(to as StageId)) starts.set(to as StageId, new Date(e.timestampIso));
  }
  return starts;
}

function stageEnd(
  stage: StageId,
  starts: Map<StageId, Date>,
  engagement: Engagement,
  events: EventRow[],
): Date | null {
  const from = STAGE_IDS.indexOf(stage);
  for (let i = from + 1; i < STAGE_IDS.length; i++) {
    const next = starts.get(STAGE_IDS[i]);
    if (next) return next;
  }
  if (engagement.status === "completed") {
    const done = events.filter((e) => e.type === "engagement_completed").pop();
    return engagement.completedAt ?? (done ? new Date(done.timestampIso) : null);
  }
  return null;
}

function lastActivity(events: EventRow[], transcripts: Message[][]): Date | null {
  const stamps = [
    ...events.map((e) => e.timestampIso),
    ...transcripts.flatMap((msgs) => msgs.map((m) => m.timestampIso)),
  ].map((iso) => new Date(iso).getTime());
  if (stamps.length === 0) return null;
  return new Date(Math.max(...stamps));
}

// The human run to show beside the given run when none was chosen: the
// cohort's pinned reference run (showcase.comparePair.human) when it is on
// the same scenario, otherwise the furthest-advanced
// human engagement in the same cohort: stage first, then most recently
// started.
export function defaultHuman(all: Row[], beside: Row, pinnedHumanId: string | null): Row | null {
  const pinned = pinnedHumanId ? all.find((r) => r.engagement.id === pinnedHumanId) : undefined;
  if (
    pinned &&
    pinned.engagement.cohortId === beside.engagement.cohortId &&
    pinned.engagement.scenarioId === beside.engagement.scenarioId &&
    pinned.engagement.id !== beside.engagement.id
  ) {
    return pinned;
  }
  return furthestHuman(all, beside);
}

// Furthest-advanced human engagement in the same cohort as the given run:
// stage first, then most recently started.
export function furthestHuman(all: Row[], beside: Row): Row | null {
  const rank = (r: Row) =>
    r.engagement.status === "completed"
      ? STAGE_IDS.length
      : stageIndex(r.engagement.currentStage as StageId);
  const candidates = all.filter(
    (r) =>
      r.engagement.cohortId === beside.engagement.cohortId &&
      r.engagement.mode !== "agent" &&
      r.engagement.id !== beside.engagement.id,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => {
    if (rank(r) !== rank(best)) return rank(r) > rank(best) ? r : best;
    return r.engagement.createdAt > best.engagement.createdAt ? r : best;
  });
}
