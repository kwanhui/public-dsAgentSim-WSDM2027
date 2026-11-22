// What one engagement recorded about the conditions it ran under, read from
// its own rows: the persona model, the judge model and prompt version, the
// auditor prompt version, and the metered token total. The compare view puts
// two runs' values side by side in its "held constant" strip.
//
// Every value comes from the run itself. A run that did not record a value
// reports null ("not recorded"), never the model the viewing deployment is
// configured with today: the strip would otherwise describe the viewer's
// environment instead of the run. Pure, with no database import.

import { submissionTotals, type ScoreLike } from "@/lib/engagement/effective-score";

export const NOT_RECORDED = "not recorded";

export interface EventLike {
  type: string;
  detailJson: unknown;
}

function detail(e: EventLike): Record<string, unknown> {
  return e.detailJson && typeof e.detailJson === "object"
    ? (e.detailJson as Record<string, unknown>)
    : {};
}

function stringField(e: EventLike, key: string): string | null {
  const value = detail(e)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Analyst events stamp the analyst model, which is resolved from the same
// deployment setting as the persona model (lib/agents/analyst.ts), so an
// agent run that predates persona-turn stamping still carries its own record.
const ANALYST_EVENTS = new Set([
  "analyst_run_started",
  "analyst_stage_started",
  "analyst_step",
  "analyst_step_rejected",
]);

/** The persona model this run recorded, or null. Persona-turn stamps win;
 * analyst events are the fallback for older agent runs. */
export function personaModelFromEvents(events: EventLike[]): string | null {
  const fromTurns = distinct(
    events.filter((e) => e.type === "persona_turn").map((e) => stringField(e, "model")),
  );
  if (fromTurns) return fromTurns;
  return distinct(
    events.filter((e) => ANALYST_EVENTS.has(e.type)).map((e) => stringField(e, "model")),
  );
}

/** The analyst model an agent run recorded: the model on its
 * analyst_run_started event, or, for a run without one, the model(s) on its
 * analyst steps. Null for a run with no analyst events (a learner run or an
 * author replay). */
export function analystModelFromEvents(events: EventLike[]): string | null {
  const started = distinct(
    events.filter((e) => e.type === "analyst_run_started").map((e) => stringField(e, "model")),
  );
  if (started) return started;
  return distinct(
    events
      .filter((e) => e.type === "analyst_step" || e.type === "analyst_stage_started")
      .map((e) => stringField(e, "model")),
  );
}

/** What the "Analyst model" row shows for a run: the recorded model for an
 * agent run (or "not recorded"), and "none" for a run that has no analyst. */
export function analystModelLabel(data: { isAgent: boolean; analystModel: string | null }): string {
  if (!data.isAgent) return "none (not an agent run)";
  return data.analystModel ?? NOT_RECORDED;
}

/** Judge model(s) stamped on the run's rubric scores, or null when unscored. */
export function judgeModelFromScores(scores: { judgeModel: string }[]): string | null {
  return distinct(scores.map((s) => s.judgeModel));
}

/** Rubric prompt version(s) stamped on the run's rubric scores. */
export function judgePromptFromScores(scores: { promptVersion: string }[]): string | null {
  return distinct(scores.map((s) => s.promptVersion));
}

/** Persona prompt version(s) recorded on the run's persona turns and client
 * reactions. Older runs recorded none (persona-v1). */
export function personaPromptFromEvents(events: EventLike[]): string | null {
  return distinct(
    events
      .filter((e) => e.type === "persona_turn" || e.type === "client_reaction")
      .map((e) => stringField(e, "promptVersion")),
  );
}

/** Consistency-auditor prompt version(s) recorded on the run's audits. */
export function auditorPromptFromEvents(events: EventLike[]): string | null {
  return distinct(
    events
      .filter((e) => e.type === "persona_consistency")
      .map((e) => stringField(e, "promptVersion")),
  );
}

// Several values in one run (a prompt change mid-run) are all named, in a
// stable order, so the strip shows the mix rather than picking one.
function distinct(values: (string | null)[]): string | null {
  const set = [...new Set(values.filter((v): v is string => v !== null))].sort();
  return set.length === 0 ? null : set.join(" + ");
}

/** Tokens metered on one event: persona, analyst and judge fields. */
export function eventTokens(e: EventLike): number {
  const d = detail(e);
  const num = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : 0);
  return (
    num("promptTokens") +
    num("completionTokens") +
    num("judgePromptTokens") +
    num("judgeCompletionTokens")
  );
}

/** Every metered call in the run: persona and client-reaction messages plus
 * every event that carries token counts (analyst steps, judge calls), with
 * no stage-window filter. This is the total the paper reports
 * (scripts/paper-metrics/analyse.py). */
export function meteredTokens(
  messages: { promptTokens: number; completionTokens: number }[],
  events: EventLike[],
): number {
  let total = 0;
  for (const m of messages) total += m.promptTokens + m.completionTokens;
  for (const e of events) total += eventTokens(e);
  return total;
}

export interface SubmissionLike {
  id: string;
  stage: string;
  createdAt: Date | string;
}

export interface RunScoreRow extends ScoreLike {
  submissionId: string;
}

/** The run's rubric total: per stage, the effective total of the latest
 * scored submission, summed over stages. The compare view's run cards use
 * the same rule. */
export function runRubricTotal(
  submissions: SubmissionLike[],
  scores: RunScoreRow[],
): { score: number; max: number } {
  const bySubmission = new Map<string, RunScoreRow[]>();
  for (const s of scores) {
    const list = bySubmission.get(s.submissionId) ?? [];
    list.push(s);
    bySubmission.set(s.submissionId, list);
  }
  const latest = new Map<string, { at: number; rows: RunScoreRow[] }>();
  for (const sub of submissions) {
    const rows = bySubmission.get(sub.id);
    if (!rows || rows.length === 0) continue;
    const at = new Date(sub.createdAt).getTime();
    const prev = latest.get(sub.stage);
    if (!prev || at >= prev.at) latest.set(sub.stage, { at, rows });
  }
  let score = 0;
  let max = 0;
  for (const { rows } of latest.values()) {
    const t = submissionTotals(rows);
    score += t.effective;
    max += t.max;
  }
  return { score, max };
}

export interface ConditionPart {
  label: string;
  left: string | null;
  right: string | null;
}

export interface ConditionSplit {
  same: { label: string; value: string }[];
  differ: ConditionPart[];
  unrecorded: ConditionPart[];
}

/** Sorts the strip's settings into held constant, differing, and not
 * recorded on at least one side. A missing record is not evidence that a
 * setting differed, so it is reported on its own line. */
export function splitConditions(parts: ConditionPart[]): ConditionSplit {
  const out: ConditionSplit = { same: [], differ: [], unrecorded: [] };
  for (const p of parts) {
    if (p.left === null || p.right === null) out.unrecorded.push(p);
    else if (p.left === p.right) out.same.push({ label: p.label, value: p.left });
    else out.differ.push(p);
  }
  return out;
}
