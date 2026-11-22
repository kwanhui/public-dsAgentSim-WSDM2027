// What the judge knows about the conversations behind a submission, since
// rubric-v7: how many messages the learner sent to each stakeholder (in all
// and at the current stage) and which kept-back points each stakeholder has
// shared. Since rubric-v8 the judge also reads each channel's transcript,
// with long messages shortened, so that it can check what a submission says
// a stakeholder said, confirmed or was shown (a memo once claimed that
// the end user had confirmed a cadence she had only asked about). Without these counts, a
// validation memo written without a single message to the end user could
// score well on the criteria about her concerns, because the absence of a
// conversation read as the absence of concerns.
//
// Counts come from persona_turn events: every learner or agent message
// that a persona answered logs one, with the persona and the stage. A
// message that failed before the persona answered is not stored and not
// counted, as for the message cap.

import { stageReached, STAGE_TITLES, type Scenario, type StageId } from "@/lib/scenarios/types";

export interface PersonaExchange {
  personaId: string;
  name: string;
  role: string;
  // The persona's channel is open at the stage.
  unlocked: boolean;
  learnerMessages: number;
  learnerMessagesThisStage: number;
}

export interface ConversationRecord {
  stage: StageId;
  personas: PersonaExchange[];
  // Whether the engagement recorded an elicitation trace; when false,
  // obtainedFactIds is empty because nothing was recorded.
  traceRecorded: boolean;
  // Withheld facts recorded as obtained (any fact_elicitations row).
  obtainedFactIds: string[];
  // rubric-v8: each open channel's messages, oldest first. Absent when the
  // caller did not load them; the judge then reads "(not available)".
  transcripts?: ChannelTranscript[];
}

export interface ChannelTranscript {
  personaId: string;
  name: string;
  messages: { fromConsultant: boolean; text: string }[];
}

interface EventLike {
  type: string;
  detailJson: unknown;
}

const ROLE_LABELS: Record<string, string> = {
  "client-sponsor": "client sponsor",
  "data-owner": "data owner",
  "end-user": "end user",
};

/** Learner messages per persona, in all and at `stage`, from persona_turn
 * events. Pure. */
export function countExchanges(
  scenario: Pick<Scenario, "personas">,
  events: readonly EventLike[],
  stage: StageId,
): PersonaExchange[] {
  const total = new Map<string, number>();
  const atStage = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "persona_turn") continue;
    const d = e.detailJson as { personaId?: unknown; stage?: unknown } | null;
    if (typeof d?.personaId !== "string") continue;
    total.set(d.personaId, (total.get(d.personaId) ?? 0) + 1);
    if (d.stage === stage) atStage.set(d.personaId, (atStage.get(d.personaId) ?? 0) + 1);
  }
  return scenario.personas.map((p) => ({
    personaId: p.id,
    name: p.name,
    role: p.role,
    unlocked: stageReached(stage, p.unlockedAtStage),
    learnerMessages: total.get(p.id) ?? 0,
    learnerMessagesThisStage: atStage.get(p.id) ?? 0,
  }));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The system fact appended when a stage ends: messages per open channel at
 * that stage. Pure. */
export function stageMessageCountFact(personas: readonly PersonaExchange[], stage: StageId): string {
  const open = personas.filter((p) => p.unlocked);
  const parts = open.map((p) => `${p.learnerMessagesThisStage} to ${p.name} (${ROLE_LABELS[p.role] ?? p.role})`);
  return `Messages at the "${STAGE_TITLES[stage]}" stage: the consultant sent ${parts.join(", ")}.`;
}

/**
 * The conversation record as the judge reads it (rubric-v7): one line per
 * stakeholder with the message counts and, when a trace was recorded, the
 * kept-back points shared so far and those not yet shared. Pure.
 */
export function renderConversationRecord(scenario: Pick<Scenario, "personas">, record: ConversationRecord): string {
  const obtained = new Set(record.obtainedFactIds);
  return record.personas
    .map((p) => {
      const persona = scenario.personas.find((x) => x.id === p.personaId);
      const counts = p.unlocked
        ? `${plural(p.learnerMessages, "message")} from the consultant in all, ${p.learnerMessagesThisStage} at this stage.`
        : "not yet reachable at this stage.";
      const withheld = persona?.withheld ?? [];
      let points = "";
      if (withheld.length > 0 && p.unlocked) {
        if (!record.traceRecorded) {
          points = " Kept-back points shared: not recorded for this run.";
        } else {
          const shared = withheld.filter((w) => obtained.has(w.id)).map((w) => w.statement.trim().replace(/\.$/, ""));
          const unshared = withheld.filter((w) => !obtained.has(w.id)).map((w) => w.statement.trim().replace(/\.$/, ""));
          points = ` Kept-back points shared with the consultant: ${shared.length > 0 ? shared.join("; ") : "none"}. Not shared: ${
            unshared.length > 0 ? unshared.join("; ") : "none"
          }.`;
        }
      }
      return `- ${p.name} (${ROLE_LABELS[p.role] ?? p.role}): ${counts}${points}`;
    })
    .join("\n");
}

/** The owner's exchange for a criterion, or null when the criterion names no
 * known owner. Pure. */
export function ownerExchange(record: ConversationRecord | undefined, owner: string | undefined): PersonaExchange | null {
  if (!record || !owner) return null;
  return record.personas.find((p) => p.personaId === owner) ?? null;
}

// Per message, the judge needs the gist of what was said, not every word of
// a pasted document.
export const TRANSCRIPT_MESSAGE_CHARS = 600;
// Per channel, the most recent messages; older ones are counted, not shown.
export const TRANSCRIPT_MAX_MESSAGES = 40;

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")} [...]` : t;
}

/**
 * The stakeholder transcripts as the judge reads them (rubric-v8): one block
 * per channel, the consultant's and the stakeholder's messages labelled,
 * each shortened to TRANSCRIPT_MESSAGE_CHARS. Pure.
 */
export function renderStakeholderTranscripts(record: ConversationRecord): string {
  const transcripts = record.transcripts;
  if (!transcripts) return "(not available)";
  if (transcripts.length === 0) return "(no channels)";
  return transcripts
    .map((t) => {
      const shown = t.messages.slice(-TRANSCRIPT_MAX_MESSAGES);
      const omitted = t.messages.length - shown.length;
      const lines = shown.map((m) => `  ${m.fromConsultant ? "Consultant" : t.name}: ${shorten(m.text, TRANSCRIPT_MESSAGE_CHARS)}`);
      const head = `- Channel with ${t.name}${omitted > 0 ? ` (the ${omitted} earliest messages are not shown)` : ""}:`;
      return lines.length > 0 ? `${head}\n${lines.join("\n")}` : `${head} no messages.`;
    })
    .join("\n");
}
