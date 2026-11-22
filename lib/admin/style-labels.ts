// Plain labels for the style pattern ids a persona or judge rewrite records
// (persona_style_retry, judge_style_retry; the ids are defined in
// lib/agents/persona-style.ts). The event log shows these instead of the
// raw ids. An id without a label is shown with its hyphens as spaces. Pure,
// and free of server imports, so the client event log can use it.

export const STYLE_PATTERN_LABELS: Record<string, string> = {
  "verdict-opener": "opened with praise or a verdict",
  "not-just": 'used "not just"',
  "not-only": 'used "not only"',
  exactly: 'used "exactly"',
  genuinely: 'used "genuinely"',
  "em-dash": "used a dash between clauses",
  honestly: 'used "honestly"',
  "worth-flagging": 'used "worth flagging" or "worth noting"',
  "not-contrast": 'contrasted with a negation (", not X")',
  "note-once-closer": "closed with an instruction to send a note",
  "go-ahead": 'used "go ahead and"',
  "follow-up-promise": "promised to come back later",
  "comma-splice": "joined two sentences with a comma",
  "method-words": "used analysis-method words",
  "too-long": "was too long",
};

export function stylePatternLabel(id: string): string {
  return STYLE_PATTERN_LABELS[id] ?? id.replace(/-/g, " ");
}

/** "opened with praise or a verdict; joined two sentences with a comma". */
export function stylePatternsLine(ids: unknown): string {
  if (!Array.isArray(ids)) return "";
  return ids
    .filter((x): x is string => typeof x === "string")
    .map(stylePatternLabel)
    .join("; ");
}
