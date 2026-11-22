// persona-v6: a persona's own withheld facts stay withheld until the learner
// asks for them. The persona prompt already says so, but in one probe the
// client sponsor's gate reaction stated both of her withheld
// facts (the S$30 offer cost and the six-month save rule) to a learner who
// had never asked, and reported them as shared. The persona-v5 reaction
// filter exempted the sponsor's own reported facts, so nothing caught it.
//
// The rule enforced here: a withheld fact of the speaking persona that has
// not been obtained in this engagement may appear in a chat reply only when
// the learner's current message meets its reveal condition, and never in a
// gate reaction (there is no learner question to meet it). The condition is
// read from the fact's ask_cues, matched like its keys (findKey); a fact
// without cues falls back to the persona's own report that it shared the
// fact. A fact "appears" when one of its keys is in the text. The callers
// (lib/agents/orchestrator.ts, lib/agents/stage-gate.ts) regenerate an
// offending draft once with PERSONA_WITHHELD_LEAK_RETRY, strip any sentence
// that still states the fact, and log WITHHELD_LEAK_EVENT. Pure.
//
// persona-v7: for a fact that is also a file's undocumented defect, the
// guard reads the defect's keys as well as the fact's (guardedPersona), so
// the data owner cannot volunteer the defect itself ("the extract is not
// guaranteed one row per subscriber, so dedupe") without naming its cause

import { findKey } from "@/lib/engagement/elicitation";
import { fillPromptTemplate, PERSONA_WITHHELD_LEAK_RETRY } from "@/lib/agents/prompt-provenance";
import type { Scenario, ScenarioPersona, WithheldFact } from "@/lib/scenarios/types";

export const WITHHELD_LEAK_EVENT = "withheld_leak_blocked";

export type WithheldChannel = "chat" | "reaction";

type Fact = Pick<WithheldFact, "id" | "keys" | "revealWhen"> & { askCues?: readonly string[] };

/**
 * Whether the learner's message meets the fact's reveal condition. A gate
 * reaction has no learner message (null), so the condition is never met
 * there. With cues, one of them must appear in the message; without cues,
 * the persona's report that it shared the fact stands in for the condition.
 */
export function revealConditionMet(
  fact: Fact,
  learnerMessage: string | null,
  reportedIds: readonly string[] = [],
): boolean {
  if (learnerMessage === null) return false;
  const cues = fact.askCues ?? [];
  if (cues.length > 0) return findKey(learnerMessage, cues) !== null;
  return reportedIds.includes(fact.id);
}

/**
 * The persona's own withheld facts that the text states (a key appears)
 * although the learner has not obtained them and the learner's current
 * message does not meet their condition. `learnerMessage` is null for a gate
 * reaction.
 */
export function blockedWithheld(
  persona: Pick<ScenarioPersona, "withheld">,
  text: string,
  input: { obtained: Iterable<string>; learnerMessage: string | null; reportedIds?: readonly string[] },
): Fact[] {
  const obtained = new Set(input.obtained);
  return (persona.withheld ?? []).filter(
    (w) =>
      !obtained.has(w.id) &&
      findKey(text, w.keys) !== null &&
      !revealConditionMet(w, input.learnerMessage, input.reportedIds ?? []),
  );
}

/**
 * The persona's own withheld facts, not yet obtained, whose condition the
 * learner's current message does not meet: the facts a reply may not state
 * and may not report sharing. For a reaction, every unobtained fact.
 */
export function unmetWithheld(
  persona: Pick<ScenarioPersona, "withheld">,
  input: { obtained: Iterable<string>; learnerMessage: string | null; reportedIds?: readonly string[] },
): Fact[] {
  const obtained = new Set(input.obtained);
  return (persona.withheld ?? []).filter(
    (w) => !obtained.has(w.id) && !revealConditionMet(w, input.learnerMessage, input.reportedIds ?? []),
  );
}

/**
 * The persona as the guard reads it: each withheld fact that is also an
 * undocumented defect of one of the scenario's files carries that defect's
 * keys (the dataset's `defects` entry with the same id) beside its own.
 * Only the guard uses the widened keys; the elicitation trace still
 * verifies a reveal on the fact's own keys. Pure.
 */
export function guardedPersona<P extends Pick<ScenarioPersona, "withheld">>(
  persona: P,
  scenario: Pick<Scenario, "datasets">,
): P {
  const extra = new Map<string, string[]>();
  for (const d of scenario.datasets) {
    const undocumented = new Set(d.undocumentedDefects ?? []);
    for (const defect of d.defects ?? []) {
      if (undocumented.has(defect.id)) extra.set(defect.id, [...(extra.get(defect.id) ?? []), ...defect.keys]);
    }
  }
  if (extra.size === 0 || !(persona.withheld ?? []).some((w) => extra.has(w.id))) return persona;
  return {
    ...persona,
    withheld: (persona.withheld ?? []).map((w) =>
      extra.has(w.id) ? { ...w, keys: [...w.keys, ...extra.get(w.id)!.filter((k) => !w.keys.includes(k))] } : w,
    ),
  };
}

/** The corrective line for the single regeneration. */
export function withheldLeakNote(facts: readonly Pick<WithheldFact, "revealWhen">[]): string {
  const points = facts.map((f) => `the point you share only when ${f.revealWhen.trim().replace(/\.$/, "")}`);
  return fillPromptTemplate(PERSONA_WITHHELD_LEAK_RETRY, { "withheld points": points.join("; ") });
}
