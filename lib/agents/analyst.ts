// The analyst agent: an LLM that plays the learner ("consultant") side of an
// engagement for the AgenticPracticum demo. It sees the brief, stage
// guidance, channel transcripts, and profiles of released datasets, never
// persona cards or the world-fact ledger. It cannot run code, so since
// analyst-v2 its artifacts propose analyses and mark what was not executed
// ("Not run: ...") rather than reporting results it never computed, and it
// may only cite numbers from the profiles or the transcripts. Agent runs go
// through the identical persona/gate pipeline (handleLearnerMessage,
// handleGateSubmission), so the compare view contrasts like with like. Since
// 7bbc1dd each action also passes the checks a learner's chat message
// passes in the route (app/api/chat/route.ts): the cohort's daily budget
// before any model call, and the per-engagement message cap before a
// message. Since analyst-v3 a retry after a failed gate sees the agent's own
// previous artifact for the stage and the feedback a learner sees, so the
// retry condition matches a learner's. The prompt text lives in
// lib/agents/prompt-provenance.ts.

import { generateObjectRobust } from "@/lib/llm/structured";
import { usageFromError } from "@/lib/llm/usage";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { engagements, students } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getLLM, DEFAULT_TEMPERATURE, samplingParams } from "@/lib/llm/client";
import { analystMaxTokens } from "@/lib/llm/limits";
import {
  analystModelName as configuredAnalystModel,
  effectiveAnalystModel,
  personaModelName as configuredPersonaModel,
  rubricModelName as configuredRubricModel,
} from "@/lib/llm/model-names";
import { getReleasedFiles } from "@/lib/agents/data-environment";
import { ANALYST_RUN_STARTED_EVENT, runAnalystModelOverride } from "@/lib/agents/analyst-model";
import { handleLearnerMessage } from "@/lib/agents/orchestrator";
import { handleGateSubmission } from "@/lib/agents/stage-gate";
import { profileReleasedDatasets, renderReleasedProfiles } from "@/lib/agents/dataset-profile";
import {
  countLearnerMessages,
  createEngagement,
  getChannels,
  getEngagement,
  getEvents,
  getMessages,
  getRubricScores,
  getSubmissions,
  logEvent,
  type Channel,
  type Engagement,
} from "@/lib/engagement/state";
import { loadScenario } from "@/lib/scenarios/load";
import { stageReached, type Scenario, type StageId } from "@/lib/scenarios/types";
import type { CohortConfig } from "@/lib/cohort/defaults";
import { truncateWords } from "@/lib/admin/format";
import { BUDGET_REFUSED_EVENT, budgetRefusedDetail, checkCohortBudget } from "@/lib/llm/budget";
import { budgetRefusalMessage } from "@/lib/llm/budget-format";
import { learnerMessageCap } from "@/lib/cohort/limits";
import { MESSAGE_CAP_EVENT } from "@/lib/engagement/message-cap";
import {
  ANALYST_MUST_SUBMIT,
  ANALYST_NO_DATA,
  ANALYST_PROMPT_VERSION,
  ANALYST_RETRY_NO_SCORES,
  ANALYST_RETRY_SECTION,
  ANALYST_SYSTEM_TEMPLATE,
  fillPromptTemplate,
} from "@/lib/agents/prompt-provenance";
import { learnerRationaleOf } from "@/lib/agents/rationale-filter";
import { effectiveScore } from "@/lib/engagement/effective-score";

export { ANALYST_PROMPT_VERSION };
// Conversation turns the analyst may spend per stage before it must submit.
export const ANALYST_MAX_MESSAGES_PER_STAGE = 4;
// Hard ceiling on step attempts per stage (guards against a model that keeps
// producing invalid actions).
const STAGE_STEP_BUDGET = ANALYST_MAX_MESSAGES_PER_STAGE * 2 + 4;
// How much of the analyst's own reasoning is kept in the event log.
export const ANALYST_REASONING_MAX_CHARS = 500;
// How much of a failure message is kept in the event log and shown in the UI.
export const ANALYST_ERROR_MAX_CHARS = 300;
// Event type for a stage run that ended in a thrown error.
export const ANALYST_FAILURE_EVENT = "analyst_step_failed";
// The name the same event had before 13eac8d; readers accept both.
export const LEGACY_ANALYST_FAILURE_EVENT = "analyst_stage_failed";
export function isAnalystFailureEvent(type: string): boolean {
  return type === ANALYST_FAILURE_EVENT || type === LEGACY_ANALYST_FAILURE_EVENT;
}

export const AnalystActionSchema = z.object({
  reasoning: z
    .string()
    .describe("One or two sentences on why this action. Audit log only; stakeholders never see it."),
  action: z
    .enum(["message", "submit"])
    .describe("message = write in one unlocked stakeholder channel; submit = deliver the stage-gate artifact."),
  channelPersonaId: z
    .string()
    .nullable()
    .describe("When action=message: the personaId of the unlocked channel to write in. Null when submitting."),
  text: z
    .string()
    .describe("When action=message: the chat message. When action=submit: the complete stage-gate artifact."),
});

export type AnalystAction = z.infer<typeof AnalystActionSchema>;

// The models behind the stakeholder personas and the analyst agent. The
// analyst has its own setting (LLM_ANALYST_MODEL), which defaults to the
// persona model, so an agent run need not be self-play within one model.
// Resolved the same way getLLM() resolves them, so the admin views can name
// the models actually in use.
export function personaModelName(): string {
  return configuredPersonaModel();
}

export function analystModelName(): string {
  return configuredAnalystModel();
}

// The rubric judge's model, resolved as getLLM() resolves it. Scored
// submissions carry judgeModel per row; this covers a run with no scores yet.
export function judgeModelName(): string {
  return configuredRubricModel();
}

/** The detail of an agent-run stage event (analyst_stage_started, a
 * failure logged by the admin page): the analyst model the run uses (its
 * own override when it was started with one, else LLM_ANALYST_MODEL,
 * resolved as getLLM() resolves it) as `model`, with the persona model
 * beside it. The stage bracket used to log the persona model as `model`,
 * which mislabels a cross-model run. */
export function analystStageEventDetail(
  stage: string,
  modelOverride: string | null = null,
): {
  stage: string;
  model: string;
  modelOverride?: string;
  personaModel: string;
  promptVersion: string;
} {
  return {
    stage,
    model: runAnalystModelName(modelOverride),
    ...(modelOverride ? { modelOverride } : {}),
    personaModel: personaModelName(),
    promptVersion: ANALYST_PROMPT_VERSION,
  };
}

/** The analyst model a run uses: its override, else the deployment's
 * analyst model (the mock on the mock provider). */
export function runAnalystModelName(modelOverride: string | null = null): string {
  return modelOverride ? effectiveAnalystModel(modelOverride) : analystModelName();
}

/** Thrown when an agent action is refused by the daily budget. Its name is
 * what the run card shows as the failure class. */
export class AnalystBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageLimit";
  }
}

interface AnalystView {
  scenario: Scenario;
  stageId: StageId;
  unlockedChannels: { channel: Channel; personaId: string }[];
  turnsUsed: number;
  mustSubmit: boolean;
  // The engagement's learner-message cap is spent: the analyst may only
  // submit, as a learner may.
  messageCapReached: boolean;
  system: string;
}

// How much of the previous artifact the retry section carries. The final
// handover asks for up to 1000 words, which fits.
export const ANALYST_PREVIOUS_ARTIFACT_MAX_CHARS = 8000;

/** The agent's latest scored attempt at the current stage that did not
 * pass, with the feedback a learner sees after a failed gate (analyst-v3).
 * `scores` is null when the cohort does not show scores to learners. */
export interface AnalystPreviousAttempt {
  text: string;
  scores:
    | {
        criterionId: string;
        score: number;
        maxScore: number;
        // The learner's copy of the rationale.
        rationale: string;
        improve: string | null;
      }[]
    | null;
}

/** The retry section of the analyst prompt, or "" when there is no failed
 * attempt at this stage. Pure. */
export function renderPreviousAttempt(
  scenario: Scenario,
  stageId: StageId,
  attempt: AnalystPreviousAttempt | null | undefined,
): string {
  if (!attempt) return "";
  const stage = scenario.stages.find((s) => s.id === stageId);
  let feedback = ANALYST_RETRY_NO_SCORES;
  if (attempt.scores) {
    const total = attempt.scores.reduce((n, r) => n + r.score, 0);
    const max = attempt.scores.reduce((n, r) => n + r.maxScore, 0);
    const lines = attempt.scores.map((r) => {
      const criterion = stage?.gate.rubric.find((c) => c.id === r.criterionId);
      const label = criterion?.learnerText.trim() ?? r.criterionId;
      const improve = r.improve && r.score < r.maxScore ? ` To improve: ${r.improve.trim()}` : "";
      return `- ${label} ${r.score} of ${r.maxScore}. ${r.rationale.trim()}${improve}`;
    });
    feedback = [`Score: ${total} of ${max}.`, ...lines].join("\n");
  }
  const text =
    attempt.text.length > ANALYST_PREVIOUS_ARTIFACT_MAX_CHARS
      ? `${attempt.text.slice(0, ANALYST_PREVIOUS_ARTIFACT_MAX_CHARS).trimEnd()} [shortened]`
      : attempt.text.trim();
  return fillPromptTemplate(ANALYST_RETRY_SECTION, {
    "gate kind": stage?.gate.kind ?? "artifact",
    "criterion feedback": feedback,
    "previous artifact": text,
  });
}

// Pure prompt builder, deliberately DB-free so the containment invariant is
// unit-testable: its inputs are only learner-visible material. There is no
// worldFacts or persona-card parameter at all; cards and the ledger cannot
// leak because the builder never receives them.
export function buildAnalystSystemPrompt(input: {
  scenario: Scenario;
  stageId: StageId;
  channels: { personaId: string; unlocked: boolean }[];
  transcripts: { personaId: string; lines: { sender: string; content: string }[] }[];
  profilesText: string;
  turnsUsed: number;
  // The engagement's message cap is spent (defaults to false).
  messageCapReached?: boolean;
  // The latest failed attempt at this stage, when there is one (analyst-v3).
  previousAttempt?: AnalystPreviousAttempt | null;
}): string {
  const { scenario, stageId, channels: chanStates, transcripts, profilesText, turnsUsed } = input;
  const stage = scenario.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`Scenario ${scenario.id} has no stage ${stageId}`);
  const mustSubmit = turnsUsed >= ANALYST_MAX_MESSAGES_PER_STAGE || input.messageCapReached === true;

  const channelLines = chanStates
    .map((c) => {
      const persona = scenario.personas.find((p) => p.id === c.personaId);
      const state = c.unlocked ? "unlocked" : "locked";
      return `- ${persona?.channelName ?? c.personaId} · personaId: ${c.personaId} · role: ${persona?.role ?? "unknown"} · ${state}`;
    })
    .join("\n");

  const transcriptBlocks = transcripts
    .map((t) => {
      const persona = scenario.personas.find((p) => p.id === t.personaId);
      if (t.lines.length === 0) return null;
      const lines = t.lines
        .slice(-20)
        .map((m) => `${m.sender === "learner" ? "You" : persona?.name ?? m.sender}: ${m.content}`)
        .join("\n");
      return `## ${persona?.channelName ?? t.personaId}\n${lines}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return fillPromptTemplate(ANALYST_SYSTEM_TEMPLATE, {
    "engagement brief": scenario.brief.trim(),
    "stage title": stage.title,
    "stage guidance": stage.guidance.trim(),
    "gate kind": stage.gate.kind,
    "gate instructions": stage.gate.instructions.trim(),
    "turns used": String(turnsUsed),
    "turn cap": String(ANALYST_MAX_MESSAGES_PER_STAGE),
    "must submit": mustSubmit ? ANALYST_MUST_SUBMIT : "",
    channels: channelLines,
    conversations: transcriptBlocks || "None yet.",
    "previous attempt": renderPreviousAttempt(scenario, stageId, input.previousAttempt),
    "released data": profilesText || ANALYST_NO_DATA,
  }).replace(/\n{3,}/g, "\n\n");
}

/** The agent's latest scored submission at the stage, when it did not pass
 * the gate, with the feedback a learner would see. Pure. */
export function latestFailedAttempt(input: {
  stageId: StageId;
  submissions: readonly {
    id: string;
    stage: string;
    status: string;
    contentText: string;
    gatePassed?: boolean | null;
  }[];
  scores: readonly {
    submissionId: string;
    criterionId: string;
    score: number;
    maxScore: number;
    rationale: string;
    learnerRationale?: string | null;
    improve?: string | null;
    overrideScore?: number | null;
  }[];
  showScores: boolean;
}): AnalystPreviousAttempt | null {
  const scored = input.submissions.filter((s) => s.stage === input.stageId && s.status === "scored");
  const last = scored[scored.length - 1];
  if (!last || last.gatePassed === true) return null;
  const rows = input.scores.filter((r) => r.submissionId === last.id);
  return {
    text: last.contentText,
    scores: input.showScores
      ? rows.map((r) => {
          const score = effectiveScore({ score: r.score, maxScore: r.maxScore, overrideScore: r.overrideScore ?? null });
          return {
            criterionId: r.criterionId,
            score,
            maxScore: r.maxScore,
            rationale: learnerRationaleOf(r),
            improve: score >= r.maxScore ? null : (r.improve ?? null),
          };
        })
      : null,
  };
}

// Gathers the learner-visible state from the database and delegates to the
// pure prompt builder above.
export async function buildAnalystView(
  engagement: Engagement,
  scenario: Scenario,
  config?: CohortConfig,
): Promise<AnalystView> {
  const stageId = engagement.currentStage as StageId;

  const chans = await getChannels(engagement.id);
  const allTranscripts = await Promise.all(chans.map((c) => getMessages(c.id)));
  const unlockedChannels = chans
    .filter((c) => c.unlockedAt !== null)
    .map((c) => ({ channel: c, personaId: c.personaId }));

  const turnsUsed = await countAnalystTurnsThisStage(engagement.id, stageId);
  const messageCapReached = config
    ? (await countLearnerMessages(engagement.id)) >= learnerMessageCap(config, "agent")
    : false;
  const mustSubmit = turnsUsed >= ANALYST_MAX_MESSAGES_PER_STAGE || messageCapReached;

  const releasedFiles = await getReleasedFiles(engagement.id);
  const profiles = await profileReleasedDatasets(engagement, scenario, releasedFiles);

  // A retry after a failed gate sees what a learner sees (analyst-v3).
  const [submissions, scores] = await Promise.all([getSubmissions(engagement.id), getRubricScores(engagement.id)]);
  const previousAttempt = latestFailedAttempt({
    stageId,
    submissions,
    scores,
    showScores: config?.ui.showRubricScores ?? true,
  });

  const system = buildAnalystSystemPrompt({
    scenario,
    stageId,
    channels: chans.map((c) => ({ personaId: c.personaId, unlocked: c.unlockedAt !== null })),
    transcripts: chans.map((c, i) => ({
      personaId: c.personaId,
      lines: c.unlockedAt
        ? allTranscripts[i].map((m) => ({ sender: m.sender, content: m.content }))
        : [],
    })),
    // The same profile text the ledger holds for the judge (one profile for
    // both).
    profilesText: renderReleasedProfiles(profiles, scenario.datasets),
    turnsUsed,
    messageCapReached,
    previousAttempt,
  });

  return { scenario, stageId, unlockedChannels, turnsUsed, mustSubmit, messageCapReached, system };
}

// Counts the analyst's own messages in the current stage from analyst_step
// events (each executed message step logs one).
async function countAnalystTurnsThisStage(engagementId: string, stageId: StageId): Promise<number> {
  const evts = await getEvents(engagementId);
  return evts.filter((e) => {
    if (e.type !== "analyst_step") return false;
    const d = e.detailJson as { action?: string; stage?: string } | null;
    return d?.action === "message" && d?.stage === stageId;
  }).length;
}

export interface AnalystStepResult {
  status: "messaged" | "submitted" | "rejected";
  action?: AnalystAction;
  advanced?: boolean;
  engagementCompleted?: boolean;
}

// One analyst decision + execution. Invalid actions (locked/unknown channel,
// message after the cap) are logged and rejected, never coerced, so the
// demo shows real agent behaviour, not stage-managed behaviour.
export async function runAnalystStep(input: {
  engagement: Engagement;
  scenario: Scenario;
  config: CohortConfig;
  /** The run's own analyst model (analyst_run_started modelOverride), or
   * null for the deployment's analyst model. */
  analystModelOverride?: string | null;
}): Promise<AnalystStepResult> {
  const { engagement, scenario, config } = input;
  const modelOverride = input.analystModelOverride ?? null;
  const view = await buildAnalystView(engagement, scenario, config);

  // The budget check a learner's chat message passes, per action rather
  // than once per stage: each action makes model calls (the analyst's own,
  // then a persona turn or the judge and a reaction).
  const budget = await checkCohortBudget({ id: engagement.cohortId, config });
  if (!budget.ok) {
    await logEvent(
      engagement.id,
      engagement.cohortId,
      BUDGET_REFUSED_EVENT,
      budgetRefusedDetail(budget, "agent", view.stageId),
    );
    throw new AnalystBudgetError(budgetRefusalMessage("agent", null));
  }

  const { object: action, usage } = await generateObjectRobust(
    {
      model: modelOverride ? getLLM().analystModelFor(modelOverride) : getLLM().analystModel,
      schema: AnalystActionSchema,
      system: view.system,
      prompt: view.mustSubmit
        ? `Submit the ${scenario.stages.find((s) => s.id === view.stageId)?.gate.kind ?? "artifact"} for this stage now.`
        : `Decide your next single action for this stage.`,
      maxTokens: analystMaxTokens(),
      ...samplingParams(DEFAULT_TEMPERATURE),
    },
    { callSite: "analyst.step" },
  );

  const base = {
    stage: view.stageId,
    model: runAnalystModelName(modelOverride),
    ...(modelOverride ? { modelOverride } : {}),
    promptVersion: ANALYST_PROMPT_VERSION,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    reasoning: truncateWords(action.reasoning, ANALYST_REASONING_MAX_CHARS),
  };

  if (action.action === "message") {
    const target = view.unlockedChannels.find((c) => c.personaId === action.channelPersonaId);
    // The engagement's learner-message cap, checked as the chat route
    // checks it, just before the message would go out.
    const cap = learnerMessageCap(config, "agent");
    const sent = await countLearnerMessages(engagement.id);
    const capReached = sent >= cap;
    if (capReached && target) {
      await logEvent(engagement.id, engagement.cohortId, MESSAGE_CAP_EVENT, {
        channelId: target.channel.id,
        personaId: target.personaId,
        stage: view.stageId,
        cap,
        sent,
        via: "agent",
      });
    }
    if (view.mustSubmit || !target || capReached) {
      await logEvent(engagement.id, engagement.cohortId, "analyst_step_rejected", {
        ...base,
        action: "message",
        channelPersonaId: action.channelPersonaId,
        reason: capReached
          ? "message-cap-reached"
          : view.mustSubmit
            ? "turn-cap-reached"
            : "unknown-or-locked-channel",
      });
      return { status: "rejected", action };
    }
    // The step event goes in before the persona turn runs, mirroring the
    // submit path below: the log then reads in causal order: the analyst
    // stated its purpose, then the persona replied (and any data_released
    // events landed), never the reverse.
    await logEvent(engagement.id, engagement.cohortId, "analyst_step", {
      ...base,
      action: "message",
      channelPersonaId: target.personaId,
    });
    await handleLearnerMessage({
      engagement,
      channel: target.channel,
      scenario,
      config,
      text: action.text,
    });
    return { status: "messaged", action };
  }

  // The step event goes in before the gate runs so the log reads in causal
  // order: the analyst decided to submit, then the judge scored it. The
  // outcome itself is recorded by the gate pipeline's own submission_scored
  // and stage_advanced events, which land after this one.
  await logEvent(engagement.id, engagement.cohortId, "analyst_step", {
    ...base,
    action: "submit",
  });
  const outcome = await handleGateSubmission({
    engagement,
    scenario,
    config,
    text: action.text,
  });
  return {
    status: "submitted",
    action,
    advanced: outcome.advanced,
    engagementCompleted: outcome.engagementCompleted,
  };
}

export interface AnalystFailure {
  // Error class name, e.g. AI_NoObjectGeneratedError, the useful part when a
  // structured-output call comes back unparseable.
  errorClass: string;
  message: string;
  stage: StageId;
  step: number;
}

export interface AnalystStageResult {
  steps: number;
  advanced: boolean;
  engagementCompleted: boolean;
  endStage: StageId;
  // Set when a step threw. The stage run stops there; the caller shows it.
  failure?: AnalystFailure;
}

// Names an unknown thrown value. The AI SDK sets `name` on its error classes
// (AI_NoObjectGeneratedError, AI_APICallError), which is what an instructor
// needs to tell "the model returned junk" from "the provider is down".
export function describeError(err: unknown): { errorClass: string; message: string } {
  if (err instanceof Error) {
    return {
      errorClass: err.name || "Error",
      message: truncateWords(err.message || String(err), ANALYST_ERROR_MAX_CHARS),
    };
  }
  return { errorClass: typeof err, message: truncateWords(String(err), ANALYST_ERROR_MAX_CHARS) };
}

// Drives the analyst through the engagement's current stage: message turns,
// then the gate submission, stopping when the stage advances (or the step
// budget runs out, which is surfaced rather than hidden).
export async function runAnalystStage(engagementId: string, config: CohortConfig): Promise<AnalystStageResult> {
  let engagement = await getEngagement(engagementId);
  if (!engagement) throw new Error(`Unknown engagement ${engagementId}`);
  if (engagement.mode !== "agent") throw new Error("Not an analyst-agent engagement");
  if (engagement.status !== "active") {
    return {
      steps: 0,
      advanced: false,
      engagementCompleted: engagement.status === "completed",
      endStage: engagement.currentStage as StageId,
    };
  }
  const scenario = await loadScenario(engagement.scenarioId);
  const startStage = engagement.currentStage as StageId;
  // The run's own analyst model, chosen when it was started.
  const modelOverride = runAnalystModelOverride(await getEvents(engagementId));

  let steps = 0;
  let advanced = false;
  let engagementCompleted = false;
  let failure: AnalystFailure | undefined;
  while (steps < STAGE_STEP_BUDGET) {
    steps++;
    // A step can throw for reasons outside our control: the model returns an
    // object that does not parse, the provider rate-limits, the request times
    // out. None of those may pass silently: a demo audience cannot tell a
    // silent failure from a successful run, so the failure is logged as an
    // event and returned for the UI to show.
    let result: AnalystStepResult;
    try {
      result = await runAnalystStep({ engagement, scenario, config, analystModelOverride: modelOverride });
    } catch (err) {
      const described = describeError(err);
      const currentStage = (engagement.currentStage as StageId) ?? startStage;
      failure = { ...described, stage: currentStage, step: steps };
      // The failed call's tokens (an answer that did not parse still cost
      // them) are metered here, unless the error came from a persona turn
      // that already logged them as persona_failed.
      const usage = usageFromError(err);
      await logEvent(engagement.id, engagement.cohortId, ANALYST_FAILURE_EVENT, {
        stage: currentStage,
        step: steps,
        model: runAnalystModelName(modelOverride),
        ...(modelOverride ? { modelOverride } : {}),
        promptVersion: ANALYST_PROMPT_VERSION,
        errorClass: described.errorClass,
        message: described.message,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
      break;
    }
    if (result.status === "submitted") {
      advanced = result.advanced ?? false;
      engagementCompleted = result.engagementCompleted ?? false;
      if (advanced) break;
      // Gate not passed: the analyst retries within the stage (fresh view
      // includes the client's in-character reaction).
    }
    engagement = (await getEngagement(engagementId))!;
    if ((engagement.currentStage as StageId) !== startStage || engagement.status !== "active") break;
  }

  engagement = (await getEngagement(engagementId))!;
  return {
    steps,
    advanced,
    engagementCompleted: engagementCompleted || engagement.status === "completed",
    endStage: engagement.currentStage as StageId,
    failure,
  };
}

// Creates a synthetic pseudonymous "student" and an agent-mode engagement in
// the cohort. The one-active-engagement-per-student guard keeps applying per
// synthetic identity, so agent runs never block human learners.
//
// `analystModel` starts the run on another analyst model than the
// deployment's (validated by the caller with analystModelOverrideProblem);
// it is recorded as modelOverride on analyst_run_started, which every stage
// of the run reads back.
export async function startAnalystRun(
  cohortId: string,
  scenarioId: string,
  opts: { analystModel?: string | null } = {},
): Promise<Engagement> {
  const scenario = await loadScenario(scenarioId);
  const modelOverride = opts.analystModel?.trim() || null;
  const [student] = await db
    .insert(students)
    .values({
      cohortId,
      learnerHash: `agent:${crypto.randomUUID()}`,
      profileJson: {
        kind: "analyst-agent",
        promptVersion: ANALYST_PROMPT_VERSION,
        ...(modelOverride ? { analystModel: modelOverride } : {}),
      },
    })
    .returning();

  const engagement = await createEngagement(cohortId, student.id, scenario);
  await db.update(engagements).set({ mode: "agent" }).where(eq(engagements.id, engagement.id));
  await logEvent(engagement.id, cohortId, ANALYST_RUN_STARTED_EVENT, {
    scenarioId,
    model: runAnalystModelName(modelOverride),
    ...(modelOverride ? { modelOverride } : {}),
    promptVersion: ANALYST_PROMPT_VERSION,
  });
  return (await getEngagement(engagement.id))!;
}

// Sanity guard used by the admin UI: the first unlocked channel exists at the
// first stage for every shipped scenario, so a just-started run can always act.
export function scenarioSupportsAgentRun(scenario: Scenario): boolean {
  return scenario.personas.some((p) => stageReached("formulation", p.unlockedAtStage));
}
