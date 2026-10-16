// Wall-clock time on the compare view and the monitor.
//
// An analyst-agent run logs analyst_stage_started and analyst_stage_finished
// around each stage attempt. Its time is active time: the sum of the
// brackets that finished without a failure (analystBrackets, activeTimeMs).
// A bracket with a failure is a failed attempt, and a start with no finish
// before the next start is an interrupted attempt (the driver or the server
// stopped, and the stage was resumed later); both are left out, as is the
// idle time between brackets. This is the measure the paper reports.
//
// Human runs, and agent runs from before analyst_stage_finished was logged,
// fall back to the stage windows below, without failed analyst attempts.
// A stage run of the analyst agent that
// fails (analyst_step_failed) is retried by the operator, and the time from
// the failed run's start to the next run's start is infrastructure time, not
// agent working time. Those spans are cut out of the stage durations and
// counted separately. Pure.

import { isAnalystFailureType } from "@/lib/admin/event-types";

export const ANALYST_STAGE_STARTED = "analyst_stage_started";

interface EventLike {
  type: string;
  timestampIso: string;
}

export interface Span {
  start: number;
  end: number;
}

/** One span per failed analyst stage run: from the run's start (or the
 * failure, when no start was logged) to the start of the next run (or the
 * failure, when nothing was run again). */
export function failedAttemptSpans(events: readonly EventLike[]): Span[] {
  const sorted = [...events].sort((a, b) => a.timestampIso.localeCompare(b.timestampIso));
  const spans: Span[] = [];
  let runStart: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const t = new Date(e.timestampIso).getTime();
    if (e.type === ANALYST_STAGE_STARTED) runStart = t;
    if (!isAnalystFailureType(e.type)) continue;
    const next = sorted.slice(i + 1).find((x) => x.type === ANALYST_STAGE_STARTED);
    const end = next ? new Date(next.timestampIso).getTime() : t;
    spans.push({ start: runStart ?? t, end: Math.max(end, runStart ?? t) });
    runStart = null;
  }
  return spans;
}

/** Milliseconds of the window [start, end) covered by the spans. */
export function overlapMs(spans: readonly Span[], start: number, end: number): number {
  let total = 0;
  for (const s of spans) {
    const a = Math.max(s.start, start);
    const b = Math.min(s.end, end);
    if (b > a) total += b - a;
  }
  return total;
}

/** Failure events inside the window [start, end). */
export function failuresIn(events: readonly EventLike[], start: number, end: number | null): number {
  return events.filter((e) => {
    if (!isAnalystFailureType(e.type)) return false;
    const t = new Date(e.timestampIso).getTime();
    return t >= start && (end === null || t < end);
  }).length;
}

export const ANALYST_STAGE_FINISHED = "analyst_stage_finished";

interface StageEventLike extends EventLike {
  detailJson?: unknown;
}

export interface AnalystBracket {
  stage: string | null;
  start: number;
  /** When the attempt finished or failed; null when it was interrupted. */
  end: number | null;
  failed: boolean;
  /** Started, then started again with no finish in between. */
  interrupted: boolean;
}

function stageOf(e: StageEventLike): string | null {
  const stage = (e.detailJson as { stage?: unknown } | null | undefined)?.stage;
  return typeof stage === "string" ? stage : null;
}

/** The analyst's stage attempts, in order. Empty for a run that never logged
 * analyst_stage_finished (a human run, or an agent run from before it). */
export function analystBrackets(events: readonly StageEventLike[], opts: { running?: boolean } = {}): AnalystBracket[] {
  if (!events.some((e) => e.type === ANALYST_STAGE_FINISHED)) return [];
  const sorted = [...events].sort((a, b) => a.timestampIso.localeCompare(b.timestampIso));
  const out: AnalystBracket[] = [];
  let open: AnalystBracket | null = null;
  for (const e of sorted) {
    const t = new Date(e.timestampIso).getTime();
    if (e.type === ANALYST_STAGE_STARTED) {
      if (open) {
        if (open.failed) open.end = open.end ?? t;
        else open.interrupted = true;
        out.push(open);
      }
      open = { stage: stageOf(e), start: t, end: null, failed: false, interrupted: false };
    } else if (isAnalystFailureType(e.type)) {
      if (open) {
        open.failed = true;
        open.end = t;
      }
    } else if (e.type === ANALYST_STAGE_FINISHED && open) {
      open.end = open.failed ? (open.end ?? t) : t;
      out.push(open);
      open = null;
    }
  }
  if (open) {
    // A stage still running is neither finished nor interrupted.
    if (!open.failed && !opts.running) open.interrupted = true;
    out.push(open);
  }
  return out;
}

/** Whether a bracket counts toward active time: the attempt ran to
 * completion without an infrastructure failure or an interruption, whether
 * or not its gate passed. The UI calls these "completed stage attempts". */
export function isSuccessful(b: AnalystBracket): boolean {
  return !b.failed && !b.interrupted && b.end !== null;
}

/** Milliseconds of completed stage attempts, for one stage or the run. */
export function activeTimeMs(brackets: readonly AnalystBracket[], stage?: string): number {
  return brackets
    .filter((b) => isSuccessful(b) && (stage === undefined || b.stage === stage))
    .reduce((sum, b) => sum + ((b.end as number) - b.start), 0);
}

/** Interrupted attempts, for one stage or the run. */
export function interruptedCount(brackets: readonly AnalystBracket[], stage?: string): number {
  return brackets.filter((b) => b.interrupted && (stage === undefined || b.stage === stage)).length;
}

/** Failed attempts, for one stage or the run. */
export function failedCount(brackets: readonly AnalystBracket[], stage?: string): number {
  return brackets.filter((b) => b.failed && (stage === undefined || b.stage === stage)).length;
}
