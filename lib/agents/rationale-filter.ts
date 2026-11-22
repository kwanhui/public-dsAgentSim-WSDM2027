// The learner's copy of a judge rationale. The judge sees the full criterion
// and the record, so its rationale can name a withheld fact or a seeded
// defect that the learner never raised ("the memo misses the staff test
// accounts"). Handed to the learner after a failed attempt, that sentence
// would do the finding for them. The learner's copy drops every sentence
// that contains a key of a withheld fact (lib/scenarios/types.ts) when the
// submission itself contains none of that fact's keys, and (rubric-v7) every
// sentence that talks about the exercise rather than the client's data: the
// data's problems called "seeded" or "planted", or counted ("all four
// issues", "3 of 4 issues"). The full rationale is stored for the
// instructor. Since persona-v5 the same key filter also runs on the client
// sponsor's gate reaction (lib/agents/stage-gate.ts).
//
// rubric-v8: the filter also drops a sentence that names a seeded
// defect of a released file (the dataset's `defects` keys, documented in
// the dictionary or not) when the submission names none of that defect's
// keys. A below-gate data-audit rationale had listed all three file defects
// the learner had missed. It also drops a sentence that says a
// point was withheld or not shared with the consultant ("which Sarah has
// not shared"), which tells the learner that a hidden fact exists.
// The same checks decide whether the judge's improve line may be shown
// (lib/agents/rubric.ts improveFor). Pure.

import { findKey } from "@/lib/engagement/elicitation";
import type { Scenario } from "@/lib/scenarios/types";

// Shown when every sentence of a rationale was removed.
export const FILTERED_RATIONALE_FALLBACK =
  "The submission does not yet cover everything this criterion asks for; see the criterion wording and the line on what to improve.";

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The keys of every withheld fact in the scenario that the submission does
 * not mention, leaving out the ids in `exempt` (for a reaction: facts the
 * learner has already obtained, and the sponsor's own facts, which
 * lib/agents/withheld-guard.ts handles). */
export function unraisedFactKeys(
  scenario: Scenario,
  submissionText: string,
  exempt: Iterable<string> = [],
): string[][] {
  const skip = new Set(exempt);
  return scenario.personas
    .flatMap((p) => p.withheld ?? [])
    .filter((w) => !skip.has(w.id) && findKey(submissionText, w.keys) === null)
    .map((w) => w.keys);
}

/** The keys of every seeded defect of the scenario's files (the datasets'
 * `defects`) that the submission does not name (rubric-v8). */
export function unraisedDefectKeys(scenario: Scenario, submissionText: string): string[][] {
  return scenario.datasets
    .flatMap((d) => d.defects ?? [])
    .filter((d) => findKey(submissionText, d.keys) === null)
    .map((d) => d.keys);
}

/** Withheld facts and file defects the submission does not name: the key
 * sets that a learner-facing sentence may not contain. */
export function unraisedLearnerKeys(scenario: Scenario, submissionText: string): string[][] {
  return [...unraisedFactKeys(scenario, submissionText), ...unraisedDefectKeys(scenario, submissionText)];
}

// A sentence that says the consultant was not given a point, which tells the
// learner that there is a hidden point to find (rubric-v8).
const WITHHELD_MENTION_PATTERNS: readonly RegExp[] = [
  /\b(?:has|have|had)\s+not\s+(?:yet\s+)?(?:been\s+)?(?:shared|disclosed|revealed|told|passed on)\b/i,
  /\b(?:was|were|is|are)\s+(?:not|never)\s+(?:yet\s+)?(?:shared|disclosed|revealed|told)\b/i,
  /\bnot\s+(?:yet\s+)?(?:been\s+)?shared\s+with\b/i,
  /\b(?:never|not yet)\s+(?:shared|disclosed|revealed|elicited)\b/i,
  /\bwithheld\b/i,
  /\bheld back\b/i,
  /\bkept[\s-]back\b/i,
  /\bkeeps?\s+(?:it\s+|this\s+|that\s+)?to\s+(?:herself|himself|themselves)\b/i,
  /\bnot\s+(?:yet\s+)?(?:been\s+)?elicited\b/i,
];

/** True when the text says that a point was withheld from, or not shared
 * with, the consultant. Pure. */
export function withheldMention(text: string): boolean {
  return WITHHELD_MENTION_PATTERNS.some((p) => p.test(text));
}

/** True when a learner-facing line (a rationale sentence or an improve
 * line) may not be shown for this submission: it names an unraised
 * withheld fact or file defect, talks about the exercise, or says that a
 * point was withheld. Pure. */
export function learnerLineLeaks(text: string, scenario: Scenario, submissionText: string): boolean {
  if (assessmentLeak(text) || withheldMention(text)) return true;
  return unraisedLearnerKeys(scenario, submissionText).some((keys) => findKey(text, keys) !== null);
}

/** The keys the text states, out of the given key sets. Pure. */
export function keysNamed(text: string, unraised: readonly (readonly string[])[]): string[] {
  return unraised.map((keys) => findKey(text, keys)).filter((k): k is string => k !== null);
}

// A count of the problems to find, as the exercise designer would state it.
const COUNT_WORD = "(?:\\d+|one|two|three|four|five|six|seven|eight)";
const ASSESSMENT_PATTERNS: readonly RegExp[] = [
  /\bseeded\b/i,
  /\bplanted\b/i,
  new RegExp(`\\b${COUNT_WORD}\\s+(?:of|out of)\\s+(?:the\\s+)?${COUNT_WORD}\\s+(?:[a-z-]+\\s+)?(?:issues|defects|problems|quirks|flaws|risks)\\b`, "i"),
  new RegExp(`\\ball\\s+(?:of\\s+the\\s+)?${COUNT_WORD}\\s+(?:[a-z-]+\\s+)?(?:issues|defects|problems|quirks|flaws)\\b`, "i"),
  new RegExp(`\\bthe\\s+${COUNT_WORD}\\s+(?:known|deliberate|intended|hidden|built-in)\\s+(?:issues|defects|problems|quirks|flaws)\\b`, "i"),
];

/** True when the text talks about the exercise rather than the client's
 * data: "seeded", "planted", or a count of the problems to find. Pure. */
export function assessmentLeak(text: string): boolean {
  return ASSESSMENT_PATTERNS.some((p) => p.test(text));
}

/** The sentences of a text that name an unraised withheld fact (keys from
 * unraisedFactKeys). Pure. */
export function sentencesNamingFacts(text: string, unraised: readonly (readonly string[])[]): string[] {
  return sentences(text).filter((s) => unraised.some((keys) => findKey(s, keys) !== null));
}

/** The text with each sentence that names one of the facts removed; null
 * when nothing is left. Pure. */
export function withoutFactSentences(text: string, unraised: readonly (readonly string[])[]): string | null {
  const kept = sentences(text).filter((s) => !unraised.some((keys) => findKey(s, keys) !== null));
  return kept.length > 0 ? kept.join(" ") : null;
}

/** The rationale with each sentence that names an unraised withheld fact
 * or file defect, that talks about the exercise (assessmentLeak), or that
 * says a point was withheld (withheldMention) removed, or the fallback when
 * nothing is left. */
export function learnerRationale(rationale: string, scenario: Scenario, submissionText: string): string {
  const unraised = unraisedLearnerKeys(scenario, submissionText);
  const kept = sentences(rationale).filter(
    (s) => !assessmentLeak(s) && !withheldMention(s) && !unraised.some((keys) => findKey(s, keys) !== null),
  );
  if (kept.length === 0) return FILTERED_RATIONALE_FALLBACK;
  if (unraised.length === 0 && kept.length === sentences(rationale).length) return rationale;
  return kept.join(" ");
}

/** The rationale a learner-facing view shows for a stored score row: the
 * filtered copy when the row has one (rubric-v6 on), otherwise the stored
 * rationale. */
export function learnerRationaleOf(row: { rationale: string; learnerRationale?: string | null }): string {
  return row.learnerRationale ?? row.rationale;
}
