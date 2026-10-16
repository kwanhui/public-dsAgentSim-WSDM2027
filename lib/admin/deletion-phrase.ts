// What an instructor types to confirm a deletion. Pure, so the confirmation
// form and the server check read the same phrase.

export type DeletionKind = "learner" | "engagement" | "cohort";

export const DELETION_KINDS: readonly DeletionKind[] = ["learner", "engagement", "cohort"];

/** A cohort: its slug. A learner: the first 12 characters of the learner id
 * that the learner list and the workspace header show. An engagement: the
 * first 8 characters of its id, as the monitor shows it. */
export function confirmationPhrase(
  kind: DeletionKind,
  row: { id: string; slug?: string; learnerHash?: string },
): string {
  if (kind === "cohort") return row.slug ?? row.id;
  if (kind === "learner") return (row.learnerHash ?? row.id).slice(0, 12);
  return row.id.slice(0, 8);
}

/** One line on what the deletion removes, for the confirmation form. */
export function deletionScopeLine(kind: DeletionKind): string {
  if (kind === "cohort") {
    return "This deletes the cohort, its invites, every learner in it and all of their engagements: messages, submissions, scores, the fact record, check-ins, reflections and event logs. It cannot be undone.";
  }
  if (kind === "learner") {
    return "This deletes the learner and all of their engagements: messages, submissions, scores, the fact record, check-ins, reflections and event logs. It cannot be undone.";
  }
  return "This deletes the engagement: its messages, submissions, scores, fact record, check-ins, reflections and event log. The learner stays in the cohort. It cannot be undone.";
}

/** "engagements 1, messages 12, submissions 3": the tables that lost rows,
 * for the Deletions page and the receipt after a deletion. Zero counts are
 * left out; "no rows" when nothing was counted. */
export function deletionRowsLine(rows: unknown): string {
  if (!rows || typeof rows !== "object") return "no rows";
  const parts = Object.entries(rows as Record<string, unknown>)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([table, n]) => `${table.replace(/_/g, " ")} ${n}`);
  return parts.length === 0 ? "no rows" : parts.join(", ");
}
