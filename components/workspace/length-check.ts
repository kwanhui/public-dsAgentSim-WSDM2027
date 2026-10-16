// The confirmation a learner sees before submitting an artifact shorter
// than the gate's word target. A scored submission uses one of the stage's
// attempts, so the question names which one. Pure.

import { countWords, type WordTarget } from "@/lib/engagement/artifact-text";

export function underTargetQuestion(input: {
  text: string;
  target: WordTarget | null;
  /** Scored attempts already made at this stage. */
  attemptsUsed: number;
  /** The gate policy: a pass mark (hard gate) or null (formative). */
  minScoreRatio: number | null;
  maxRetries: number;
}): string | null {
  const { target } = input;
  if (!target) return null;
  const words = countWords(input.text);
  if (words >= target.min) return null;
  const length = `This is ${words} ${words === 1 ? "word" : "words"}; the target is ${target.min} to ${target.max}.`;
  if (input.minScoreRatio === null) {
    return `${length} Submit anyway? It will be scored as it stands and the stage moves on.`;
  }
  const attempt = input.attemptsUsed + 1;
  const of = input.maxRetries + 1;
  return `${length} Submit anyway? It uses attempt ${Math.min(attempt, of)} of ${of}.`;
}

/** Extra note for the word counter when the text is under the target. */
export function belowTargetNote(text: string, target: WordTarget | null): string | null {
  if (!target) return null;
  const words = countWords(text);
  return words > 0 && words < target.min ? "below the target" : null;
}

/** The warning before a submission at a stage whose data has not been
 * released: the memo would be scored on data the learner has not seen.
 * Null once a file is released, or when no file is due by this stage. */
export function noReleaseQuestion(input: { releasedFiles: number; pendingFiles: number }): string | null {
  if (input.releasedFiles > 0 || input.pendingFiles === 0) return null;
  return "No file has been released yet; ask the data owner for the extract first. Submit anyway?";
}
