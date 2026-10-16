// Elicitation trace. Each persona card keeps some facts back until the
// learner asks the right question. When a persona reply shares one, the
// persona reports the fact's id (revealedWithheld). The server then checks
// the report against the delivered reply: the reveal is verified only when
// one of the fact's keys (figures or short phrases from the scenario YAML)
// appears in the reply. The server also scans every delivered
// reply for the keys of the persona's own withheld facts that are not yet
// obtained, whatever the persona reported, so a reveal the model did not
// report is still recorded (detection "detected", verified by key; a
// self-reported one is "reported"). Each fact gets one row in
// fact_elicitations, which the retention purge does not touch, and a
// fact_elicited event, with the persona, that persona's turn index, how many
// messages the learner had sent by then, and whether the reveal was
// verified. A verified reveal is also written once into the world-fact
// ledger with provenance "elicited", so every persona and the judge read it
// as established. Every reply that reveals a fact is audited, and a reveal
// the auditor flags as an early disclosure is marked early on its row. The
// summary below turns those records into the measure a run reports: hidden
// facts obtained and verified, out of those in the scenario, with the
// learner messages each one took.
//
// Key matching normalises both sides first (number words to digits, "S$ 30"
// to "s$30", hyphens between words to spaces), so "six-month", "6 months"
// and "six months" all meet the key "6 month".
//
// An engagement that predates the trace has no rows because nothing was
// recorded, not because nothing was obtained; elicitationTraceRecorded tells
// the two apart so views can show "not recorded" rather than 0 of N.
//
// The platform records elicitation; it does not compare elicitation
// behaviour across learners.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { factElicitations } from "@/lib/db/schema";
import {
  appendWorldFacts,
  getChannels,
  getEngagement,
  getEvents,
  getMessages,
  logEvent,
  type Engagement,
} from "@/lib/engagement/state";
import { countExchanges, type ChannelTranscript, type ConversationRecord } from "@/lib/engagement/conversation-record";
import { loadScenario } from "@/lib/scenarios/load";
import {
  stageReached,
  type Scenario,
  type ScenarioPersona,
  type StageId,
  type WithheldFact,
} from "@/lib/scenarios/types";

export const FACT_ELICITED_EVENT = "fact_elicited";

export interface FactElicitedDetail {
  factId: string;
  persona: string;
  // 1-based index of the persona's reply in its channel (a gate reaction
  // counts as a reply in the sponsor's channel).
  turnIndex: number;
  // Learner messages sent across all channels up to and including the one
  // that drew the fact out.
  learnerMessagesSoFar: number;
  // Whether one of the fact's keys appears in the delivered reply. Absent on
  // events logged before the check existed, which count as unverified.
  verified?: boolean;
  matchedKey?: string | null;
  // How the reveal was found: the persona reported it, or the server found
  // a key in a reply that did not report it. Absent on rows stored before
  // detection existed (reported).
  detection?: ElicitationDetection;
  // The auditor flagged the reveal as an early disclosure. Absent on rows stored before
  // the flag existed (false).
  early?: boolean;
}

export type ElicitationDetection = "reported" | "detected";

export interface ElicitationFact {
  id: string;
  persona: string;
  // The learner-message count at which the persona first reported the fact,
  // or null when it never did.
  obtainedAtLearnerMessage: number | null;
  // The learner-message count at which a reply first verifiably stated it,
  // or null when none did.
  verifiedAtLearnerMessage: number | null;
  // How the first record of the fact was found, or null when never obtained.
  detection: ElicitationDetection | null;
  // The auditor flagged the reveal as an early disclosure: the persona
  // stated it before the learner met its condition, so it measures the
  // persona's leak rather than the learner's question.
  early: boolean;
}

export interface ElicitationSummary {
  // Withheld facts in the scenario, across every persona.
  total: number;
  // Withheld facts whose persona's channel is open at the engagement's
  // current stage (all of them once the engagement is complete).
  reachable: number;
  // Facts the persona model reported sharing (its own structured output).
  obtained: number;
  // Of those, facts whose key appeared in the delivered reply.
  verified: number;
  // Of the obtained facts, those found by the key scan without a report.
  detected: number;
  // Of the obtained facts, those the auditor flagged as disclosed early.
  early: number;
  facts: ElicitationFact[];
}

interface EventLike {
  type: string;
  detailJson: unknown;
}

// ---------------------------------------------------------------------------
// Key matching
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};
const NUMBER_WORDS: Record<string, number> = {
  ...UNITS,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const UNIT_WORDS = Object.keys(UNITS).join("|");

/**
 * The text as key matching sees it. Lower case; curly quotes straightened;
 * thousands separators dropped ("6,000" to "6000"); currency written
 * "S$ 30", "SGD 30" or "30 SGD" becomes "s$30"; number words become digits
 * ("twenty-three" to "23", "six" to "6"); a hyphen between words, or
 * between a figure and a word, becomes a space ("six-month" to "6 month",
 * "mid-month" to "mid month"); a range "10 to 20%" becomes "10-20%"; runs of
 * spaces collapse. Keys go through the same function. Pure.
 */
export function normaliseForKeys(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2013]/g, "-")
    .replace(/(\d),(?=\d{3}\b)/g, "$1");
  t = t
    .replace(new RegExp(`\\b(${TENS})[\\s-]+(${UNIT_WORDS})\\b`, "g"), (_m, tens: string, unit: string) =>
      String(NUMBER_WORDS[tens] + NUMBER_WORDS[unit]),
    )
    .replace(new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "g"), (w) => String(NUMBER_WORDS[w]));
  t = t
    .replace(/\bsgd\s*(?=\d)/g, "s$")
    .replace(/(\d+(?:\.\d+)?)\s*sgd\b/g, "s$$$1")
    .replace(/\$\s+(?=\d)/g, "$")
    .replace(/(\d+)%?\s*(?:to|-)\s*(\d+)%/g, "$1-$2%")
    .replace(/([a-z0-9])-(?=[a-z])/g, "$1 ")
    .replace(/([a-z])-(?=[0-9])/g, "$1 ")
    .replace(/\s+/g, " ");
  return t;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The first key that appears in the text, or null. Both sides are
 * normalised (normaliseForKeys). A key that starts with a letter or digit
 * must start a word ("rain" does not match "drain"); a key that ends in a
 * digit must not run on into another digit ("$30" does not match "$300");
 * a key whose last word is a single letter must end there ("starts with t"
 * does not match "starts with the"). Otherwise a key that ends in a letter
 * may run on ("plan change" matches "plan changes"). Pure.
 */
export function findKey(text: string, keys: readonly string[]): string | null {
  const hay = normaliseForKeys(text);
  for (const key of keys) {
    const k = normaliseForKeys(key.trim()).trim();
    if (!k) continue;
    const start = /^[a-z0-9]/.test(k) ? "(?:^|[^a-z0-9])" : "";
    const end = /[0-9]$/.test(k) ? "(?![0-9])" : /(?:^|[^a-z0-9])[a-z]$/.test(k) ? "(?![a-z0-9])" : "";
    if (new RegExp(`${start}${escapeRegExp(k)}${end}`).test(hay)) return key;
  }
  return null;
}

/** Whether the delivered reply states the withheld fact. Pure. */
export function verifyReveal(fact: Pick<WithheldFact, "keys">, reply: string): { verified: boolean; matchedKey: string | null } {
  const matchedKey = findKey(reply, fact.keys ?? []);
  return { verified: matchedKey !== null, matchedKey };
}

/**
 * The persona's own withheld facts whose keys appear in the reply, leaving
 * out the ids in `skip` (facts already verified in this engagement, or
 * reported in this reply). Only the replying persona's facts are scanned:
 * no other persona is given them, so a match in another persona's reply is
 * a false positive by construction. Pure.
 */
export function detectUnreportedReveals(
  persona: Pick<ScenarioPersona, "withheld">,
  reply: string,
  skip: Iterable<string> = [],
): { factId: string; matchedKey: string }[] {
  const skipped = new Set(skip);
  const out: { factId: string; matchedKey: string }[] = [];
  for (const w of persona.withheld ?? []) {
    if (skipped.has(w.id)) continue;
    const matchedKey = findKey(reply, w.keys ?? []);
    if (matchedKey !== null) out.push({ factId: w.id, matchedKey });
  }
  return out;
}

// The first persona prompt version that carried withheld-fact ids
// (persona-v3); a run whose persona events all predate it has no trace.
export const FIRST_TRACED_PERSONA_VERSION = 3;

const PERSONA_EVENT_TYPES = new Set(["persona_turn", "client_reaction", "identity_question", "persona_style_retry"]);

function personaVersionNumber(version: unknown): number | null {
  const m = typeof version === "string" ? /^persona-v(\d+)$/.exec(version) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Whether the engagement recorded an elicitation trace, so that an empty
 * trace means "0 obtained" rather than "not recorded". True when the
 * engagement row says so (set at creation since migration 0014), when any
 * fact_elicited event or stored row exists (pass rows through
 * elicitationRowsAsEvents), or when any persona event was logged under
 * persona-v3 or later. False for a run whose persona events carry no
 * version or an older one, such as an older showcase snapshot. Pure.
 */
export function elicitationTraceRecorded(input: {
  elicitationTrace?: boolean | null;
  events: readonly EventLike[];
}): boolean {
  if (input.elicitationTrace === true) return true;
  for (const e of input.events) {
    if (e.type === FACT_ELICITED_EVENT) return true;
    if (!PERSONA_EVENT_TYPES.has(e.type)) continue;
    const v = personaVersionNumber((e.detailJson as { promptVersion?: unknown } | null)?.promptVersion);
    if (v !== null && v >= FIRST_TRACED_PERSONA_VERSION) return true;
  }
  return false;
}

// What a view shows in place of "0 of N" when no trace was recorded.
export const ELICITATION_NOT_RECORDED_LABEL = "not recorded (the run predates the trace)";

/**
 * Withheld facts that a criterion names (a key appears in the criterion or
 * its constraints) and that the submission states, although the trace does
 * not show them as obtained. The instructor's "stated but not elicited"
 * flag (rubric-v7). Facts listed as a dataset's undocumented defect are left
 * out: profiling the released file can reveal those without a question.
 * Pure.
 */
export function statedButNotElicited(input: {
  scenario: Scenario;
  criterion: { criterion: string; constraints?: readonly string[] };
  submissionText: string;
  obtainedFactIds: Iterable<string>;
}): string[] {
  const obtained = new Set(input.obtainedFactIds);
  const discoverable = new Set(input.scenario.datasets.flatMap((d) => d.undocumentedDefects ?? []));
  const named = [input.criterion.criterion, ...(input.criterion.constraints ?? [])].join("\n");
  return input.scenario.personas
    .flatMap((p) => p.withheld ?? [])
    .filter(
      (w) =>
        !obtained.has(w.id) &&
        !discoverable.has(w.id) &&
        findKey(named, w.keys) !== null &&
        findKey(input.submissionText, w.keys) !== null,
    )
    .map((w) => w.id);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function elicitedDetails(events: readonly EventLike[]): FactElicitedDetail[] {
  return events
    .filter((e) => e.type === FACT_ELICITED_EVENT)
    .map((e) => e.detailJson as Partial<FactElicitedDetail> | null)
    .filter(
      (d): d is FactElicitedDetail =>
        !!d && typeof d.factId === "string" && typeof d.learnerMessagesSoFar === "number",
    );
}

/** Pure: the summary for one engagement's events (or stored rows turned into
 * events by elicitationRowsAsEvents). `stage` is the current stage, or null
 * for a completed engagement (every persona reachable). */
export function summariseElicitation(
  scenario: Scenario,
  events: readonly EventLike[],
  stage: StageId | null,
): ElicitationSummary {
  const first = new Map<string, number>();
  const firstVerified = new Map<string, number>();
  const detection = new Map<string, ElicitationDetection>();
  const early = new Set<string>();
  for (const d of elicitedDetails(events)) {
    const seen = first.get(d.factId);
    if (seen === undefined || d.learnerMessagesSoFar < seen) {
      first.set(d.factId, d.learnerMessagesSoFar);
      detection.set(d.factId, d.detection === "detected" ? "detected" : "reported");
    }
    if (d.early === true) early.add(d.factId);
    if (d.verified === true) {
      const v = firstVerified.get(d.factId);
      if (v === undefined || d.learnerMessagesSoFar < v) firstVerified.set(d.factId, d.learnerMessagesSoFar);
    }
  }
  const facts: ElicitationFact[] = [];
  let reachable = 0;
  for (const p of scenario.personas) {
    const open = stage === null || stageReached(stage, p.unlockedAtStage);
    for (const w of p.withheld ?? []) {
      if (open) reachable += 1;
      facts.push({
        id: w.id,
        persona: p.id,
        obtainedAtLearnerMessage: first.get(w.id) ?? null,
        verifiedAtLearnerMessage: firstVerified.get(w.id) ?? null,
        detection: detection.get(w.id) ?? null,
        early: early.has(w.id),
      });
    }
  }
  return {
    total: facts.length,
    reachable,
    obtained: facts.filter((f) => f.obtainedAtLearnerMessage !== null).length,
    verified: facts.filter((f) => f.verifiedAtLearnerMessage !== null).length,
    detected: facts.filter((f) => f.obtainedAtLearnerMessage !== null && f.detection === "detected").length,
    early: facts.filter((f) => f.obtainedAtLearnerMessage !== null && f.early).length,
    facts,
  };
}

type ElicitationRow = typeof factElicitations.$inferSelect;

/** Stored fact_elicitations rows in the event shape summariseElicitation
 * reads, so pages that read the table (which outlives the event purge) and
 * pages that read events share one summary. Pure. */
export function elicitationRowsAsEvents(rows: readonly ElicitationRow[]): EventLike[] {
  return rows.map((r) => ({
    type: FACT_ELICITED_EVENT,
    detailJson: {
      factId: r.factId,
      persona: r.personaId,
      turnIndex: r.turnIndex,
      learnerMessagesSoFar: r.learnerMessagesSoFar,
      verified: r.verified,
      matchedKey: r.matchedKey,
      detection: r.detection === "detected" ? "detected" : "reported",
      early: r.early === true,
    } satisfies FactElicitedDetail,
  }));
}

export async function getElicitationRows(engagementId: string): Promise<ElicitationRow[]> {
  return db.select().from(factElicitations).where(eq(factElicitations.engagementId, engagementId));
}

/** Withheld-fact ids already shared in this engagement (reported or
 * verified), for the auditor's early-disclosure check. */
export async function getSharedFactIds(engagementId: string): Promise<string[]> {
  return (await getElicitationRows(engagementId)).map((r) => r.factId);
}

/** Withheld-fact ids obtained in this engagement (any row, reported or
 * detected, verified or not). */
export async function getObtainedFactIds(engagementId: string): Promise<string[]> {
  return getSharedFactIds(engagementId);
}

/** Marks the rows of these facts as early disclosures (the auditor listed
 * them) and logs one event. Ids with no row are ignored. */
export async function markEarlyDisclosures(engagement: Engagement, factIds: readonly string[]): Promise<void> {
  const ids = [...new Set(factIds)];
  if (ids.length === 0) return;
  for (const factId of ids) {
    await db
      .update(factElicitations)
      .set({ early: true })
      .where(and(eq(factElicitations.engagementId, engagement.id), eq(factElicitations.factId, factId)));
  }
  await logEvent(engagement.id, engagement.cohortId, FACT_EARLY_EVENT, { factIds: ids });
}

export const FACT_EARLY_EVENT = "fact_elicited_early";

/** Whether this engagement recorded an elicitation trace (see
 * elicitationTraceRecorded). Throws for an unknown id. */
export async function getElicitationTraceRecorded(engagementId: string): Promise<boolean> {
  const engagement = await getEngagement(engagementId);
  if (!engagement) throw new Error(`Unknown engagement ${engagementId}`);
  if (engagement.elicitationTrace === true) return true;
  const [events, rows] = await Promise.all([getEvents(engagementId), getElicitationRows(engagementId)]);
  return elicitationTraceRecorded({ elicitationTrace: engagement.elicitationTrace, events: [...elicitationRowsAsEvents(rows), ...events] });
}

/** Each channel's messages, oldest first, for the judge (rubric-v8). A
 * message sent by anyone other than the learner or agent is the channel's
 * stakeholder. */
export async function getChannelTranscripts(engagementId: string, scenario: Scenario): Promise<ChannelTranscript[]> {
  const channels = await getChannels(engagementId);
  const out: ChannelTranscript[] = [];
  for (const c of channels) {
    const persona = scenario.personas.find((p) => p.id === c.personaId);
    if (!persona) continue;
    const messages = await getMessages(c.id);
    out.push({
      personaId: persona.id,
      name: persona.name,
      messages: messages.map((m) => ({ fromConsultant: m.sender === "learner", text: m.content })),
    });
  }
  return out;
}

/** The conversation record the judge reads (rubric-v7): message counts per
 * stakeholder from the persona_turn events, whether a trace was recorded,
 * and the facts obtained; since rubric-v8 also the channel transcripts. */
export async function getConversationRecord(
  engagement: Engagement,
  scenario: Scenario,
  stage: StageId,
): Promise<ConversationRecord> {
  const [events, rows, transcripts] = await Promise.all([
    getEvents(engagement.id),
    getElicitationRows(engagement.id),
    getChannelTranscripts(engagement.id, scenario),
  ]);
  return {
    stage,
    personas: countExchanges(scenario, events, stage),
    traceRecorded: elicitationTraceRecorded({
      elicitationTrace: engagement.elicitationTrace,
      events: [...elicitationRowsAsEvents(rows), ...events],
    }),
    obtainedFactIds: rows.map((r) => r.factId),
    transcripts,
  };
}

/** The elicitation trace of one engagement, with whether one was recorded
 * at all. Throws for an unknown id. Reads the stored rows, and falls back to
 * events for facts a run logged before the table existed. */
export async function getElicitationSummary(engagementId: string): Promise<ElicitationSummary & { recorded: boolean }> {
  const engagement = await getEngagement(engagementId);
  if (!engagement) throw new Error(`Unknown engagement ${engagementId}`);
  const [scenario, events, rows] = await Promise.all([
    loadScenario(engagement.scenarioId),
    getEvents(engagementId),
    getElicitationRows(engagementId),
  ]);
  const stored = new Set(rows.map((r) => r.factId));
  const legacy = events.filter(
    (e) => e.type === FACT_ELICITED_EVENT && !stored.has((e.detailJson as { factId?: string } | null)?.factId ?? ""),
  );
  const stage = engagement.status === "completed" ? null : (engagement.currentStage as StageId);
  const asEvents = [...elicitationRowsAsEvents(rows), ...legacy];
  return {
    ...summariseElicitation(scenario, asEvents, stage),
    recorded: elicitationTraceRecorded({ elicitationTrace: engagement.elicitationTrace, events: [...asEvents, ...events] }),
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecordedElicitation {
  factId: string;
  verified: boolean;
  matchedKey: string | null;
  detection: ElicitationDetection;
}

/** The ledger sentence for an elicited fact: the fact's plain statement
 * (the card's `statement`, or its fact text). */
export function elicitedLedgerFact(fact: Pick<WithheldFact, "fact"> & { statement?: string }): string {
  return (fact.statement ?? fact.fact).trim();
}

/**
 * Records each fact: a new row (and a fact_elicited event) the first time a
 * fact is recorded in this engagement, and an update (and a second event)
 * when a fact first recorded unverified is later stated verifiably. Ids that
 * are not the persona's own withheld facts are ignored. A fact that becomes
 * verified here is written once into the ledger with provenance "elicited".
 * `detection` says how the ids were found: "reported" by the persona, or
 * "detected" by the key scan (detectUnreportedReveals). Returns what was
 * newly recorded or newly verified.
 */
export async function recordElicitedFacts(input: {
  engagement: Engagement;
  persona: ScenarioPersona;
  factIds: string[];
  // The reply as delivered to the learner.
  reply: string;
  stage: StageId;
  source: "turn" | "reaction";
  turnIndex: number;
  learnerMessagesSoFar: number;
  messageId?: number | null;
  detection?: ElicitationDetection;
}): Promise<RecordedElicitation[]> {
  const detection: ElicitationDetection = input.detection ?? "reported";
  const own = new Map((input.persona.withheld ?? []).map((w) => [w.id, w]));
  const ids = [...new Set(input.factIds)].filter((id) => own.has(id));
  if (ids.length === 0) return [];
  const existing = new Map((await getElicitationRows(input.engagement.id)).map((r) => [r.factId, r]));
  const out: RecordedElicitation[] = [];
  const ledger: string[] = [];
  for (const factId of ids) {
    const { verified, matchedKey } = verifyReveal(own.get(factId)!, input.reply);
    // A detected reveal exists only because a key matched.
    if (detection === "detected" && !verified) continue;
    const prior = existing.get(factId);
    if (prior && (prior.verified || !verified)) continue;
    if (prior) {
      await db
        .update(factElicitations)
        .set({
          verified: true,
          matchedKey,
          verifiedAt: new Date(),
        })
        .where(and(eq(factElicitations.engagementId, input.engagement.id), eq(factElicitations.factId, factId)));
    } else {
      await db
        .insert(factElicitations)
        .values({
          engagementId: input.engagement.id,
          factId,
          personaId: input.persona.id,
          stage: input.stage,
          source: input.source,
          turnIndex: input.turnIndex,
          learnerMessagesSoFar: input.learnerMessagesSoFar,
          verified,
          matchedKey,
          detection,
          messageId: input.messageId ?? null,
          verifiedAt: verified ? new Date() : null,
        })
        .onConflictDoNothing();
    }
    const detail: FactElicitedDetail = {
      factId,
      persona: input.persona.id,
      turnIndex: input.turnIndex,
      learnerMessagesSoFar: input.learnerMessagesSoFar,
      verified,
      matchedKey,
      detection: prior ? (prior.detection === "detected" ? "detected" : "reported") : detection,
    };
    await logEvent(input.engagement.id, input.engagement.cohortId, FACT_ELICITED_EVENT, { ...detail });
    if (verified) ledger.push(elicitedLedgerFact(own.get(factId)!));
    out.push({ factId, verified, matchedKey, detection: detail.detection ?? detection });
  }
  // A verified reveal is established: the reply stated it and the key check
  // confirmed it. Every persona and the judge read it from the ledger.
  await appendWorldFacts(input.engagement.id, input.stage, input.persona.id, ledger, "elicited");
  return out;
}

/**
 * Records the reveals in one delivered reply: the ids the persona reported
 * (verified against the reply), then every other withheld fact of this
 * persona whose key the reply states and which is not yet verified in this
 * engagement (detected). Returns what was newly recorded or verified.
 */
export async function recordRevealsInReply(input: {
  engagement: Engagement;
  persona: ScenarioPersona;
  reportedIds: string[];
  reply: string;
  stage: StageId;
  source: "turn" | "reaction";
  turnIndex: number;
  learnerMessagesSoFar: number;
  messageId?: number | null;
}): Promise<RecordedElicitation[]> {
  const { reportedIds, ...rest } = input;
  const reported =
    reportedIds.length > 0 ? await recordElicitedFacts({ ...rest, factIds: reportedIds, detection: "reported" }) : [];
  const verifiedAlready = (await getElicitationRows(input.engagement.id)).filter((r) => r.verified).map((r) => r.factId);
  const detected = detectUnreportedReveals(input.persona, input.reply, [...verifiedAlready, ...reportedIds]);
  const found =
    detected.length > 0
      ? await recordElicitedFacts({ ...rest, factIds: detected.map((d) => d.factId), detection: "detected" })
      : [];
  return [...reported, ...found];
}
