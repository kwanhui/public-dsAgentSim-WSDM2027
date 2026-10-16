// Splits a judge rationale into its first sentence and the rest, so screens
// can show the score and one line and keep the full reasoning one click away.
// A sentence ends at ".", "?" or "!" followed by whitespace and a capital
// letter, digit or opening quote/bracket; decimals ("4.5"), abbreviations
// followed by lower case ("e.g. the") and file names stay inside the
// sentence. Pure, so client components can use it.

const BOUNDARY = /[.?!]["')\]]?\s+(?=["'(\[]?[A-Z0-9])/g;

export function splitFirstSentence(text: string): { first: string; rest: string } {
  const trimmed = text.trim();
  BOUNDARY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BOUNDARY.exec(trimmed)) !== null) {
    const end = match.index + match[0].trimEnd().length;
    const first = trimmed.slice(0, end).trim();
    // Skip common abbreviations that end with a period ("e.g.", "i.e.").
    if (/\b(?:e\.g|i\.e|vs|etc|approx|cf)\.$/i.test(first)) continue;
    return { first, rest: trimmed.slice(end).trim() };
  }
  return { first: trimmed, rest: "" };
}
