// Showcase run labels ("A1", "H1", "exhibit") from a cohort's
// showcase.labels config, keyed by engagement id. Pure.

import { parseCohortConfig } from "@/lib/cohort/defaults";

export function showcaseLabel(configJson: unknown, engagementId: string): string | null {
  return parseCohortConfig(configJson).showcase.labels[engagementId] ?? null;
}

/** "A1 · " in front of a run's description, or nothing. */
export function labelPrefix(label: string | null): string {
  return label ? `${label} · ` : "";
}
