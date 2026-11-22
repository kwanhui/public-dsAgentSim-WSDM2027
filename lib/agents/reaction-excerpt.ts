// How much of a delivered document the client sponsor's gate reaction reads,
// and (consistency-v6) the auditor of that reaction with it. The auditor had
// 1,500 characters against the sponsor's 4,000, so it flagged a reaction
// that cited a pilot from further down the memo as unsupported.
// Pure; used by lib/agents/stage-gate.ts.

export const REACTION_EXCERPT_CHARS = 4000;

/** The part of a submission that the sponsor's reaction and its audit both
 * read. */
export function reactionExcerpt(submissionText: string): string {
  return submissionText.slice(0, REACTION_EXCERPT_CHARS);
}

/** The consultant's message as the reaction's auditor reads it: the
 * document kind and the same excerpt the sponsor read. */
export function reactionAuditMessage(artifactKind: string, submissionText: string): string {
  return `(The consultant delivered the ${artifactKind.replace(/-/g, " ")} for this stage. Excerpt:)\n${reactionExcerpt(submissionText)}`;
}
