// Builds the system prompt and structured-output schema for one persona
// turn. A persona reply is a single generateObject call that returns the
// in-character reply plus any world-state side effects (commitments made,
// datasets released), so consistency costs no extra LLM calls. The client
// sponsor's reaction to a gate submission uses the same system prompt and
// the reaction schema below (lib/agents/stage-gate.ts).
//
// The literal prompt text lives in lib/agents/prompt-provenance.ts
// (PERSONA_PROMPT_VERSION); this module only assembles and fills it.

import { z } from "zod";
import { releasableDatasets } from "@/lib/agents/data-environment";
import {
  fillPromptTemplate,
  PERSONA_CARD_SECTION,
  PERSONA_DATA_FILES_SECTION,
  PERSONA_DATA_QUESTIONS_SECTION,
  PERSONA_DATA_SCOPE_SECTION,
  PERSONA_ENGAGEMENT_SECTION,
  PERSONA_FRICTIONS_SECTION,
  PERSONA_IDENTITY_SECTION,
  PERSONA_INTRO,
  PERSONA_NO_DATA_FILES_SECTION,
  PERSONA_OUT_OF_REACH_SECTION,
  PERSONA_OWNERSHIP_SECTION,
  PERSONA_PROMPT_VERSION,
  PERSONA_REPLY_MAX_CHARS,
  PERSONA_REACTION_FRICTION,
  PERSONA_REACTION_INSTRUCTIONS,
  PERSONA_REACTION_RECENT,
  PERSONA_REACTION_TEMPLATE,
  PERSONA_RECORD_SECTION,
  PERSONA_REPLY_RULES,
  PERSONA_STAGE_SECTION,
  PERSONA_STYLE_RETRY_SECTION,
  PERSONA_WITHHELD_SECTION,
} from "@/lib/agents/prompt-provenance";
import { pendingFrictions } from "@/lib/agents/frictions";
import {
  stageReached,
  type Scenario,
  type ScenarioPersona,
  type StageId,
} from "@/lib/scenarios/types";

export { PERSONA_PROMPT_VERSION };

// The reply field carries a hard character limit (persona-v3). A reply past it is cut at a sentence end by the repair
// hook in lib/agents/persona-style.ts rather than failing the turn.
const replyField = z
  .string()
  .max(PERSONA_REPLY_MAX_CHARS)
  .describe(
    `Your in-character reply to the consultant's latest message: about 60 words, at most ${PERSONA_REPLY_MAX_CHARS} characters.`,
  );

const newFactsField = z
  .array(z.string())
  .describe(
    "0-2 new facts from THIS reply that other stakeholders must stay consistent with: agreed scope, promised deliverables, a constraint or requirement you stated, a disclosed data problem, or a kept-back point you have now shared. Empty when the reply adds nothing new. Never repeat facts that are already known.",
  );

const revealedWithheldField = z
  .array(z.string())
  .describe(
    "The ids (in square brackets in your brief) of any points you had kept to yourself that THIS reply shares. Usually empty.",
  );

// persona-v5: the ids of the pressures a reply raises. Defaults to empty, so
// a provider or mock that leaves it out still validates.
const raisedFrictionsField = z
  .array(z.string())
  .default([])
  .describe(
    "The ids (in square brackets under the pressures in your brief) of any pressure THIS reply raises. Usually empty.",
  );

export const PersonaTurnSchema = z.object({
  reply: replyField,
  newFacts: newFactsField,
  revealedWithheld: revealedWithheldField,
  raisedFrictions: raisedFrictionsField,
  releaseDatasets: z
    .array(z.string())
    .describe(
      "Dataset file names you are handing over IN THIS REPLY. Only the data owner may release files, only from the listed releasable files, and only once the consultant has stated an acceptable scope of use. Usually empty.",
    ),
});

export type PersonaTurn = z.infer<typeof PersonaTurnSchema>;

// The client sponsor's gate reaction: a reply and any new facts, never a
// data release. Its facts are limited to the sponsor's own decisions and
// requests (an invented AUC in a submission entered
// the ledger through the reaction).
export const PersonaReactionSchema = z.object({
  reply: replyField,
  newFacts: z
    .array(z.string())
    .describe(
      "0-2 of your own decisions, constraints or requests made in THIS reply (for example, a decision to take the list to the CFO, or a request for a shorter list). Never a number, result or finding the consultant reported in the document. Usually empty.",
    ),
  revealedWithheld: revealedWithheldField,
  raisedFrictions: raisedFrictionsField,
});

export type PersonaReaction = z.infer<typeof PersonaReactionSchema>;

// When each stage's stakeholder becomes involved, in the words a colleague
// would use. The persona never names a stage, for example
// "you won't have a channel to her until we get to testing").
const IN_WORLD_TIMING: Record<StageId, string> = {
  formulation: "from the start",
  "data-collection": "once the data request is under way",
  cleaning: "once the data is being cleaned",
  modelling: "once modelling starts",
  testing: "once there are model results to try out with the people who will use them",
  deployment: "at handover",
};

const ROLE_LABELS: Record<ScenarioPersona["role"], string> = {
  "client-sponsor": "client sponsor",
  "data-owner": "data owner",
  "end-user": "end user",
};

/** The persona's pressures whose stage the engagement has reached. */
export function activeFrictions(persona: ScenarioPersona, stage: StageId): string[] {
  return (persona.frictions ?? []).filter((f) => stageReached(stage, f.stage)).map((f) => f.text.trim());
}

export function buildPersonaSystemPrompt(input: {
  scenario: Scenario;
  persona: ScenarioPersona;
  stage: StageId;
  worldFacts: string[];
  // The stage whose pressures the persona brings, when it differs from the
  // stage of the work: the reaction to a gate that opens the next stage
  // brings that stage's pressures. Defaults to `stage`.
  frictionStage?: StageId;
}): string {
  const { scenario, persona, stage, worldFacts } = input;
  const stageInfo = scenario.stages.find((s) => s.id === stage);

  const sections: string[] = [
    PERSONA_INTRO,
    PERSONA_IDENTITY_SECTION,
    fillPromptTemplate(PERSONA_ENGAGEMENT_SECTION, { "engagement brief": scenario.brief.trim() }),
    fillPromptTemplate(PERSONA_CARD_SECTION, { "persona card": persona.card.trim() }),
  ];

  // A pressure already raised is in the record, so it is not listed again.
  const frictions = pendingFrictions(persona, input.frictionStage ?? stage, worldFacts);
  if (frictions.length > 0) {
    sections.push(
      fillPromptTemplate(PERSONA_FRICTIONS_SECTION, {
        frictions: frictions.map((f) => `- [${f.id}] ${f.text.trim()}`).join("\n"),
      }),
    );
  }

  const withheld = persona.withheld ?? [];
  if (withheld.length > 0) {
    sections.push(
      fillPromptTemplate(PERSONA_WITHHELD_SECTION, {
        "held-back facts": withheld
          .map((w) => `- [${w.id}] ${w.fact.trim()} Share it when: ${w.revealWhen.trim().replace(/\.$/, "")}.`)
          .join("\n"),
      }),
    );
  }

  sections.push(
    fillPromptTemplate(PERSONA_STAGE_SECTION, {
      "stage title": stageInfo?.title ?? stage,
      "stage guidance": stageInfo?.guidance.trim() ?? "",
    }),
    fillPromptTemplate(PERSONA_RECORD_SECTION, {
      "engagement record": worldFacts.map((f) => `- ${f}`).join("\n"),
    }),
  );

  const owners = scenario.personas.filter((p) => (p.owns ?? []).length > 0);
  if (owners.length > 0) {
    sections.push(
      fillPromptTemplate(PERSONA_OWNERSHIP_SECTION, {
        "topic owners": owners
          .map(
            (p) =>
              `- ${p.id === persona.id ? "You" : p.name} (${ROLE_LABELS[p.role]}): ${p.owns.join("; ")}`,
          )
          .join("\n"),
      }),
    );
  }

  if (persona.role === "data-owner") {
    const releasable = releasableDatasets(scenario, stage);
    sections.push(
      releasable.length > 0
        ? fillPromptTemplate(PERSONA_DATA_FILES_SECTION, {
            "releasable files": releasable.map((d) => `- ${d.file}: ${d.description}`).join("\n"),
            "data dictionaries": releasable.map((d) => d.dictionary.trim()).join("\n\n"),
          })
        : PERSONA_NO_DATA_FILES_SECTION,
      PERSONA_DATA_SCOPE_SECTION,
      PERSONA_DATA_QUESTIONS_SECTION,
    );
  }

  // Personas kept telling learners to "check with Priya" several stages
  // before Priya's channel exists. Naming who is out of reach, and roughly
  // when they are involved, lets a stakeholder defer to them the way a
  // colleague would without sending the learner after a door that is still
  // locked.
  const outOfReach = scenario.personas.filter(
    (p) => p.id !== persona.id && !stageReached(stage, p.unlockedAtStage),
  );
  if (outOfReach.length > 0) {
    sections.push(
      fillPromptTemplate(PERSONA_OUT_OF_REACH_SECTION, {
        "people not yet involved": outOfReach
          .map((p) => `- ${p.name} (${p.title}), involved ${IN_WORLD_TIMING[p.unlockedAtStage]}`)
          .join("\n"),
      }),
    );
  }

  sections.push(fillPromptTemplate(PERSONA_REPLY_RULES, { "persona title": persona.title }));

  return sections.join("\n\n");
}

/** The system prompt for the single style rewrite: the original prompt with
 * the draft and the rules it broke appended. */
export function buildStyleRetrySystem(system: string, draft: string, problems: string): string {
  return [
    system,
    fillPromptTemplate(PERSONA_STYLE_RETRY_SECTION, { "draft reply": draft, "style problems": problems }),
  ].join("\n\n");
}

/** The withheld-fact ids a persona reported, kept only when they are its own,
 * deduplicated, in the card's order. */
export function validRevealedIds(persona: ScenarioPersona, reported: readonly string[] | undefined): string[] {
  const wanted = new Set((reported ?? []).map((id) => id.trim().replace(/^\[|\]$/g, "")));
  return (persona.withheld ?? []).map((w) => w.id).filter((id) => wanted.has(id));
}

function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

const REPORTED_RESULT = /\b(?:auc|accuracy|precision|recall|f1|rmse|mae|mape|r-?squared|the (?:model|analysis|memo|report|consultant) (?:shows?|showed|found|finds|reports?|reported|achieved|achieves|scored))\b/i;

/**
 * A persona may record only what it knows: its own decisions, constraints,
 * requests and the facts in its brief. A fact is dropped when it quotes a
 * figure that the learner wrote (in a submission or in chat) but that
 * appears nowhere in the record, the persona's brief or the other known
 * sources (a learner-reported number), or when it restates a reported model
 * result. Used for gate reactions and, since persona-v4, for chat turns.
 * Returns the facts kept and the number dropped. Pure.
 */
export function filterLearnerNumberFacts(
  facts: string[],
  context: { learnerText: string; ledger: string[]; persona: ScenarioPersona; extraKnown?: string[] },
): { kept: string[]; dropped: number } {
  const known = new Set(
    numbersIn(
      [
        ...context.ledger,
        context.persona.card,
        ...(context.persona.withheld ?? []).map((w) => w.fact),
        ...(context.persona.frictions ?? []).map((f) => f.text),
        ...(context.extraKnown ?? []),
      ].join("\n"),
    ),
  );
  const learner = new Set(numbersIn(context.learnerText));
  const kept = facts.filter((f) => {
    if (REPORTED_RESULT.test(f)) return false;
    return !numbersIn(f).some((n) => learner.has(n) && !known.has(n));
  });
  return { kept, dropped: facts.length - kept.length };
}

/** The reaction's filter: the submission is the learner's text. */
export function filterReactionFacts(
  facts: string[],
  context: { submissionText: string; ledger: string[]; persona: ScenarioPersona },
): { kept: string[]; dropped: number } {
  return filterLearnerNumberFacts(facts, {
    learnerText: context.submissionText,
    ledger: context.ledger,
    persona: context.persona,
  });
}

export type ReactionOutcome = keyof typeof PERSONA_REACTION_INSTRUCTIONS;

/** Which brief an outcome's reaction uses, picked from a seed (the
 * engagement id and stage), so a channel's reactions vary but a given
 * reaction is reproducible. Pure. */
export function pickReactionVariant(outcome: ReactionOutcome, seed: string): number {
  let h = 0;
  for (const ch of seed) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return h % PERSONA_REACTION_INSTRUCTIONS[outcome].length;
}

/** The user message for the client sponsor's reaction to a gate submission.
 * The stage reaches it twice: by title here, and through the system prompt,
 * which lists only the pressures whose stage has been reached. */
export function buildReactionPrompt(input: {
  artifactKind: string;
  stageTitle: string;
  submissionExcerpt: string;
  recentTurns: string[];
  outcome: ReactionOutcome;
  // Index into the outcome's briefs (pickReactionVariant); 0 by default.
  variant?: number;
  // The reaction opens a stage whose pressure the sponsor brings.
  raiseFriction?: boolean;
}): string {
  const briefs = PERSONA_REACTION_INSTRUCTIONS[input.outcome];
  const brief = briefs[(input.variant ?? 0) % briefs.length];
  const instruction = input.raiseFriction ? `${brief} ${PERSONA_REACTION_FRICTION}` : brief;
  const recent =
    input.recentTurns.length > 0
      ? fillPromptTemplate(PERSONA_REACTION_RECENT, { "recent turns": input.recentTurns.join("\n") })
      : "";
  return fillPromptTemplate(PERSONA_REACTION_TEMPLATE, {
    "artifact kind": input.artifactKind.replace(/-/g, " "),
    "stage title": input.stageTitle.toLowerCase(),
    "submission excerpt": input.submissionExcerpt,
    "recent exchange": recent,
    "reaction instruction": instruction,
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
