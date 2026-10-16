// A sponsor's staged pressure (a scope request, for example) and whether it
// has been raised. A friction becomes active once the engagement reaches its
// stage, and the sponsor raises it in the reaction to the gate that opens
// that stage, so the stage's report has to deal with it. Since persona-v5 a
// friction counts as raised only when the persona reports its id
// (raisedFrictions) and one of the friction's keys appears in the reply:
// the id alone is the model's word, and a key alone matched ordinary talk
// ("promotion" in a question about promo days). The friction's ledger
// sentence is then written with provenance "detected", which the judge reads
// as a claim rather than as established. The judge treats a friction that
// was never raised as not applicable. Once raised, it drops out of the
// persona's list of pressures, so it is not raised twice.

import { findKey } from "@/lib/engagement/elicitation";
import { stageReached, type Friction, type ScenarioPersona, type StageId } from "@/lib/scenarios/types";

export const FRICTION_RAISED_EVENT = "friction_raised";

/** Whether the ledger already records this friction as raised. Pure. */
export function frictionRaised(friction: Friction, ledgerFacts: readonly string[]): boolean {
  return ledgerFacts.some((f) => f.trim() === friction.ledger.trim());
}

/** The persona's frictions whose stage has been reached and that have not
 * been raised yet. Pure. */
export function pendingFrictions(
  persona: ScenarioPersona,
  stage: StageId,
  ledgerFacts: readonly string[] = [],
): Friction[] {
  return (persona.frictions ?? []).filter((f) => stageReached(stage, f.stage) && !frictionRaised(f, ledgerFacts));
}

/** The pending frictions whose stage is exactly `stage`: the ones the
 * reaction that opens that stage delivers. Pure. */
export function frictionsOpeningAt(
  persona: ScenarioPersona,
  stage: StageId,
  ledgerFacts: readonly string[] = [],
): Friction[] {
  return pendingFrictions(persona, stage, ledgerFacts).filter((f) => f.stage === stage);
}

/** Of the frictions offered to the persona, those whose key appears in the
 * reply. Pure. */
export function frictionsRaisedIn(reply: string, offered: readonly Friction[]): Friction[] {
  return offered.filter((f) => findKey(reply, f.keys) !== null);
}

/**
 * Of the frictions offered to the persona, those the reply raised: the
 * persona reported the friction's id in raisedFrictions and one of its keys
 * appears in the reply. Ids may come bracketed ("[upsell-request]"). Pure.
 */
export function frictionsReportedAndRaised(
  reply: string,
  offered: readonly Friction[],
  reportedIds: readonly string[] | undefined,
): Friction[] {
  const wanted = new Set((reportedIds ?? []).map((id) => id.trim().replace(/^\[|\]$/g, "")));
  return frictionsRaisedIn(reply, offered.filter((f) => wanted.has(f.id)));
}

/** Frictions whose key the reply holds but whose id the persona did not
 * report (or the reverse), for the friction_unconfirmed event. Pure. */
export function frictionsHalfRaised(
  reply: string,
  offered: readonly Friction[],
  reportedIds: readonly string[] | undefined,
): { id: string; reported: boolean; keyMatched: boolean }[] {
  const wanted = new Set((reportedIds ?? []).map((id) => id.trim().replace(/^\[|\]$/g, "")));
  return offered
    .map((f) => ({ id: f.id, reported: wanted.has(f.id), keyMatched: findKey(reply, f.keys) !== null }))
    .filter((f) => f.reported !== f.keyMatched);
}

export const FRICTION_UNCONFIRMED_EVENT = "friction_unconfirmed";
