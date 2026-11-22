// Showcase runs (engagements named in the cohort's showcase.labels, such as
// H1, A1 and the exhibit) are what the paper's deep links and the reviewer
// path point at, so an instructor cannot delete one on its own from the
// admin screens: neither the engagement nor the learner who holds it. The
// whole showcase cohort can still be deleted, behind the usual typed
// confirmation of its slug. Pure; lib/admin/deletion.ts applies it on the
// server and the admin pages use it to hide the Delete controls.

import type { DeletionKind } from "@/lib/admin/deletion-phrase";

export const SHOWCASE_PROTECTED_ERROR = "showcase-protected";

/** showcase.labels from a stored cohort config, read directly rather than
 * through parseCohortConfig: a config that fails validation falls back to
 * the defaults there, which carry no labels, and the guard must not open on
 * such a row. */
export function showcaseLabelsOf(configJson: unknown): Record<string, string> {
  const showcase = (configJson as { showcase?: { labels?: unknown } } | null)?.showcase;
  const labels = showcase?.labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0),
  );
}

/** The showcase labels among the given engagements, in label order. */
export function protectedShowcaseLabels(
  labels: Readonly<Record<string, string>>,
  engagementIds: readonly string[],
): string[] {
  return engagementIds
    .map((id) => labels[id])
    .filter((label): label is string => typeof label === "string" && label.length > 0)
    .sort();
}

/** The refusal shown when a learner or an engagement holds showcase runs. */
export function showcaseDeletionRefusal(kind: Exclude<DeletionKind, "cohort">, labels: readonly string[]): string {
  const runs = labels.length === 1 ? `showcase run ${labels[0]}` : `showcase runs ${labels.join(", ")}`;
  const what = kind === "engagement" ? "This engagement is" : "This learner holds";
  return `${what} ${runs}, which cannot be deleted on its own. To remove the showcase, delete the whole cohort from its settings page (you will type the cohort's slug to confirm).`;
}
