// Helpers for the gate submission box: length feedback in the same unit the
// gate instructions ask for.

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export interface WordTarget {
  min: number;
  max: number;
}

// Gate instructions state the expected length inline, e.g. "Submit a
// cleaning report (300-500 words)". Pulling the range out lets the submission
// box count against it instead of against a character limit the learner was
// never given.
export function parseWordTarget(instructions: string): WordTarget | null {
  const match = instructions.match(/(\d[\d,]*)\s*(?:-|\u2013|\u2014|to)\s*(\d[\d,]*)\s*words/i);
  if (!match) return null;
  const min = Number(match[1].replace(/,/g, ""));
  const max = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { min, max };
}

// The minimum the submit route accepts, in characters. The counter below
// reports words; this floor only decides whether the button is enabled.
export const MIN_ARTIFACT_CHARS = 50;

/** One counter in one unit: "113 words · target 300 to 600". Below the
 * submission floor it says so, since the button is disabled for that reason. */
export function wordCountLine(text: string, target: WordTarget | null): string {
  const words = countWords(text);
  const count = `${words} ${words === 1 ? "word" : "words"}`;
  const parts = [count];
  if (target) parts.push(`target ${target.min} to ${target.max}`);
  if (text.trim().length < MIN_ARTIFACT_CHARS) parts.push("too short to submit");
  return parts.join(" · ");
}
