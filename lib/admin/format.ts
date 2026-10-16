// Small shared helpers for the instructor-facing admin views (compare, the
// engagement monitor, the analyst-agent page): timestamp and number
// formatting, and the gate-outcome vocabulary both the compare rows and the
// monitor's submission list read from. truncateWords is also used by the
// analyst agent, whose stored reasoning ends up on those same screens.
//
// Timestamps are rendered in UTC with the zone spelled out. The event log
// stores ISO strings while submissions carry Date objects, so rendering each
// in its natural form showed the same moment twice, hours apart, with nothing
// on screen to say which zone either was in.

import { CRITERION_SKIPPED_EVENT, SUBMISSION_FLAGGED_EVENT } from "@/lib/agents/prompt-provenance";

export function formatUtc(value: Date | string, opts?: { seconds?: boolean }): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "";
  const iso = d.toISOString();
  const time = opts?.seconds ? iso.slice(11, 19) : iso.slice(11, 16);
  return `${iso.slice(0, 10)} ${time} UTC`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// Wall-clock spans on the compare view: seconds for short stages, minutes and
// hours once a stage runs long. Null means the span is still open.
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "n/a";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

// Deltas read as a direction, so keep the sign even when the difference is
// positive; zero stays bare.
export function signed(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${formatCount(n)}` : `−${formatCount(Math.abs(n))}`;
}

// =========================================================================
// Gate outcomes
// =========================================================================

// What the judge's own event recorded for a gate submission. Preferred over
// the cohort's current config, which may have been edited since the artifact
// was scored.
export interface GateOutcome {
  advanced: boolean;
  // null when the cohort ran a formative policy, where passing has no meaning.
  passed: boolean | null;
  minScoreRatio: number | null;
}

// Pulls the gate decision for every scored submission out of an engagement's
// event log. Takes the loose shape both admin pages already hold.
export function readGateOutcomes(
  events: { type: string; detailJson: unknown }[],
): Map<string, GateOutcome> {
  const map = new Map<string, GateOutcome>();
  for (const e of events) {
    if (e.type !== "submission_scored") continue;
    const d = e.detailJson as {
      submissionId?: string;
      advanced?: boolean;
      passed?: boolean | null;
      minScoreRatio?: number | null;
    } | null;
    if (!d?.submissionId) continue;
    map.set(d.submissionId, {
      advanced: Boolean(d.advanced),
      passed: typeof d.passed === "boolean" ? d.passed : null,
      minScoreRatio: typeof d.minScoreRatio === "number" ? d.minScoreRatio : null,
    });
  }
  return map;
}

// Pulls the judge's assessor-directed-text reports out of an engagement's
// event log: submission id to the quoted text (null when the judge flagged
// the submission without quoting it). The monitor renders one warning per
// flagged submission from this map, so a duplicate event for the same
// submission cannot double the banner.
export function readSubmissionFlags(
  events: { type: string; detailJson: unknown }[],
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const e of events) {
    if (e.type !== SUBMISSION_FLAGGED_EVENT) continue;
    const d = e.detailJson as { submissionId?: string; quote?: string | null } | null;
    if (!d?.submissionId) continue;
    map.set(d.submissionId, typeof d.quote === "string" && d.quote.trim() ? d.quote : null);
  }
  return map;
}

// Criteria the judge left out, per submission, from criterion_skipped
// events. The monitor flags each one.
export function readSkippedCriteria(
  events: { type: string; detailJson: unknown }[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== CRITERION_SKIPPED_EVENT) continue;
    const d = e.detailJson as { submissionId?: string; criterionId?: string } | null;
    if (!d?.submissionId || !d.criterionId) continue;
    const set = map.get(d.submissionId) ?? new Set<string>();
    set.add(d.criterionId);
    map.set(d.submissionId, set);
  }
  return map;
}

// Keeps the first row per id, in order. The monitor renders its submission
// and score lists through this guard, so a row can only ever appear once,
// whatever the rows underneath look like.
export function uniqueById<T extends { id: string | number }>(rows: T[]): T[] {
  const seen = new Set<string | number>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

export type GateTone = "pass" | "fail" | "neutral" | "progress";

export interface GateBadge {
  label: string;
  tone: GateTone;
}

// One sentence for what happened at a gate, read from the judge's event where
// there is one and from the cohort's threshold otherwise. Under a formative
// policy nothing "passed", so the label names what actually happened instead.
export function describeGateOutcome(input: {
  scored: boolean;
  outcome: GateOutcome | null;
  // Cohort threshold, used only when the judge's event is missing.
  fallbackMinScoreRatio: number | null;
  ratio: number;
  // Leave the threshold out of the pass label. The compare view states the
  // threshold once per stage row instead of on every badge.
  compact?: boolean;
}): GateBadge {
  if (!input.scored) return { label: "Not scored yet", tone: "neutral" };
  const { outcome } = input;
  // A judge event carries the threshold that was in force, and null there
  // means a formative policy, not a missing value to fall back from.
  const threshold = outcome ? outcome.minScoreRatio : input.fallbackMinScoreRatio;
  const advanced = outcome ? outcome.advanced : true;
  const passed = outcome ? outcome.passed : threshold === null ? null : input.ratio >= threshold;
  if (!advanced) return { label: "Below the gate", tone: "fail" };
  if (threshold === null) return { label: "Advanced (formative)", tone: "pass" };
  if (passed === true) {
    return input.compact
      ? { label: "Passed", tone: "pass" }
      : { label: `Passed the gate (≥ ${Math.round(threshold * 100)}%)`, tone: "pass" };
  }
  return { label: "Advanced (retries exhausted)", tone: "neutral" };
}

/** The gate threshold in words, for the one place a view states it. */
export function gateThresholdLabel(minScoreRatio: number | null): string {
  return minScoreRatio === null ? "formative gate" : `gate at ${Math.round(minScoreRatio * 100)}% of the rubric`;
}

const GATE_TONES: Record<GateTone, string> = {
  pass: "bg-primary/10 text-primary",
  fail: "border border-flag/40 text-flag",
  neutral: "border text-muted-foreground",
  progress: "border border-primary text-primary",
};

export function gateToneClass(tone: GateTone): string {
  return `shrink-0 rounded-full px-2 py-0.5 ${GATE_TONES[tone]}`;
}

// Trims to a length without cutting a word in half. Used for stored analyst
// reasoning and for error messages surfaced in the admin UI.
export function truncateWords(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const cut = trimmed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.\-\u2013\u2014]+$/, "")}…`;
}
