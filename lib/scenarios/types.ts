import { z } from "zod";

// =========================================================================
// Scenario config schema. One YAML file per scenario in configs/scenarios/.
// Configs are append-only once a cohort has run against them, so that a
// stored run always matches its config; breaking changes mean a new scenario id.
// =========================================================================

export const STAGE_IDS = [
  "formulation",
  "data-collection",
  "cleaning",
  "modelling",
  "testing",
  "deployment",
] as const;

export const StageId = z.enum(STAGE_IDS);
export type StageId = z.infer<typeof StageId>;

// Display names for the pipeline stages, matching the learner-facing stage
// titles used across the shipped scenarios. Instructor views use these so
// both sides of the platform speak the same language.
export const STAGE_TITLES: Record<StageId, string> = {
  formulation: "Problem formulation",
  "data-collection": "Data collection",
  cleaning: "Data cleaning",
  modelling: "Modelling",
  testing: "Testing & user validation",
  deployment: "Deployment & handover",
};

const RubricCriterionSchema = z.object({
  id: z.string(),
  // The full criterion, with the scenario facts it checks for. Read by the
  // judge and shown to instructors; never sent to the learner.
  criterion: z.string(),
  // The learner's wording of the same criterion: what is assessed, with no
  // figure, defect or other fact the learner is meant to find out. Written as a third-person verb phrase
  // ("States the operating constraints the client gave you."), so the
  // generic improve line can reuse it.
  learnerText: z.string(),
  maxScore: z.number().int().min(1).max(10),
  // Constraints the learner is expected to find out by asking, named in
  // the criterion (rubric-v6). The judge gives credit for stating each one,
  // partial credit for naming it as unknown and still to be confirmed, and
  // none for leaving it out. Never shown to the learner.
  constraints: z.array(z.string()).default([]),
  // The persona whose area this criterion's open questions fall in (a
  // persona id). A low-scoring criterion's improve line points the learner
  // to that stakeholder's area of ownership rather than repeating the
  // criterion. Absent when the gap is closed by the
  // learner's own work on the file.
  owner: z.string().optional(),
  // The criterion is about what the owner said (their concerns, their
  // reaction to the work). With no learner messages in the owner's channel
  // it earns at most partial credit (rubric-v7), whatever the artifact
  // claims the owner said: the absence of a conversation is not the absence
  // of concerns.
  requiresExchange: z.boolean().default(false),
});

const StageGateSchema = z.object({
  // Artifact kind the learner submits at this gate, e.g. problem-statement.
  kind: z.string(),
  // Learner-facing submission instructions.
  instructions: z.string(),
  rubric: z.array(RubricCriterionSchema).min(1),
});

const StageSchema = z.object({
  id: StageId,
  title: z.string(),
  // Learner-facing guidance shown in the stage panel.
  guidance: z.string(),
  gate: StageGateSchema,
});

// A fact the persona knows but keeps back until the consultant's message
// meets a condition, written in plain words ("the consultant asks how Finance
// defines a successful save"). The persona prompt lists these separately from
// the card, and the consistency auditor never sees them (only the public
// card), so a withheld fact is released by the persona, not by the platform.
// Each carries a stable id: the persona returns the ids it revealed
// (revealedWithheld), and the elicitation trace (lib/engagement/elicitation.ts)
// records when each was first obtained.
//
// keys: figures or short phrases, any one of which in
// the delivered reply shows that the fact was actually stated. A reveal the
// persona reports counts as verified only when a key appears in its reply
// (lib/engagement/elicitation.ts). The learner-view rationale filter uses
// the same keys to drop sentences that name a fact the learner never raised.
//
// statement: the fact in the third person, as the ledger records it once a
// reveal is verified (provenance "elicited"). Defaults to the fact text,
// which some cards write in the second person ("You want ...").
//
// Keys are matched after normalisation (lib/engagement/elicitation.ts
// normaliseForKeys): number words become digits and hyphens between words
// become spaces, so a key is written in that form ("6 month" covers
// "six-month", "6 months" and "six months"). tests/unit/withheld-keys.test.ts
// runs every key set against paraphrases and against the scenario's other
// texts.
//
// ask_cues (persona-v6): words or short phrases, any one of which in the
// learner's message shows that it meets reveal_when, matched the same way
// as keys. A chat reply may state a withheld fact the learner has not yet
// obtained only when the learner's current message holds one of its cues,
// and a gate reaction never may (lib/agents/withheld-guard.ts). When a fact
// has no cues, the persona's own report that it shared the fact stands in
// for the condition.
const WithheldFactSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    fact: z.string(),
    statement: z.string().optional(),
    reveal_when: z.string(),
    keys: z.array(z.string().min(1)).min(1),
    ask_cues: z.array(z.string().min(1)).default([]),
  })
  .transform((w) => ({
    id: w.id,
    fact: w.fact,
    statement: w.statement ?? w.fact,
    revealWhen: w.reveal_when,
    keys: w.keys,
    askCues: w.ask_cues,
  }));

// A pressure the persona brings once the work reaches a stage (the sponsor's
// scope request, for example). The persona prompt lists only the frictions
// whose stage the engagement has reached, so a gate reaction at formulation
// cannot raise a modelling-stage request.
//
// The sponsor delivers the friction in the reaction that opens
// its stage (the reaction to the previous gate), so the stage's report has
// to address it. A friction counts as raised only when the
// persona reports its id (raisedFrictions in the structured output) and one
// of its keys appears in the reply; the ledger sentence is then written with
// provenance "detected", which the judge reads as a claim, so the judge can
// tell a friction that was raised from one that never was (and treats the
// latter as not applicable). The id defaults to "<stage>-request".
const FrictionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    stage: StageId,
    text: z.string(),
    keys: z.array(z.string().min(1)).min(1),
    ledger: z.string(),
  })
  .transform((f) => ({ ...f, id: f.id ?? `${f.stage}-request` }));

const PersonaSchema = z.object({
  id: z.string(),
  // Which simulated party this persona is: drives orchestrator behaviour
  // (only data-owner personas can release datasets).
  role: z.enum(["client-sponsor", "data-owner", "end-user"]),
  name: z.string(),
  title: z.string(),
  // Channel label shown in the learner's sidebar.
  channelName: z.string(),
  // The stage at which this persona's channel unlocks.
  unlockedAtStage: StageId,
  // System-prompt persona card: personality, goals, knowledge, boundaries,
  // hidden frictions. Never shown to the learner.
  card: z.string(),
  // Facts kept back until asked for (see WithheldFactSchema).
  withheld: z.array(WithheldFactSchema).default([]),
  // Pressures raised from a given stage on (see FrictionSchema).
  frictions: z.array(FrictionSchema).default([]),
  // The open questions this persona answers. Every persona's list is shown
  // to every persona, so a question has one owner and the learner is not
  // sent back and forth.
  owns: z.array(z.string()).default([]),
});

const DatasetSchema = z.object({
  // File name under datasets/<scenario-id>/.
  file: z.string(),
  // Learner-facing description shown next to the download link.
  description: z.string(),
  // The data owner will not release this file before this stage.
  releasedAtStage: StageId,
  // Data dictionary the data-owner persona can consult and quote from.
  dictionary: z.string(),
  // Withheld facts (by id) that describe a seeded defect of this file and
  // are deliberately left out of the learner-facing dictionary and notes, so
  // that only profiling the file or a precise question to the data owner
  // reveals them. The scenario lint test
  // checks that the dictionary does not mention them.
  undocumentedDefects: z.array(z.string()).default([]),
  // Every seeded defect of this file, documented in the dictionary or not
  // with keys: words or short phrases, any one of which
  // in a text shows that it names the defect (matched like withheld-fact
  // keys, lib/engagement/elicitation.ts findKey). The learner's copy of a
  // judge rationale or improve line drops a sentence that names a defect the
  // submission does not name itself (lib/agents/rationale-filter.ts), so a
  // failed data audit does not hand the learner the list of problems to
  // find. An entry whose id is also an undocumented defect's withheld fact
  // extends that fact's keys in the data owner's withheld-fact guard, so the
  // data owner cannot volunteer it as a caution either.
  defects: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        keys: z.array(z.string().min(1)).min(1),
      }),
    )
    .default([]),
  // A sentence or two of the dictionary's notable semantics (category
  // mappings, known naming quirks). Written into the world-fact ledger when
  // the file is released, so judges and personas read the same data
  // semantics the learner was given instead of penalising the learner for
  // using them. Never shown to the learner directly.
  notes: z.string().optional(),
  // The columns each row is meant to be unique on. The release profile counts
  // repeated key values so the ledger records a duplicate-key defect even
  // when no two rows are identical. When absent, the first column named "id"
  // or ending in "_id" is used (lib/agents/dataset-profile.ts).
  keyColumns: z.array(z.string()).min(1).optional(),
});

export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  sector: z.string(),
  task: z.string(),
  // Learner-facing expectation of time commitment, e.g. "8-10 hours over 3 weeks".
  estimatedEffort: z.string().optional(),
  // Learner-facing engagement brief shown before and during the engagement.
  brief: z.string(),
  // Facts every persona starts out knowing; seeds the world-fact ledger.
  worldFactsSeed: z.array(z.string()),
  personas: z.array(PersonaSchema).min(1),
  stages: z.array(StageSchema).length(STAGE_IDS.length),
  datasets: z.array(DatasetSchema),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioPersona = z.infer<typeof PersonaSchema>;
export type WithheldFact = z.infer<typeof WithheldFactSchema>;
export type Friction = z.infer<typeof FrictionSchema>;
export type ScenarioStage = z.infer<typeof StageSchema>;
export type ScenarioDataset = z.infer<typeof DatasetSchema>;
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export function stageIndex(stage: StageId): number {
  return STAGE_IDS.indexOf(stage);
}

// True when `stage` is at or before `current` in the pipeline, i.e. content
// unlocked at `stage` is available.
export function stageReached(current: StageId, stage: StageId): boolean {
  return stageIndex(stage) <= stageIndex(current);
}

export function nextStage(current: StageId): StageId | null {
  const i = stageIndex(current);
  return i >= 0 && i < STAGE_IDS.length - 1 ? STAGE_IDS[i + 1] : null;
}
