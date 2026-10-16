// What kind of run an engagement is, for the admin views: the analyst agent,
// a scripted replay by the authors (the showcase reference run H1 and the
// fail-then-revise exhibit), or a learner. A scripted replay joined through
// an invite like a learner, so its seat alone would read "Invite" and
// "Human learner", and its wall clock would read as a person's working time.
// Pure.

import type { CohortConfig } from "@/lib/cohort/defaults";

export type RunKind = "agent" | "scripted" | "learner";

export const RUN_KIND_LABELS: Record<RunKind, string> = {
  agent: "Analyst agent",
  scripted: "Scripted reference (author replay)",
  learner: "Human learner",
};

// Showcase labels that name a replayed run, for showcases regenerated
// before showcase.scriptedReplays existed.
const SCRIPTED_LABEL = /^(h\d*|exhibit)$/i;

/** Whether the run is an author script replayed through the learner path. */
export function isScriptedReplay(
  showcase: Pick<CohortConfig["showcase"], "labels"> & { scriptedReplays?: readonly string[] },
  engagement: { id: string; mode: string },
): boolean {
  if (engagement.mode === "agent") return false;
  if (showcase.scriptedReplays?.includes(engagement.id)) return true;
  const label = showcase.labels[engagement.id];
  return typeof label === "string" && SCRIPTED_LABEL.test(label.trim());
}

export function runKind(
  showcase: Pick<CohortConfig["showcase"], "labels"> & { scriptedReplays?: readonly string[] },
  engagement: { id: string; mode: string },
): RunKind {
  if (engagement.mode === "agent") return "agent";
  return isScriptedReplay(showcase, engagement) ? "scripted" : "learner";
}

/** What the wall-clock figure of each kind of run measures. */
export const WALL_CLOCK_LABELS: Record<RunKind, string> = {
  agent: "Active time (completed stage attempts)",
  scripted: "Replay time (no think time)",
  learner: "Elapsed, whole run",
};

/**
 * Whether a wall-clock difference between two runs means anything. A scripted
 * replay has no think time, so its time is not comparable with an agent's
 * active time or a learner's elapsed time.
 */
export function wallClockComparable(left: RunKind, right: RunKind): boolean {
  return left !== "scripted" && right !== "scripted";
}
