// Stage-gate handling: store the submitted artifact, score it against the
// stage rubric, decide whether the pipeline advances per the cohort's gate
// policy, and have the client sponsor react in character in their channel
// (a structured persona call, like a chat turn).

import { and, eq } from "drizzle-orm";
import { generateObjectRobust } from "@/lib/llm/structured";
import { db } from "@/lib/db/client";
import { rubricScores, submissions } from "@/lib/db/schema";
import { getLLM, samplingParams } from "@/lib/llm/client";
import { reactionMaxTokens } from "@/lib/llm/limits";
import { personaModelName, servedModelId } from "@/lib/llm/model-names";
import {
  auditIfSampled,
  FailedCalls,
  generateStyledPersonaObject,
  logFrictions,
  logHalfRaisedFrictions,
  logOutputRepairs,
  logStyleRetry,
  withPersonaRetry,
} from "@/lib/agents/orchestrator";
import { addUsage } from "@/lib/llm/usage";
import { usageFromError } from "@/lib/llm/usage";
import {
  buildPersonaSystemPrompt,
  buildReactionPrompt,
  filterReactionFacts,
  PERSONA_PROMPT_VERSION,
  PersonaReactionSchema,
  pickReactionVariant,
  validRevealedIds,
  type ReactionOutcome,
} from "@/lib/agents/persona";
import {
  frictionsHalfRaised,
  frictionsOpeningAt,
  frictionsReportedAndRaised,
  pendingFrictions,
} from "@/lib/agents/frictions";
import {
  detectUnreportedReveals,
  getConversationRecord,
  getSharedFactIds,
  markEarlyDisclosures,
  recordRevealsInReply,
} from "@/lib/engagement/elicitation";
import { stageMessageCountFact } from "@/lib/engagement/conversation-record";
import { keysNamed, unraisedFactKeys, withoutFactSentences } from "@/lib/agents/rationale-filter";
import { reactionAuditMessage, reactionExcerpt } from "@/lib/agents/reaction-excerpt";
import {
  blockedWithheld,
  unmetWithheld,
  WITHHELD_LEAK_EVENT,
  withheldLeakNote,
} from "@/lib/agents/withheld-guard";
import {
  CRITERION_SKIPPED_EVENT,
  fillPromptTemplate,
  JUDGE_STYLE_RETRY_EVENT,
  NO_EXCHANGE_CAP_EVENT,
  NOT_RUN_CAP_EVENT,
  PERSONA_REACTION_LEAK_FALLBACK,
  PERSONA_REACTION_LEAK_RETRY,
  STATED_NOT_ELICITED_EVENT,
  SUBMISSION_FLAGGED_EVENT,
  UNVERIFIED_CLAIM_EVENT,
} from "@/lib/agents/prompt-provenance";
import { scoreSubmission, type RubricResult } from "@/lib/agents/rubric";
import { decideGate, type GateDecision } from "@/lib/engagement/gate-policy";
import {
  advanceStage,
  appendMessage,
  appendWorldFacts,
  completeEngagement,
  countLearnerMessages,
  getChannels,
  getLedger,
  getMessages,
  logEvent,
  type Engagement,
} from "@/lib/engagement/state";
import type { CohortConfig } from "@/lib/cohort/defaults";
import type { LedgerFact } from "@/lib/engagement/provenance";
import { nextStage, type Scenario, type StageId } from "@/lib/scenarios/types";

export interface GateOutcome {
  submissionId: string;
  rubric: RubricResult;
  scoreRatio: number;
  passed: boolean | null;
  reason: GateDecision["reason"];
  minScoreRatio: number | null;
  advanced: boolean;
  engagementCompleted: boolean;
  newStage: StageId | null;
  attempt: number;
  /** Whether the client sponsor's reaction actually reached their channel.
   * The result banner promises a reaction, so it may only promise one when
   * the message was persisted. */
  clientReacted: boolean;
  /** The scores as a learner may see them: the filtered rationale and none
   * of the instructor-only fields (raw score, unverified flag and note).
   * Learner-facing routes return these rather than rubric.scores. */
  learnerScores: LearnerCriterionScore[];
}

export interface LearnerCriterionScore {
  criterionId: string;
  score: number;
  maxScore: number;
  rationale: string;
  improve: string | null;
}

/** The learner's projection of the judge's scores. Pure. */
export function toLearnerScores(rubric: RubricResult): LearnerCriterionScore[] {
  return rubric.scores.map((s) => ({
    criterionId: s.criterionId,
    score: s.score,
    maxScore: s.maxScore,
    rationale: s.learnerRationale ?? s.rationale,
    improve: s.improve ?? null,
  }));
}

// Logged when the sponsor's reaction does not reach the channel, so a
// missing reaction is visible in the event log rather than only on screen.
export const CLIENT_REACTION_FAILED_EVENT = "client_reaction_failed";

// How many recent messages from the sponsor's channel accompany the reaction
// prompt. Without them the sponsor re-opened concessions he had made a stage
// earlier; a handful of turns keeps settled points settled without bloating
// the prompt.
const REACTION_CONTEXT_TURNS = 5;

// Cap per quoted message: the reaction needs the gist of recent turns, not a
// full transcript.
const REACTION_CONTEXT_CHARS = 500;

export async function handleGateSubmission(input: {
  engagement: Engagement;
  scenario: Scenario;
  config: CohortConfig;
  text: string;
  // Optional learner reflection stored with the artifact; never scored.
  reflection?: string;
}): Promise<GateOutcome> {
  const { engagement, scenario, config, text, reflection } = input;
  const stageId = engagement.currentStage as StageId;
  const stage = scenario.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`Scenario ${scenario.id} has no stage ${stageId}`);

  const attempt = (await countScoredAttempts(engagement.id, stageId)) + 1;

  const [submission] = await db
    .insert(submissions)
    .values({
      engagementId: engagement.id,
      stage: stageId,
      kind: stage.gate.kind,
      contentText: text,
      reflectionText: reflection ?? null,
    })
    .returning();

  const ledger = await getLedger(engagement.id);
  // The judge reads the message counts per stakeholder, the facts obtained
  // and the stakeholder transcripts.
  const conversation = await getConversationRecord(engagement, scenario, stageId);
  let rubric: RubricResult;
  try {
    rubric = await scoreSubmission({
      scenario,
      stage,
      submissionText: text,
      ledger,
      mode: engagement.mode === "agent" ? "agent" : "human",
      conversation,
    });
  } catch (err) {
    // A judge failure must not cost the learner an attempt: the row is
    // marked failed, attempts count only scored rows, and an instructor can
    // rescore it later (lib/agents/rescore.ts).
    await markScoringFailed(engagement, submission.id, stageId, err);
    throw err;
  }

  await recordRubricScores(engagement, submission.id, stageId, rubric);

  const gateResult = await applyGateDecision({
    engagement,
    scenario,
    config,
    stageId,
    submissionId: submission.id,
    attempt,
    rubric,
  });
  const { passed, advanced, reason, scoreRatio, newStage, engagementCompleted } = gateResult;
  const gate = config.gates;

  const clientReacted = await postClientReaction({
    engagement,
    scenario,
    config,
    stage: stageId,
    stageTitle: stage.title,
    artifactKind: stage.gate.kind,
    submissionText: text,
    // The ledger as it stood when the artifact landed. On the advancing path
    // the block above has already written "the engagement moved on" into it,
    // and prompting the sponsor to acknowledge a delivery the shared record
    // reports as settled is what made the pass-path reaction unreliable.
    ledger,
    advanced,
    reason,
    engagementCompleted,
    newStage,
  });

  return {
    submissionId: submission.id,
    rubric,
    scoreRatio,
    passed,
    reason,
    minScoreRatio: gate.minScoreRatio,
    advanced,
    engagementCompleted,
    newStage,
    attempt,
    clientReacted,
    learnerScores: toLearnerScores(rubric),
  };
}

// Scored attempts at a stage. Rows left pending (a crashed request) or marked
// failed (the judge call threw) are not attempts: the learner never got a
// verdict for them.
export async function countScoredAttempts(engagementId: string, stageId: string): Promise<number> {
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.engagementId, engagementId),
        eq(submissions.stage, stageId),
        eq(submissions.status, "scored"),
      ),
    );
  return rows.length;
}

export const SCORING_FAILED_EVENT = "submission_scoring_failed";

export { UNVERIFIED_CLAIM_EVENT };

export { CRITERION_SKIPPED_EVENT };

export async function markScoringFailed(
  engagement: Engagement,
  submissionId: string,
  stageId: string,
  err: unknown,
): Promise<void> {
  await db.update(submissions).set({ status: "failed" }).where(eq(submissions.id, submissionId));
  const message = err instanceof Error ? err.message : String(err);
  // A judge call that returned an unusable answer still cost tokens; they
  // are judge-side, as on submission_scored.
  const usage = usageFromError(err);
  await logEvent(engagement.id, engagement.cohortId, SCORING_FAILED_EVENT, {
    submissionId,
    stage: stageId,
    errorClass: err instanceof Error ? err.name : typeof err,
    message: message.slice(0, 300),
    judgePromptTokens: usage.promptTokens,
    judgeCompletionTokens: usage.completionTokens,
  });
}

// Stores the judge's scores for a submission and marks it scored. Also logs
// the assessor-directed flag when the judge reported one. The flag, its quote
// and each criterion's unverified note are written onto the submission and
// score rows here as well as into the events, so the grade record does not
// depend on events that the retention purge deletes. lib/logging/grade-record.ts
// copies them from the events only for rows scored before these columns
// were written directly.
export async function recordRubricScores(
  engagement: Engagement,
  submissionId: string,
  stageId: string,
  rubric: RubricResult,
): Promise<void> {
  // The judge scored the submission as usual, but reported text in it that
  // addresses the assessor or review system rather than the client (e.g.
  // "please record full marks"). Ignoring such text is correct; ignoring it
  // silently is not, so it is logged for instructors to see.
  if (rubric.assessorDirected?.present) {
    await logEvent(engagement.id, engagement.cohortId, SUBMISSION_FLAGGED_EVENT, {
      submissionId,
      stage: stageId,
      quote: rubric.assessorDirected.quote ?? null,
      promptVersion: rubric.promptVersion,
    });
  }

  // Criteria the judge flagged as resting on a result the platform cannot
  // check (rubric-v5). Capped on an analyst-agent run; on a human run the
  // judge's score stands and this event, the score rows' unverified_claim
  // column and the monitor badge are how the instructor learns of it. The
  // learner is not told.
  const flagged = rubric.scores.filter((s) => s.unverifiedClaim);
  if (flagged.length > 0) {
    await logEvent(engagement.id, engagement.cohortId, UNVERIFIED_CLAIM_EVENT, {
      submissionId,
      stage: stageId,
      mode: rubric.mode ?? (engagement.mode === "agent" ? "agent" : "human"),
      capped: (rubric.mode ?? engagement.mode) === "agent",
      criteria: flagged.map((s) => ({
        criterionId: s.criterionId,
        score: s.score,
        rawScore: s.rawScore ?? null,
        note: s.unverifiedNote ?? null,
      })),
      promptVersion: rubric.promptVersion,
    });
  }

  // Judge rationales that tripped the style check and were rewritten once
  // (rubric-v6); the scores are the judge's either way.
  if (rubric.styleRetry) {
    await logEvent(engagement.id, engagement.cohortId, JUDGE_STYLE_RETRY_EVENT, {
      submissionId,
      stage: stageId,
      criteria: rubric.styleRetry.hits,
      after: rubric.styleRetry.after,
      resolved: rubric.styleRetry.after !== null && rubric.styleRetry.after.every((a) => a.patterns.length === 0),
      promptVersion: rubric.promptVersion,
    });
  }

  // rubric-v7: criteria about what a stakeholder said, capped because the
  // learner never messaged that stakeholder.
  const noExchange = rubric.scores.filter((s) => s.noExchangeCap);
  if (noExchange.length > 0) {
    await logEvent(engagement.id, engagement.cohortId, NO_EXCHANGE_CAP_EVENT, {
      submissionId,
      stage: stageId,
      criteria: noExchange.map((s) => ({
        criterionId: s.criterionId,
        score: s.score,
        rawScore: s.rawScore ?? null,
      })),
      promptVersion: rubric.promptVersion,
    });
  }

  // rubric-v8: criteria whose result the submission marks as not run,
  // capped in learner and agent runs alike.
  const notRun = rubric.scores.filter((s) => s.notRunCap);
  if (notRun.length > 0) {
    await logEvent(engagement.id, engagement.cohortId, NOT_RUN_CAP_EVENT, {
      submissionId,
      stage: stageId,
      mode: rubric.mode ?? (engagement.mode === "agent" ? "agent" : "human"),
      criteria: notRun.map((s) => ({
        criterionId: s.criterionId,
        score: s.score,
        rawScore: s.rawScore ?? null,
      })),
      promptVersion: rubric.promptVersion,
    });
  }

  // rubric-v7: withheld values the submission states that the trace does
  // not show as obtained. Stored on the score rows as well, for the
  // instructor; the learner is not told.
  const stated = rubric.scores.filter((s) => (s.statedNotElicited ?? []).length > 0);
  if (stated.length > 0) {
    await logEvent(engagement.id, engagement.cohortId, STATED_NOT_ELICITED_EVENT, {
      submissionId,
      stage: stageId,
      criteria: stated.map((s) => ({
        criterionId: s.criterionId,
        factIds: s.statedNotElicited,
      })),
      promptVersion: rubric.promptVersion,
    });
  }

  for (const criterionId of rubric.skippedCriteria ?? []) {
    await logEvent(engagement.id, engagement.cohortId, CRITERION_SKIPPED_EVENT, {
      submissionId,
      stage: stageId,
      criterionId,
      judgeModel: rubric.judgeModel,
      promptVersion: rubric.promptVersion,
    });
  }

  await db.insert(rubricScores).values(
    rubric.scores.map((s) => ({
      submissionId,
      engagementId: engagement.id,
      criterionId: s.criterionId,
      score: s.score,
      maxScore: s.maxScore,
      rationale: s.rationale,
      learnerRationale: s.learnerRationale ?? null,
      improve: s.improve ?? null,
      unverifiedClaim: s.unverifiedClaim ?? null,
      rawScore: s.rawScore ?? null,
      unverifiedNote: s.unverifiedClaim ? (s.unverifiedNote ?? null) : null,
      statedNotElicited: s.statedNotElicited ?? null,
      judgeModel: rubric.judgeModel,
      promptVersion: rubric.promptVersion,
      servedModel: rubric.servedModel ?? null,
    })),
  );
  const assessorDirected = rubric.assessorDirected?.present === true;
  await db
    .update(submissions)
    .set({
      status: "scored",
      assessorDirected,
      assessorQuote: assessorDirected ? (rubric.assessorDirected?.quote ?? null) : null,
    })
    .where(eq(submissions.id, submissionId));
}

export interface AppliedGate {
  passed: boolean | null;
  advanced: boolean;
  reason: GateDecision["reason"];
  scoreRatio: number;
  newStage: StageId | null;
  engagementCompleted: boolean;
}

// Applies the cohort's gate policy to a scored submission at the stage the
// engagement is on, logs submission_scored, and advances the pipeline when
// the policy says so. The gate reads the judge's score: an instructor
// override adjusts the grade (lib/engagement/effective-score.ts), not a
// decision already taken.
export async function applyGateDecision(input: {
  engagement: Engagement;
  scenario: Scenario;
  config: CohortConfig;
  stageId: StageId;
  submissionId: string;
  attempt: number;
  rubric: RubricResult;
  extraDetail?: Record<string, unknown>;
}): Promise<AppliedGate> {
  const { engagement, scenario, config, stageId, submissionId, attempt, rubric } = input;
  const stage = scenario.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`Scenario ${scenario.id} has no stage ${stageId}`);

  const total = rubric.scores.reduce((s, r) => s + r.score, 0);
  const max = rubric.scores.reduce((s, r) => s + r.maxScore, 0);
  const scoreRatio = max > 0 ? total / max : 0;

  const gate = config.gates;
  const { passed, advanced, reason } = decideGate({
    scoreRatio,
    minScoreRatio: gate.minScoreRatio,
    attempt,
    maxRetries: gate.maxRetries,
  });

  await logEvent(engagement.id, engagement.cohortId, "submission_scored", {
    submissionId,
    stage: stageId,
    kind: stage.gate.kind,
    attempt,
    scoreRatio: Math.round(scoreRatio * 1000) / 1000,
    passed,
    minScoreRatio: gate.minScoreRatio,
    advanced,
    judgeModel: rubric.judgeModel,
    servedModel: rubric.servedModel ?? null,
    promptVersion: rubric.promptVersion,
    judgePromptTokens: rubric.promptTokens,
    judgeCompletionTokens: rubric.completionTokens,
    ...(input.extraDetail ?? {}),
  });
  // The same decision on the submission row, which the purge keeps.
  await db
    .update(submissions)
    .set({ attempt, gatePassed: passed, gateAdvanced: advanced })
    .where(eq(submissions.id, submissionId));

  let newStage: StageId | null = null;
  let engagementCompleted = false;

  if (advanced) {
    newStage = nextStage(stageId);
    // The stage's message counts per open channel go into the record with
    // the delivery (rubric-v7), so later judges and personas can read how
    // much of the stage was conversation.
    const conversation = await getConversationRecord(engagement, scenario, stageId);
    await appendWorldFacts(engagement.id, stageId, "system", [
      `The consultant delivered the ${stage.gate.kind} for the "${stage.title}" stage and the engagement moved on.`,
      stageMessageCountFact(conversation.personas, stageId),
    ]);
    if (newStage) {
      await advanceStage(engagement.id, newStage, scenario);
      await logEvent(engagement.id, engagement.cohortId, "stage_advanced", { from: stageId, to: newStage });
    } else {
      await completeEngagement(engagement.id);
      engagementCompleted = true;
      await logEvent(engagement.id, engagement.cohortId, "engagement_completed", {});
    }
  }

  return { passed, advanced, reason, scoreRatio, newStage, engagementCompleted };
}

// The client sponsor reacts to the delivered artifact in their channel, in
// character and without revealing rubric scores (stakeholders react to the
// content, not to the grade). The reaction takes the same path as a chat
// turn: one structured persona call that returns
// the reply and any new facts, which join the ledger, and the reply is
// eligible for the consistency audit. A failed reaction never blocks the
// submission, but it is logged and reported back so the result banner does
// not promise a message that is not there.
export const CLIENT_REACTION_EVENT = "client_reaction";

// Logged when the sponsor's reaction named a withheld fact or undocumented
// defect that the document does not mention (persona-v5).
export const REACTION_LEAK_EVENT = "reaction_leak_filtered";

async function postClientReaction(input: {
  engagement: Engagement;
  scenario: Scenario;
  config: CohortConfig;
  stage: StageId;
  stageTitle: string;
  artifactKind: string;
  submissionText: string;
  // The ledger as it stood when the artifact landed.
  ledger: LedgerFact[];
  advanced: boolean;
  reason: GateDecision["reason"];
  engagementCompleted: boolean;
  // The stage the gate opened, when it advanced.
  newStage?: StageId | null;
}): Promise<boolean> {
  const { engagement, scenario, config } = input;
  const client = scenario.personas.find((p) => p.role === "client-sponsor");
  if (!client) return false;
  // Failed reaction calls are metered as persona_failed (kind "reaction").
  const failed = new FailedCalls();

  try {
    const channel = (await getChannels(engagement.id)).find((c) => c.personaId === client.id);
    if (!channel) throw new Error(`No channel for client sponsor ${client.id}`);
    const ledgerFacts = input.ledger.map((f) => f.fact);
    // The reaction that opens a stage brings that stage's pressures, so the
    // scope request arrives before the stage's report is written rather than
    // in the reaction to it.
    const frictionStage = input.advanced && input.newStage ? input.newStage : input.stage;
    const opening = input.advanced && input.newStage ? frictionsOpeningAt(client, input.newStage, ledgerFacts) : [];
    const offered = pendingFrictions(client, frictionStage, ledgerFacts);
    const system = buildPersonaSystemPrompt({
      scenario,
      persona: client,
      stage: input.stage,
      worldFacts: ledgerFacts,
      frictionStage,
    });
    // The sponsor's own recent channel turns, so a point he has already
    // conceded there does not come back as a fresh question in the reaction.
    const channelMessages = await getMessages(channel.id);
    const recentTurns = channelMessages.slice(-REACTION_CONTEXT_TURNS).map((m) => {
      const who = m.sender === "learner" ? "The consultant" : "You";
      const text =
        m.content.length > REACTION_CONTEXT_CHARS
          ? `${m.content.slice(0, REACTION_CONTEXT_CHARS)}…`
          : m.content;
      return `${who}: ${text}`;
    });
    const outcome: ReactionOutcome = input.engagementCompleted
      ? "completed"
      : input.reason === "retries-exhausted"
        ? "retriesExhausted"
        : input.advanced
          ? "advanced"
          : "failed";
    const variant = pickReactionVariant(outcome, `${engagement.id}:${input.stage}`);
    const prompt = buildReactionPrompt({
      artifactKind: input.artifactKind,
      stageTitle: input.stageTitle,
      submissionExcerpt: reactionExcerpt(input.submissionText),
      recentTurns,
      outcome,
      variant,
      raiseFriction: opening.length > 0,
    });

    // One retry covers transient provider and schema failures; a second
    // failure falls through to the event log. An empty reply reaches the
    // learner as a blank chat bubble, which reads like no reaction at all,
    // so it counts as a failure.
    const react = (extra: string | null) =>
      generateStyledPersonaObject(
        ({ system: sys, repair }) =>
          withPersonaRetry(
            async () => {
              const r = await generateObjectRobust(
                {
                  model: getLLM().personaModel,
                  schema: PersonaReactionSchema,
                  system: sys,
                  prompt: extra ? `${prompt}\n\n${extra}` : prompt,
                  maxTokens: reactionMaxTokens(),
                  experimental_repairText: repair,
                  ...samplingParams(config.llm.temperature),
                },
                // withPersonaRetry already retries the whole call.
                { callSite: "persona.reaction", retry: false },
              );
              if (!r.object.reply.trim()) throw new Error("The client sponsor returned an empty reply.");
              return r;
            },
            0,
            failed.record,
          ),
        system,
        { previousReplies: channelMessages.filter((m) => m.sender === client.id).map((m) => m.content) },
      );
    let styled = await react(null);
    let usage = styled.usage;

    // persona-v5: the sponsor may not name a withheld fact or undocumented
    // defect that the document does not mention (an earlier reaction named
    // the segmentation scenario's test accounts). Facts the learner has
    // already obtained are exempt. persona-v6: the sponsor's own withheld
    // facts that the learner has not obtained may never appear in a
    // reaction, whether or not the document names their topic and whether or
    // not the sponsor reports sharing them (a hedged
    // statement once drew the S$30 offer cost and the six-month save rule). A
    // reaction that names one is regenerated once with a corrective line; if
    // it still names one, those sentences are removed.
    const obtainedBefore = await getSharedFactIds(engagement.id);
    const ownIds = (client.withheld ?? []).map((w) => w.id);
    const otherLeakKeys = unraisedFactKeys(scenario, input.submissionText, [...obtainedBefore, ...ownIds]);
    const ownUnmet = unmetWithheld(client, { obtained: obtainedBefore, learnerMessage: null });
    const ownUnmetIds = new Set(ownUnmet.map((w) => w.id));
    const leakKeys = [...otherLeakKeys, ...ownUnmet.map((w) => w.keys)];
    const ownLeaks = (text: string) => blockedWithheld(client, text, { obtained: obtainedBefore, learnerMessage: null });
    let leak = keysNamed(styled.object.reply, leakKeys);
    const ownLeaked = new Map(ownLeaks(styled.object.reply).map((w) => [w.id, w]));
    let leakHandling: {
      named: string[];
      regenerated: boolean;
      removed: boolean;
    } | null = null;
    if (leak.length > 0) {
      leakHandling = { named: leak, regenerated: false, removed: false };
      const otherNamed = keysNamed(styled.object.reply, otherLeakKeys);
      const notes = [
        ...(otherNamed.length > 0
          ? [fillPromptTemplate(PERSONA_REACTION_LEAK_RETRY, { "leaked topics": otherNamed.join(", ") })]
          : []),
        ...(ownLeaked.size > 0 ? [withheldLeakNote([...ownLeaked.values()])] : []),
      ];
      try {
        const again = await react(notes.join("\n\n"));
        styled = { ...again, outputRepairs: [...styled.outputRepairs, ...again.outputRepairs] };
        usage = addUsage(usage, again.usage);
        leakHandling.regenerated = true;
      } catch {
        // Keep the first draft; its sentences are filtered below.
      }
      leak = keysNamed(styled.object.reply, leakKeys);
    }
    const ownStillLeaked = new Set(ownLeaks(styled.object.reply).map((w) => w.id));
    for (const w of ownLeaks(styled.object.reply)) ownLeaked.set(w.id, w);
    await failed.log(engagement, {
      personaId: client.id,
      stage: input.stage,
      kind: "reaction",
      recovered: true,
    });
    const result = styled.result;
    let reply = styled.object.reply.trim();
    if (leak.length > 0) {
      reply = withoutFactSentences(reply, leakKeys) ?? PERSONA_REACTION_LEAK_FALLBACK;
      if (leakHandling) leakHandling.removed = true;
    }
    // Only the sponsor's own decisions and requests reach the ledger; a fact
    // restating a figure or result from the submission is dropped.
    // A fact the reaction may not name may not reach the ledger either.
    const { kept: newFacts, dropped: droppedFacts } = filterReactionFacts(
      styled.object.newFacts.slice(0, 2).filter((f) => keysNamed(f, leakKeys).length === 0),
      {
        submissionText: input.submissionText,
        ledger: input.ledger.map((f) => f.fact),
        persona: client,
      },
    );

    // The facts land after the gate's own system fact, which is where they
    // belong in time: the sponsor wrote them in reaction to the delivery.
    await appendWorldFacts(engagement.id, input.stage, client.id, newFacts, "persona");
    // A pressure the reply raised (id reported and a key in the reply) is
    // recorded as a detected fact, so the judge can tell from the record
    // whether the client raised it.
    const raised = frictionsReportedAndRaised(reply, offered, styled.object.raisedFrictions);
    await logFrictions(engagement, client.id, frictionStage, raised, {
      via: "reaction",
      gateStage: input.stage,
    });
    await logHalfRaisedFrictions(
      engagement,
      client.id,
      frictionsHalfRaised(reply, offered, styled.object.raisedFrictions),
      "reaction",
    );
    const sharedBefore = obtainedBefore;
    const saved = await appendMessage({
      channelId: channel.id,
      engagementId: engagement.id,
      sender: client.id,
      content: reply,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
    await logStyleRetry(engagement, {
      personaId: client.id,
      stage: input.stage,
      kind: "reaction",
      styled,
    });
    await logOutputRepairs(engagement, {
      personaId: client.id,
      stage: input.stage,
      kind: "reaction",
      repairs: styled.outputRepairs,
    });
    if (leakHandling) {
      await logEvent(engagement.id, engagement.cohortId, REACTION_LEAK_EVENT, {
        personaId: client.id,
        stage: input.stage,
        ...leakHandling,
        promptVersion: PERSONA_PROMPT_VERSION,
      });
    }
    for (const factId of ownLeaked.keys()) {
      await logEvent(engagement.id, engagement.cohortId, WITHHELD_LEAK_EVENT, {
        factId,
        personaId: client.id,
        channel: "reaction",
        channelId: channel.id,
        stage: input.stage,
        regenerated: leakHandling?.regenerated ?? false,
        removed: ownStillLeaked.has(factId),
        promptVersion: PERSONA_PROMPT_VERSION,
      });
    }
    // A reaction cannot share a withheld fact the learner has not obtained,
    // so the sponsor's report that it did is not recorded as a reveal.
    const reportedRevealed = validRevealedIds(client, styled.object.revealedWithheld);
    const revealed = reportedRevealed.filter((id) => !ownUnmetIds.has(id));
    // Most replies reveal nothing: the database is read only when the persona
    // reported a fact or the reply holds one of its keys.
    const revealCandidate = revealed.length > 0 || detectUnreportedReveals(client, reply).length > 0;
    const reveals = revealCandidate
      ? await recordRevealsInReply({
          engagement,
          persona: client,
          reportedIds: revealed,
          reply,
          stage: input.stage,
          source: "reaction",
          turnIndex: channelMessages.filter((m) => m.sender === client.id).length + 1,
          learnerMessagesSoFar: await countLearnerMessages(engagement.id),
          messageId: saved?.id ?? null,
        })
      : [];
    // Every reaction is audited: reactions come
    // late in a stage, where the ledger is longest and a contradiction most
    // likely, and sampling had skipped all of them. A reveal the auditor
    // lists as early is marked early on its row.
    const audit = await auditIfSampled({
      engagement,
      scenario,
      persona: client,
      stage: input.stage,
      config,
      reply,
      ledger: input.ledger,
      priorPersonaTurns: channelMessages.filter((m) => m.sender === client.id).length,
      always: true,
      consultantMessage: reactionAuditMessage(input.artifactKind, input.submissionText),
      sharedFactIds: sharedBefore,
      reason: "reaction",
    });
    const revealedNow = reveals.map((r) => r.factId);
    // The auditor's early flags, and (persona-v6) any unobtained fact of the
    // sponsor's own that still reached the learner in a reaction: with no
    // learner question, such a reveal is early by definition.
    await markEarlyDisclosures(engagement, [
      ...audit.disclosedEarly.filter((id) => revealedNow.includes(id)),
      ...revealedNow.filter((id) => ownUnmetIds.has(id)),
    ]);
    const audited = audit.audited;
    await logEvent(engagement.id, engagement.cohortId, CLIENT_REACTION_EVENT, {
      personaId: client.id,
      stage: input.stage,
      outcome,
      variant,
      frictionsRaised: raised.map((f) => f.stage),
      raisedFrictions: raised.map((f) => f.id),
      detectedWithheld: reveals.filter((r) => r.detection === "detected").map((r) => r.factId),
      leakFiltered: leakHandling !== null,
      model: personaModelName(),
      servedModel: servedModelId(result),
      promptVersion: PERSONA_PROMPT_VERSION,
      newFacts: newFacts.length,
      droppedFacts,
      revealedWithheld: revealed,
      droppedReveals: reportedRevealed.filter((id) => ownUnmetIds.has(id)),
      withheldLeakBlocked: [...ownLeaked.keys()],
      styleRetry: styled.styleHits.length > 0,
      audited,
    });
    return true;
  } catch (err) {
    // Scoring and stage state are already persisted, so the submission still
    // stands; only the reaction is lost. Record why, because a silently
    // missing reaction is indistinguishable from a stakeholder who chose not
    // to answer.
    const { errorClass, message } = describeReactionError(err);
    await failed.log(engagement, { personaId: client.id, stage: input.stage, kind: "reaction", recovered: false });
    await logEvent(engagement.id, engagement.cohortId, CLIENT_REACTION_FAILED_EVENT, {
      stage: input.stage,
      reason: input.reason,
      personaId: client.id,
      errorClass,
      message,
    });
    return false;
  }
}

function describeReactionError(err: unknown): { errorClass: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  return {
    errorClass: err instanceof Error ? err.name : typeof err,
    message: message.slice(0, 500),
  };
}
