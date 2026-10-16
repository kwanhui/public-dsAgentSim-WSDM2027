// Role-consistency audit of persona turns. The virtual-patient literature's
// main critique of LLM-simulated stakeholders is that they drift out of
// character or contradict established facts; this module measures that
// instead of assuming it away. The first two turns of every persona in an
// engagement are always audited, so even a short run produces non-empty
// consistency telemetry; later turns are sampled at the cohort's
// research.consistencyAuditRate. Each audit checks the reply against the
// world-fact ledger, the persona's public card, the data dictionary and the
// release profiles (consistency-v3) via a second model call and logs the
// verdict as a persona_consistency event, so a
// role-consistency rate can be reported. Since consistency-v5 the auditor also sees the
// persona's held-back points with their reveal conditions and the
// consultant's message, and returns a separate early-disclosure verdict: a
// held-back point stated before its condition was met. The audit prompt's
// literal text lives in
// lib/agents/prompt-provenance.ts as a template shared with the admin
// console's read-only view.

import { generateObjectRobust } from "@/lib/llm/structured";
import { usageFromError } from "@/lib/llm/usage";
import { z } from "zod";
import { getLLM, RUBRIC_TEMPERATURE, samplingParams } from "@/lib/llm/client";
import { auditorMaxTokens } from "@/lib/llm/limits";
import { rubricModelName, servedModelId } from "@/lib/llm/model-names";
import {
  CONSISTENCY_PROMPT_VERSION,
  CONSISTENCY_REPLY_TEMPLATE,
  CONSISTENCY_SYSTEM_TEMPLATE,
  EARLY_DISCLOSURE_EVENT,
  fillPromptTemplate,
} from "@/lib/agents/prompt-provenance";
import { releasableDatasets } from "@/lib/agents/data-environment";
import { logEvent, type Engagement } from "@/lib/engagement/state";
import type { LedgerFact } from "@/lib/engagement/provenance";
import type { Scenario, ScenarioPersona, StageId } from "@/lib/scenarios/types";

export { CONSISTENCY_PROMPT_VERSION };

// Why a turn was audited beyond the sample: a sincere identity question, a
// gate reaction, or a reply that revealed a withheld fact.
export type AuditReason = "identity-question" | "reaction" | "reveal";

// The first N turns of each persona in each engagement are audited
// unconditionally, regardless of the sampled rate. Without this floor, a
// short run at the default rate could log zero consistency events and the
// headline mechanism would go unexercised.
export const GUARANTEED_AUDIT_TURNS = 2;

const VerdictSchema = z.object({
  consistent: z
    .boolean()
    .describe(
      "true when the reply contradicts none of the sources (record, profiles, dictionary, brief) and stays in character",
    ),
  contradiction: z
    .string()
    .nullable()
    .describe(
      "When inconsistent: one sentence naming the source and the contradicted fact, or the character break. Otherwise null.",
    ),
  // Optional so an auditor that leaves it out (including the mock) still
  // validates; an absent list means no early disclosure was found.
  disclosedEarly: z
    .array(z.string())
    .optional()
    .describe(
      "Ids of held-back points (not yet shared) that the reply states although the consultant's message does not meet their condition. Empty when none.",
    ),
});

// Sampling primitive: pure chance against the configured rate.
export function shouldAudit(rate: number, roll: number = Math.random()): boolean {
  return rate > 0 && roll < rate;
}

// Per-turn decision: the persona's first GUARANTEED_AUDIT_TURNS turns in
// this engagement are always audited; after that the sampled rate applies.
export function shouldAuditTurn(input: {
  rate: number;
  priorPersonaTurns: number;
  roll?: number;
}): boolean {
  if (input.priorPersonaTurns < GUARANTEED_AUDIT_TURNS) return true;
  return shouldAudit(input.rate, input.roll ?? Math.random());
}

export interface AuditContext {
  // The persona's card as written. Withheld facts live outside the card
  // (persona.withheld) and reach the auditor separately, in heldBack.
  card: string;
  // The persona's withheld facts with their reveal conditions, those
  // already shared marked as such (consistency-v5).
  heldBack: string;
  // Dictionaries of the scenario's files that are in play at this stage
  // (the data owner holds them, and the learner receives them on release).
  dictionary: string;
  // Release-profile facts from the ledger, kept apart from the rest.
  releaseProfile: string;
  // Every other ledger fact.
  record: string;
}

/** The sources the auditor checks a reply against. Pure. */
export function buildAuditContext(input: {
  scenario?: Scenario;
  stage?: StageId;
  persona: ScenarioPersona;
  ledger: LedgerFact[];
  // Withheld-fact ids already shared in this engagement.
  sharedFactIds?: readonly string[];
}): AuditContext {
  const { scenario, stage, persona, ledger } = input;
  const shared = new Set(input.sharedFactIds ?? []);
  const withheld = persona.withheld ?? [];
  const datasets = scenario && stage ? releasableDatasets(scenario, stage) : [];
  const list = (facts: LedgerFact[], empty: string) =>
    facts.length > 0 ? facts.map((f) => `- ${f.fact}`).join("\n") : empty;
  return {
    card: persona.card.trim(),
    heldBack:
      withheld.length > 0
        ? withheld
            .map(
              (w) =>
                `- [${w.id}] ${w.fact.trim()} Condition: ${w.revealWhen.trim().replace(/\.$/, "")}.${
                  shared.has(w.id) ? " (Already shared earlier in this engagement.)" : ""
                }`,
            )
            .join("\n")
        : "(none)",
    dictionary:
      datasets.length > 0
        ? datasets.map((d) => `${d.file}:\n${d.dictionary.trim()}`).join("\n\n")
        : "(no data files are in play yet)",
    releaseProfile: list(
      ledger.filter((f) => f.provenance === "release-profile"),
      "(no files released yet)",
    ),
    record: list(
      ledger.filter((f) => f.provenance !== "release-profile"),
      "(none)",
    ),
  };
}

/** The reported early-disclosure ids that are the persona's own and not yet
 * shared, deduplicated. Pure. */
export function validEarlyDisclosures(
  persona: ScenarioPersona,
  reported: readonly string[] | undefined,
  sharedFactIds: readonly string[] = [],
): string[] {
  const wanted = new Set((reported ?? []).map((id) => id.trim().replace(/^\[|\]$/g, "")));
  const shared = new Set(sharedFactIds);
  return (persona.withheld ?? []).map((w) => w.id).filter((id) => wanted.has(id) && !shared.has(id));
}

/** What one audit found, for the caller; null when the audit call failed. */
export interface AuditOutcome {
  consistent: boolean;
  disclosedEarly: string[];
}

// Awaited by the orchestrator: failures and verdicts both land in the event
// log, and nothing here alters the learner-facing reply. The outcome is
// returned so that a reveal the auditor flags as early can be marked on its
// fact_elicitations row.
export async function auditPersonaTurn(input: {
  engagement: Engagement;
  scenario?: Scenario;
  stage?: StageId;
  persona: ScenarioPersona;
  reply: string;
  ledger: LedgerFact[];
  // The learner's message the reply answers (for a gate reaction, a short
  // note and an excerpt of the submission).
  consultantMessage?: string;
  sharedFactIds?: readonly string[];
  // Why this turn was audited beyond the sample, when it was.
  reason?: AuditReason;
}): Promise<AuditOutcome | null> {
  const { engagement, persona, reply } = input;
  try {
    const ctx = buildAuditContext(input);
    const result = await generateObjectRobust(
      {
        model: getLLM().rubricModel,
        schema: VerdictSchema,
        system: fillPromptTemplate(CONSISTENCY_SYSTEM_TEMPLATE, {
          "persona name": persona.name,
          "persona title": persona.title,
          "persona role": persona.role,
          "persona card": ctx.card,
          "held-back facts": ctx.heldBack,
          "data dictionary": ctx.dictionary,
          "release profile": ctx.releaseProfile,
          "engagement record": ctx.record,
        }),
        prompt: fillPromptTemplate(CONSISTENCY_REPLY_TEMPLATE, {
          "consultant message": input.consultantMessage?.trim() || "(not available)",
          "persona name": persona.name,
          "persona reply": reply,
        }),
        maxTokens: auditorMaxTokens(),
        ...samplingParams(RUBRIC_TEMPERATURE),
      },
      { callSite: "consistency.audit" },
    );
    const { object, usage } = result;
    const disclosedEarly = validEarlyDisclosures(persona, object.disclosedEarly, input.sharedFactIds);
    // Recorded under judgeModel/servedModel, not "model": the compare view
    // reads "model" off events as the persona model.
    await logEvent(engagement.id, engagement.cohortId, "persona_consistency", {
      personaId: persona.id,
      consistent: object.consistent,
      contradiction: object.contradiction,
      disclosedEarly,
      ...(input.reason ? { reason: input.reason } : {}),
      judgeModel: rubricModelName(),
      servedModel: servedModelId(result),
      promptVersion: CONSISTENCY_PROMPT_VERSION,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
    });
    if (disclosedEarly.length > 0) {
      await logEvent(engagement.id, engagement.cohortId, EARLY_DISCLOSURE_EVENT, {
        personaId: persona.id,
        stage: input.stage ?? null,
        factIds: disclosedEarly,
        promptVersion: CONSISTENCY_PROMPT_VERSION,
      });
    }
    return { consistent: object.consistent, disclosedEarly };
  } catch (err) {
    // A failed audit call can still have cost tokens (an answer that did
    // not parse); persona_consistency tokens are judge-side in the guard.
    const usage = usageFromError(err);
    await logEvent(engagement.id, engagement.cohortId, "persona_consistency", {
      personaId: persona.id,
      consistent: null,
      error: "audit-failed",
      judgeModel: rubricModelName(),
      promptVersion: CONSISTENCY_PROMPT_VERSION,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
    return null;
  }
}
