// Provenance of a world-fact ledger entry. The ledger holds facts of very
// different standing: the scenario's own set-up, the deterministic profile of
// a released file, platform events, and facts that a stakeholder model wrote
// from its own reply. The first three are authoritative; the last is a claim
// made in conversation, which can be wrong (for example, a data
// owner recorded "one row per subscriber" for an extract with duplicate ids).
// The rubric judge reads the ledger grouped by this tag (rubric-v3).
//
// Two tags, "elicited" and "detected", were added after the first four. "elicited": a withheld fact that a
// persona's delivered reply stated and the key check confirmed
// (lib/engagement/elicitation.ts); the judge treats it as established.
// "detected": a sentence the platform wrote because of a keyword match on
// model text (a friction the persona reported and whose key the reply
// holds; lib/agents/frictions.ts); the judge treats it as a claim, since a
// keyword match is not ground truth.
//
// Dependency-free so the admin views can import it.

export const FACT_PROVENANCES = ["seed", "release-profile", "system", "persona", "elicited", "detected"] as const;
export type FactProvenance = (typeof FACT_PROVENANCES)[number];

export interface LedgerFact {
  fact: string;
  provenance: FactProvenance;
}

export function isFactProvenance(value: unknown): value is FactProvenance {
  return typeof value === "string" && (FACT_PROVENANCES as readonly string[]).includes(value);
}

// The fact text the release profile writes (lib/agents/dataset-profile.ts
// releaseWorldFact) and the two platform events that write to the ledger
// (lib/agents/stage-gate.ts, the monitor's force-advance).
const RELEASE_PREFIX = "The released file ";
const SYSTEM_PREFIXES = ["The consultant delivered the ", "The engagement moved past the "];

// The sentence written when the data owner's release is honoured
// (lib/agents/data-environment.ts). Its source is the data owner's persona
// id, but it records a platform event, so it is a system fact whatever the
// source (migration 0010 retags rows stored as persona).
export const RELEASE_EVENT_PREFIX = "The data owner released the dataset file ";

/** The tag for a row that has none stored: rows written before migration
 * 0009 and rows restored from an older snapshot. Migration 0009 backfills
 * stored rows with the same rule. */
export function inferProvenance(source: string, fact: string): FactProvenance {
  if (fact.startsWith(RELEASE_EVENT_PREFIX)) return "system";
  if (source !== "system") return "persona";
  if (fact.startsWith(RELEASE_PREFIX)) return "release-profile";
  if (SYSTEM_PREFIXES.some((p) => fact.startsWith(p))) return "system";
  return "seed";
}

export function resolveProvenance(row: {
  source: string;
  fact: string;
  provenance: string | null;
}): FactProvenance {
  return isFactProvenance(row.provenance) ? row.provenance : inferProvenance(row.source, row.fact);
}

/** Short labels for the admin ledger view. */
export const PROVENANCE_LABELS: Record<FactProvenance, string> = {
  seed: "seed",
  "release-profile": "release profile",
  system: "system",
  persona: "persona",
  elicited: "elicited",
  detected: "detected",
};

/** Whether the judge reads facts with this tag as established (true) or as
 * stakeholder claims (false). Release profiles are read apart, as data. */
export function isEstablishedProvenance(p: FactProvenance): boolean {
  return p === "seed" || p === "system" || p === "elicited";
}
