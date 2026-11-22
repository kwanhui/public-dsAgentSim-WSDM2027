// The monitor's ledger view. When a persona states a hidden fact, the
// ledger gains two rows for it: the persona's own wording (tag "persona",
// from the reply's new facts) and the scenario's statement of the fact (tag
// "elicited", once the key check confirms the reveal). The view shows such a
// pair once, at the elicited row, with both tags and the persona's wording
// behind a toggle. Display only: the stored ledger, and what the personas
// and the judge read, keep both rows.

import { elicitedLedgerFact, verifyReveal } from "@/lib/engagement/elicitation";
import type { FactProvenance } from "@/lib/engagement/provenance";
import type { Scenario } from "@/lib/scenarios/types";

export interface LedgerInputRow {
  fact: string;
  provenance: FactProvenance;
  source: string;
  stage: string;
}

export interface LedgerViewRow {
  fact: string;
  tags: FactProvenance[];
  // The persona row folded into this elicited row, if any.
  personaWording: string | null;
}

export function ledgerViewRows(
  facts: readonly LedgerInputRow[],
  scenario: Pick<Scenario, "personas">,
): LedgerViewRow[] {
  const folded = new Map<number, number>(); // persona row index -> elicited row index
  const twinOf = new Map<number, number>(); // elicited row index -> persona row index
  for (const [i, row] of facts.entries()) {
    if (row.provenance !== "elicited") continue;
    const persona = scenario.personas.find((p) => p.id === row.source);
    const withheld = (persona?.withheld ?? []).find((w) => elicitedLedgerFact(w) === row.fact);
    if (!withheld) continue;
    const candidate = (j: number) => {
      const other = facts[j];
      return (
        other.provenance === "persona" &&
        other.source === row.source &&
        other.stage === row.stage &&
        !folded.has(j) &&
        verifyReveal(withheld, other.fact).verified
      );
    };
    // Nearest first: the persona's new facts from the same reply sit next to
    // the elicited row, before it or after it.
    let match: number | null = null;
    for (let d = 1; d < facts.length && match === null; d++) {
      if (i - d >= 0 && candidate(i - d)) match = i - d;
      else if (i + d < facts.length && candidate(i + d)) match = i + d;
    }
    if (match !== null) {
      folded.set(match, i);
      twinOf.set(i, match);
    }
  }
  const out: LedgerViewRow[] = [];
  for (const [i, row] of facts.entries()) {
    if (folded.has(i)) continue;
    const twin = twinOf.get(i);
    out.push(
      twin === undefined
        ? { fact: row.fact, tags: [row.provenance], personaWording: null }
        : { fact: row.fact, tags: ["persona", "elicited"], personaWording: facts[twin].fact },
    );
  }
  return out;
}
