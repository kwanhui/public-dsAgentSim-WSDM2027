// Routes one learner message in one channel to its persona, persists both
// sides of the exchange, and applies the persona's world-state side effects
// (new shared facts, dataset releases).

import { generateObjectRobust } from "@/lib/llm/structured";
import type { z } from "zod";
import { getLLM, samplingParams } from "@/lib/llm/client";
import { personaMaxTokens } from "@/lib/llm/limits";
import { personaModelName, servedModelId } from "@/lib/llm/model-names";
import { auditPersonaTurn, shouldAuditTurn, type AuditReason } from "@/lib/agents/consistency";
import { recordDataReleases, releasableDatasets } from "@/lib/agents/data-environment";
import { profileReleasedDatasets, releaseWorldFact } from "@/lib/agents/dataset-profile";
import {
  FRICTION_RAISED_EVENT,
  FRICTION_UNCONFIRMED_EVENT,
  frictionsHalfRaised,
  frictionsReportedAndRaised,
  pendingFrictions,
} from "@/lib/agents/frictions";
import { checkReleaseScope, RELEASE_WITHHELD_EVENT, withheldReleaseReply } from "@/lib/agents/release-scope";
import { releaseWithheldNote } from "@/lib/engagement/release-notes";
import { enforceIdentityAnswer, IDENTITY_QUESTION_EVENT, isSincereIdentityQuestion } from "@/lib/agents/identity";
import {
  buildPersonaSystemPrompt,
  buildStyleRetrySystem,
  filterLearnerNumberFacts,
  PERSONA_PROMPT_VERSION,
  PersonaTurnSchema,
  validRevealedIds,
} from "@/lib/agents/persona";
import {
  describeStyleViolations,
  findStyleViolations,
  PERSONA_ARRAY_FIELDS,
  PERSONA_OUTPUT_REPAIR_EVENT,
  PERSONA_STYLE_RETRY_EVENT,
  replyLengthRepair,
  unwrapNestedReply,
  type NestedReplyRepair,
  type StyleContext,
} from "@/lib/agents/persona-style";
import {
  detectUnreportedReveals,
  getSharedFactIds,
  markEarlyDisclosures,
  recordRevealsInReply,
} from "@/lib/engagement/elicitation";
import { addUsage, describeCallError, markMetered, usageFromError, type CallUsage } from "@/lib/llm/usage";
import {
  appendMessage,
  appendWorldFacts,
  countLearnerMessages,
  getLedger,
  getMessages,
  logEvent,
  type Channel,
  type Engagement,
} from "@/lib/engagement/state";
import type { CohortConfig } from "@/lib/cohort/defaults";
import { PERSONA_WITHHELD_LEAK_FALLBACK } from "@/lib/agents/prompt-provenance";
import { withoutFactSentences } from "@/lib/agents/rationale-filter";
import {
  blockedWithheld,
  guardedPersona,
  unmetWithheld,
  WITHHELD_LEAK_EVENT,
  withheldLeakNote,
} from "@/lib/agents/withheld-guard";
import type { LedgerFact } from "@/lib/engagement/provenance";
import type { Friction, Scenario, ScenarioPersona, StageId } from "@/lib/scenarios/types";

// Most recent turns included verbatim in the persona's context. Older turns
// are dropped: durable outcomes are expected to live in the world-fact
// ledger, which is always included in full.
const HISTORY_TURNS = 30;

// Pause before the single retry of a failed persona call: long enough to ride
// out a transient provider hiccup, short enough that the learner still sees a
// reply rather than a timeout. Exported so the retry test can advance fake
// timers past it.
export const PERSONA_RETRY_DELAY_MS = 1500;

// Runs a structured persona call with one retry after a pause. Shared by
// chat turns and the client sponsor's gate reaction, so both take the same
// path: one structured call returning the reply and any new facts.
// `onFailure` sees every failed attempt, including one the retry recovers,
// so its tokens can be metered (see FailedCalls).
export async function withPersonaRetry<T>(
  call: () => Promise<T>,
  delayMs: number = PERSONA_RETRY_DELAY_MS,
  onFailure?: (err: unknown) => void,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    onFailure?.(err);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      return await call();
    } catch (second) {
      onFailure?.(second);
      throw second;
    }
  }
}

/**
 * Collects the failed persona-model calls of one turn or reaction, so their
 * tokens reach the spend guard as a persona_failed event (a failed call used to cost money and leave no record).
 */
export class FailedCalls {
  attempts = 0;
  usage: CallUsage = { promptTokens: 0, completionTokens: 0 };
  last: unknown = null;

  readonly record = (err: unknown): void => {
    this.attempts += 1;
    this.usage = addUsage(this.usage, usageFromError(err));
    this.last = err;
  };

  /** Logs persona_failed when any attempt failed. `recovered` is true when a
   * retry or the kept draft still produced the reply. */
  async log(
    engagement: Engagement,
    detail: { personaId: string; stage: StageId; kind: "turn" | "reaction"; recovered: boolean },
  ): Promise<void> {
    if (this.attempts === 0) return;
    await logEvent(engagement.id, engagement.cohortId, PERSONA_FAILED_EVENT, {
      ...detail,
      attempts: this.attempts,
      ...describeCallError(this.last),
      model: personaModelName(),
      promptVersion: PERSONA_PROMPT_VERSION,
      promptTokens: this.usage.promptTokens,
      completionTokens: this.usage.completionTokens,
    });
  }
}

export const PERSONA_FAILED_EVENT = "persona_failed";

export interface StyledCallResult<T> {
  object: T;
  usage: CallUsage;
  // The provider response of the call whose object is used.
  result: { response?: { modelId?: string } };
  // Style patterns the first draft tripped (empty when it passed).
  styleHits: string[];
  // Patterns the rewrite still tripped, when there was one.
  styleHitsAfterRetry: string[] | null;
  // Replies that held the whole structured output as JSON text and were
  // unwrapped, by call (draft or rewrite) and by where the unwrap ran (the
  // repair hook before validation, or the validated object).
  outputRepairs: OutputRepair[];
}

export interface OutputRepair extends NestedReplyRepair {
  call: "draft" | "rewrite";
  stage: "repair-hook" | "validated-object";
}

// Unwraps a validated persona object whose reply is the whole object as JSON
// text. The schema accepts such a reply when every field is present and the
// text fits the limit, so the repair hook never sees it. Only array fields the
// object already has are merged, so a reaction gains no releaseDatasets.
function unwrapValidated<T extends { reply: string }>(
  object: T,
  call: OutputRepair["call"],
  hook: ReturnType<typeof replyLengthRepair>,
): { object: T; repairs: OutputRepair[] } {
  const repairs: OutputRepair[] = hook.repairs().map((r) => ({ ...r, call, stage: "repair-hook" }));
  const record = object as unknown as Record<string, unknown>;
  const present = PERSONA_ARRAY_FIELDS.filter((f) => Array.isArray(record[f]));
  const unwrapped = unwrapNestedReply(record, present);
  if (!unwrapped) return { object, repairs };
  repairs.push({ ...unwrapped.repair, call, stage: "validated-object" });
  return { object: unwrapped.object as unknown as T, repairs };
}

/**
 * One structured persona call with the persona-v3 style check. The reply field has a hard length limit; a reply past it
 * is cut at a sentence end instead of failing validation, and counts as too
 * long. A reply that trips a style pattern is rewritten once, with the
 * draft and the broken rules appended to the system prompt; the rewrite is
 * used whether or not it is clean, and the caller logs the hit. Shared by
 * chat turns and gate reactions. `context` holds the persona's earlier
 * replies in the channel, for the repeated-phrase and repeated-refusal
 * checks (persona-v7).
 */
export async function generateStyledPersonaObject<T extends { reply: string }>(
  call: (args: { system: string; repair: (input: { text: string }) => Promise<string | null> }) => Promise<{
    object: T;
    usage?: CallUsage;
    response?: { modelId?: string };
  }>,
  system: string,
  context?: StyleContext,
): Promise<StyledCallResult<T>> {
  const first = replyLengthRepair();
  const draftCall = await call({ system, repair: first.repair });
  // Unwrapped before the style check, so the check and the rewrite prompt
  // only ever see the reply text.
  const draftUnwrapped = unwrapValidated(draftCall.object, "draft", first);
  const draft = { ...draftCall, object: draftUnwrapped.object };
  const hits = findStyleViolations(draft.object.reply, context);
  if (first.wasTruncated() && !hits.includes("too-long")) hits.push("too-long");
  if (hits.length === 0) {
    return {
      object: draft.object,
      usage: addUsage(draft.usage, undefined),
      result: draft,
      styleHits: [],
      styleHitsAfterRetry: null,
      outputRepairs: draftUnwrapped.repairs,
    };
  }
  try {
    const second = replyLengthRepair();
    const rewriteCall = await call({
      system: buildStyleRetrySystem(system, draft.object.reply, describeStyleViolations(hits)),
      repair: second.repair,
    });
    const rewriteUnwrapped = unwrapValidated(rewriteCall.object, "rewrite", second);
    const rewrite = { ...rewriteCall, object: rewriteUnwrapped.object };
    const after = findStyleViolations(rewrite.object.reply, context);
    if (second.wasTruncated() && !after.includes("too-long")) after.push("too-long");
    return {
      object: rewrite.object,
      usage: addUsage(draft.usage, rewrite.usage),
      result: rewrite,
      styleHits: hits,
      styleHitsAfterRetry: after,
      outputRepairs: [...draftUnwrapped.repairs, ...rewriteUnwrapped.repairs],
    };
  } catch {
    // A failed rewrite never costs the learner the reply: keep the draft.
    return {
      object: draft.object,
      usage: addUsage(draft.usage, undefined),
      result: draft,
      styleHits: hits,
      styleHitsAfterRetry: null,
      outputRepairs: draftUnwrapped.repairs,
    };
  }
}

/** Logs a persona_output_repair event when a reply held the whole structured
 * output as JSON text and was unwrapped. */
export async function logOutputRepairs(
  engagement: Engagement,
  input: { personaId: string; stage: StageId; kind: "turn" | "reaction"; repairs: readonly OutputRepair[] },
): Promise<void> {
  if (input.repairs.length === 0) return;
  await logEvent(engagement.id, engagement.cohortId, PERSONA_OUTPUT_REPAIR_EVENT, {
    personaId: input.personaId,
    stage: input.stage,
    kind: input.kind,
    repairs: input.repairs,
    promptVersion: PERSONA_PROMPT_VERSION,
  });
}

/** Logs a persona_style_retry event when the first draft tripped a pattern. */
export async function logStyleRetry(
  engagement: Engagement,
  input: { personaId: string; stage: StageId; kind: "turn" | "reaction"; styled: StyledCallResult<unknown & { reply: string }> },
): Promise<void> {
  if (input.styled.styleHits.length === 0) return;
  await logEvent(engagement.id, engagement.cohortId, PERSONA_STYLE_RETRY_EVENT, {
    personaId: input.personaId,
    stage: input.stage,
    kind: input.kind,
    patterns: input.styled.styleHits,
    patternsAfterRetry: input.styled.styleHitsAfterRetry,
    resolved: input.styled.styleHitsAfterRetry !== null && input.styled.styleHitsAfterRetry.length === 0,
    promptVersion: PERSONA_PROMPT_VERSION,
  });
}

// Role-consistency audit (see lib/agents/consistency.ts): each persona's
// first two turns in an engagement are always audited so a short run still
// produces consistency telemetry, and later turns are sampled at the cohort
// rate. Every client gate reaction is audited (always: true, since reactions
// were once left unaudited), and so is every reply that
// reveals a withheld fact. Awaited so serverless runtimes don't kill it
// mid-flight. Its outcome never changes the reply; the early-disclosure ids
// it returns mark the matching fact_elicitations rows.
export async function auditIfSampled(input: {
  engagement: Engagement;
  scenario: Scenario;
  persona: ScenarioPersona;
  stage: StageId;
  config: CohortConfig;
  reply: string;
  // The ledger as it stood before this turn, with provenance.
  ledger: LedgerFact[];
  priorPersonaTurns: number;
  // Audit regardless of the sampling rate (gate reactions, identity
  // questions).
  always?: boolean;
  // Passed to the auditor for the early-disclosure check (consistency-v5).
  consultantMessage?: string;
  sharedFactIds?: readonly string[];
  reason?: AuditReason;
}): Promise<{ audited: boolean; disclosedEarly: string[] }> {
  if (
    !input.always &&
    !shouldAuditTurn({
      rate: input.config.research.consistencyAuditRate,
      priorPersonaTurns: input.priorPersonaTurns,
    })
  ) {
    return { audited: false, disclosedEarly: [] };
  }
  const outcome = await auditPersonaTurn({
    engagement: input.engagement,
    scenario: input.scenario,
    persona: input.persona,
    stage: input.stage,
    reply: input.reply,
    ledger: input.ledger,
    consultantMessage: input.consultantMessage,
    sharedFactIds: input.sharedFactIds,
    reason: input.reason,
  });
  return { audited: true, disclosedEarly: outcome?.disclosedEarly ?? [] };
}

interface StoredMessage {
  id: number;
  sender: string;
  content: string;
  timestampIso: string;
  /** A platform line shown under the reply, not part of the stored message:
   * set when the platform dropped a file release the reply answered
   * (lib/engagement/release-notes.ts). */
  platformNote?: string | null;
}

export interface PersonaReply {
  /** The learner's own message as persisted, so the client can replace its
   * optimistic copy with the one the transcript actually holds. */
  learnerMessage: StoredMessage;
  message: StoredMessage;
  releasedFiles: string[];
}

export async function handleLearnerMessage(input: {
  engagement: Engagement;
  channel: Channel;
  scenario: Scenario;
  config: CohortConfig;
  text: string;
}): Promise<PersonaReply> {
  const { engagement, channel, scenario, config, text } = input;
  const persona = scenario.personas.find((p) => p.id === channel.personaId);
  if (!persona) throw new Error(`Unknown persona ${channel.personaId} for scenario ${scenario.id}`);

  const stage = engagement.currentStage as StageId;
  const [history, ledger] = await Promise.all([getMessages(channel.id), getLedger(engagement.id)]);
  const facts = ledger.map((f) => f.fact);

  const system = buildPersonaSystemPrompt({ scenario, persona, stage, worldFacts: facts });
  // The learner's message joins the prompt here but reaches the database only
  // once the persona has answered: a failed turn then leaves no half of the
  // exchange behind, so the learner can resend without doubling the
  // transcript the rubric judge later reads.
  const turns = [...history, { sender: "learner", content: text }]
    .slice(-HISTORY_TURNS)
    .map((m) => ({
      role: m.sender === "learner" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }));

  // One retry after a short pause covers transient provider and schema
  // failures. Nothing has been persisted at this point, so a second failure
  // still propagates to the route as a truthful 502: no half of the exchange
  // is left behind, and the learner can resend. Every failed attempt is
  // metered as a persona_failed event, recovered or not.
  const failed = new FailedCalls();
  // The persona's own earlier replies here, for the repetition checks.
  const styleContext: StyleContext = {
    previousReplies: history.filter((m) => m.sender === persona.id).map((m) => m.content),
  };
  const callPersona = (baseSystem: string) =>
    generateStyledPersonaObject(
      ({ system: sys, repair }) =>
        withPersonaRetry(
          () =>
            generateObjectRobust(
              {
                model: getLLM().personaModel,
                schema: PersonaTurnSchema,
                system: sys,
                messages: turns,
                maxTokens: personaMaxTokens(),
                experimental_repairText: repair,
                ...samplingParams(config.llm.temperature),
              },
              // withPersonaRetry already retries the whole call.
              { callSite: "persona.turn", retry: false },
            ),
          PERSONA_RETRY_DELAY_MS,
          failed.record,
        ),
      baseSystem,
      styleContext,
    );
  let styled: StyledCallResult<z.infer<typeof PersonaTurnSchema>>;
  try {
    styled = await callPersona(system);
  } catch (err) {
    await failed.log(engagement, { personaId: persona.id, stage, kind: "turn", recovered: false });
    markMetered(err);
    throw err;
  }

  // Held-back points shared before this turn, for the withheld-fact guard
  // and the auditor.
  const sharedBefore = await getSharedFactIds(engagement.id);

  // persona-v6: the persona's own withheld facts that the learner has not
  // obtained may appear only when this message meets their reveal condition
  // (lib/agents/withheld-guard.ts). A reply that states one otherwise is
  // regenerated once with a corrective line; any sentence that still states
  // one is removed. persona-v7: a fact that is also a file's undocumented
  // defect is read with the defect's keys too.
  const guarded = guardedPersona(persona, scenario);
  const guardFor = (o: z.infer<typeof PersonaTurnSchema>) => ({
    obtained: sharedBefore,
    learnerMessage: text,
    reportedIds: validRevealedIds(persona, o.revealedWithheld),
  });
  const leakedFirst = blockedWithheld(guarded, styled.object.reply, guardFor(styled.object));
  const withheldLeaks = new Map(leakedFirst.map((w) => [w.id, w]));
  let leakRegenerated = false;
  if (leakedFirst.length > 0) {
    try {
      const again = await callPersona(`${system}\n\n${withheldLeakNote(leakedFirst)}`);
      styled = {
        ...again,
        usage: addUsage(styled.usage, again.usage),
        outputRepairs: [...styled.outputRepairs, ...again.outputRepairs],
      };
      leakRegenerated = true;
    } catch {
      // Keep the first draft; its sentences are removed below.
    }
  }
  const leakedAfter = leakedFirst.length > 0 ? blockedWithheld(guarded, styled.object.reply, guardFor(styled.object)) : [];
  for (const w of leakedAfter) withheldLeaks.set(w.id, w);
  const unmet = unmetWithheld(guarded, guardFor(styled.object));
  const unmetIds = new Set(unmet.map((w) => w.id));
  // The model's own reply, for the auditor.
  const modelReply = styled.object.reply;
  const object: z.infer<typeof PersonaTurnSchema> = {
    ...styled.object,
    reply:
      leakedAfter.length > 0
        ? (withoutFactSentences(
            styled.object.reply,
            leakedAfter.map((w) => w.keys),
          ) ?? PERSONA_WITHHELD_LEAK_FALLBACK)
        : styled.object.reply,
    // A fact the reply may not state may not reach the ledger either.
    newFacts: styled.object.newFacts.filter((f) => blockedWithheld(guarded, f, guardFor(styled.object)).length === 0),
  };
  await failed.log(engagement, { personaId: persona.id, stage, kind: "turn", recovered: true });
  const usage = styled.usage;
  const turn = styled.result;

  // A sincere question about whether the learner is talking to a person is
  // checked by pattern, not left to the prompt: the delivered reply always
  // carries the identity sentence, and a reply that claimed to be human is
  // replaced by it (lib/agents/identity.ts). Such a turn is always audited.
  const identityQuestion = isSincereIdentityQuestion(text);
  const identity = identityQuestion ? enforceIdentityAnswer(object.reply) : null;
  let personaReply = identity ? identity.reply : object.reply;

  // The persona has answered, so both halves of the exchange are stored now.
  // The learner's message goes first: a release event names it as the
  // message the data owner released the file in answer to.
  const savedLearner = await appendMessage({
    channelId: channel.id,
    engagementId: engagement.id,
    sender: "learner",
    content: text,
  });

  // Only the data owner may release files; the schema description says so,
  // but enforce it here rather than trusting the model. A release also needs
  // a scope the learner stated in their own messages in this channel: at
  // least one column of the file's dictionary and a purpose
  // (lib/agents/release-scope.ts). A release that fails the check is
  // dropped, and the reply asks for what is missing.
  const learnerMessagesHere = [...history.filter((m) => m.sender === "learner").map((m) => m.content), text];
  let releasedFiles: string[] = [];
  let releaseFacts: string[] = [];
  const withheldReleases: { file: string; missing: string[] }[] = [];
  if (persona.role === "data-owner" && object.releaseDatasets.length > 0) {
    const allowed: string[] = [];
    let scopeText: string | null = null;
    const missing = new Set<"column" | "purpose">();
    for (const file of [...new Set(object.releaseDatasets)]) {
      const dataset = scenario.datasets.find((d) => d.file === file);
      if (!dataset) continue;
      const check = checkReleaseScope({
        scenario,
        dataset,
        learnerMessages: learnerMessagesHere,
      });
      if (check.ok) {
        allowed.push(file);
        scopeText = scopeText ?? check.scopeText;
      } else {
        check.missing.forEach((m) => missing.add(m));
        withheldReleases.push({ file, missing: check.missing });
      }
    }
    for (const w of withheldReleases) {
      await logEvent(engagement.id, engagement.cohortId, RELEASE_WITHHELD_EVENT, {
        file: w.file,
        personaId: persona.id,
        stage,
        missing: w.missing,
        scopeMessageId: savedLearner.id,
      });
    }
    if (withheldReleases.length > 0 && allowed.length === 0) {
      personaReply = withheldReleaseReply(personaReply, [...missing]);
    }
    if (allowed.length > 0) {
      releasedFiles = await recordDataReleases(engagement, scenario, persona.id, allowed, {
        scopeMessageId: savedLearner.id,
        scopeText,
      });
    }
    // Record each released file's actual shape in the ledger at the moment of
    // release. The profile is deterministic, and the ledger reaches every
    // persona and the stage-gate judge, so all of them read the same row
    // count and quirks the learner can see in the file, instead of the data
    // owner disputing her own extract or a judge calling its size unsupported.
    if (releasedFiles.length > 0) {
      const profiles = await profileReleasedDatasets(engagement, scenario, releasedFiles);
      releaseFacts = profiles.map((p) => releaseWorldFact(p, scenario.datasets.find((d) => d.file === p.file)));
      await appendWorldFacts(engagement.id, stage, "system", releaseFacts, "release-profile");
    }
  }

  // A chat turn may not turn a figure the learner wrote into a fact: the
  // same filter as the gate reaction, with the learner's messages in this
  // channel as the learner's text.
  const learnerText = [...history.filter((m) => m.sender === "learner").map((m) => m.content), text].join("\n");
  const { kept: newFacts, dropped: droppedFacts } = filterLearnerNumberFacts(object.newFacts.slice(0, 2), {
    learnerText,
    ledger: facts,
    persona,
    extraKnown: [
      scenario.brief,
      ...releaseFacts,
      ...(persona.role === "data-owner" ? releasableDatasets(scenario, stage).map((d) => d.dictionary) : []),
    ],
  });
  // A dropped release must not reach the ledger as a fact the data owner
  // wrote ("Marcus released the extract").
  const keptFacts =
    withheldReleases.length > 0 && releasedFiles.length === 0
      ? newFacts.filter((f) => !/\b(?:releas|attach|sent|handed over|shar(?:ed|ing) the (?:file|extract))/i.test(f))
      : newFacts;
  await appendWorldFacts(engagement.id, stage, persona.id, keptFacts);

  // A pressure this reply raised (its id reported and a key in the reply)
  // is recorded as a detected fact, so the judge can tell from the record
  // whether it was raised, and reads it as a claim.
  const offeredFrictions = pendingFrictions(persona, stage, facts);
  const raisedFrictionIds = object.raisedFrictions ?? [];
  const raised = frictionsReportedAndRaised(personaReply, offeredFrictions, raisedFrictionIds);
  await logFrictions(engagement, persona.id, stage, raised, { via: "turn" });
  await logHalfRaisedFrictions(
    engagement,
    persona.id,
    frictionsHalfRaised(personaReply, offeredFrictions, raisedFrictionIds),
    "turn",
  );

  const reply =
    releasedFiles.length > 0
      ? `${personaReply}\n\n[Attached: ${releasedFiles.join(", ")}, available under Data files]`
      : personaReply;

  const saved = await appendMessage({
    channelId: channel.id,
    engagementId: engagement.id,
    sender: persona.id,
    content: reply,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  });

  await logStyleRetry(engagement, { personaId: persona.id, stage, kind: "turn", styled });
  await logOutputRepairs(engagement, { personaId: persona.id, stage, kind: "turn", repairs: styled.outputRepairs });

  for (const factId of withheldLeaks.keys()) {
    await logEvent(engagement.id, engagement.cohortId, WITHHELD_LEAK_EVENT, {
      factId,
      personaId: persona.id,
      channel: "chat",
      channelId: channel.id,
      stage,
      regenerated: leakRegenerated,
      removed: leakedAfter.some((w) => w.id === factId),
      promptVersion: PERSONA_PROMPT_VERSION,
    });
  }

  if (identity) {
    await logEvent(engagement.id, engagement.cohortId, IDENTITY_QUESTION_EVENT, {
      personaId: persona.id,
      stage,
      outcome: identity.outcome,
      promptVersion: PERSONA_PROMPT_VERSION,
    });
  }

  // Elicitation trace: each withheld fact the persona reports sharing, and
  // each other of its withheld facts whose key the delivered reply states,
  // is recorded once, with how many learner messages it took. The learner's
  // message is already stored, so the count includes it.
  // A reported reveal of a fact whose condition this message does not meet
  // is not recorded: the reply may not state it (persona-v6).
  const revealed = validRevealedIds(persona, object.revealedWithheld).filter((id) => !unmetIds.has(id));
  // Most replies reveal nothing: the database is read only when the persona
  // reported a fact or the reply holds one of its keys.
  const revealCandidate = revealed.length > 0 || detectUnreportedReveals(persona, personaReply).length > 0;
  const reveals = revealCandidate
    ? await recordRevealsInReply({
        engagement,
        persona,
        reportedIds: revealed,
        reply: personaReply,
        stage,
        source: "turn",
        turnIndex: history.filter((m) => m.sender === persona.id).length + 1,
        learnerMessagesSoFar: await countLearnerMessages(engagement.id),
        messageId: saved.id,
      })
    : [];

  // The persona model is stamped on every turn so that a run carries its own
  // record of what played the stakeholders; the compare view reads it from
  // here rather than from the deployment's current setting.
  await logEvent(engagement.id, engagement.cohortId, "persona_turn", {
    personaId: persona.id,
    stage,
    model: personaModelName(),
    servedModel: servedModelId(turn),
    promptVersion: PERSONA_PROMPT_VERSION,
    newFacts: keptFacts.length,
    droppedFacts: droppedFacts + (newFacts.length - keptFacts.length),
    releasedFiles,
    revealedWithheld: revealed,
    detectedWithheld: reveals.filter((r) => r.detection === "detected").map((r) => r.factId),
    raisedFrictions: raised.map((f) => f.id),
    releaseWithheld: withheldReleases.map((w) => w.file),
    styleRetry: styled.styleHits.length > 0,
    identityQuestion: identity?.outcome ?? null,
    withheldLeakBlocked: [...withheldLeaks.keys()],
  });

  // Prior turns are counted from the channel history fetched above (one
  // channel per persona), before this turn was appended. The auditor reads
  // the model's own reply, so a claim to be human that the platform replaced
  // still counts as a character break.
  // A reply that revealed a withheld fact is always audited, and a reveal
  // the auditor lists as an early disclosure is marked early on its row.
  const revealedNow = reveals.map((r) => r.factId);
  const audit = await auditIfSampled({
    engagement,
    scenario,
    persona,
    stage,
    config,
    reply: modelReply,
    ledger,
    priorPersonaTurns: history.filter((m) => m.sender === persona.id).length,
    always: identityQuestion || revealedNow.length > 0,
    consultantMessage: text,
    sharedFactIds: sharedBefore,
    ...(identityQuestion
      ? { reason: "identity-question" as const }
      : revealedNow.length > 0
        ? { reason: "reveal" as const }
        : {}),
  });
  // The auditor's early flags, and (persona-v6) any fact whose condition
  // this message did not meet that still reached the learner.
  await markEarlyDisclosures(engagement, [
    ...audit.disclosedEarly.filter((id) => revealedNow.includes(id)),
    ...revealedNow.filter((id) => unmetIds.has(id)),
  ]);

  return {
    learnerMessage: {
      id: savedLearner.id,
      sender: savedLearner.sender,
      content: savedLearner.content,
      timestampIso: savedLearner.timestampIso,
    },
    message: {
      id: saved.id,
      sender: saved.sender,
      content: saved.content,
      timestampIso: saved.timestampIso,
      platformNote:
        withheldReleases.length > 0
          ? releaseWithheldNote(
              [...new Set(withheldReleases.flatMap((w) => w.missing))],
              releasedFiles.length > 0 ? withheldReleases.map((w) => w.file) : null,
            )
          : null,
    },
    releasedFiles,
  };
}

/** Writes each raised friction's ledger sentence (provenance "detected")
 * and logs friction_raised. Shared by chat turns and gate reactions. */
export async function logFrictions(
  engagement: Engagement,
  personaId: string,
  stage: StageId,
  raised: readonly Friction[],
  detail: { via: "turn" | "reaction"; gateStage?: StageId },
): Promise<void> {
  if (raised.length === 0) return;
  await appendWorldFacts(
    engagement.id,
    stage,
    personaId,
    raised.map((f) => f.ledger),
    "detected",
  );
  for (const f of raised) {
    await logEvent(engagement.id, engagement.cohortId, FRICTION_RAISED_EVENT, {
      personaId,
      stage: f.stage,
      frictionId: f.id,
      ...detail,
    });
  }
}

/** Logs a friction whose id was reported without a key in the reply, or
 * whose key appeared without the id: neither counts as raised. */
export async function logHalfRaisedFrictions(
  engagement: Engagement,
  personaId: string,
  half: readonly { id: string; reported: boolean; keyMatched: boolean }[],
  via: "turn" | "reaction",
): Promise<void> {
  for (const h of half) {
    await logEvent(engagement.id, engagement.cohortId, FRICTION_UNCONFIRMED_EVENT, {
      personaId,
      frictionId: h.id,
      reported: h.reported,
      keyMatched: h.keyMatched,
      via,
    });
  }
}
