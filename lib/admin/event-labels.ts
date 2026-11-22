// Labels and one-line summaries for the engagement event log. The monitor
// shows events as a table (time, event, stage, persona, tokens, summary)
// with the raw JSON behind a toggle, because raw JSON on one line per event
// was unreadable. Pure, so the table and its test read the same text.

import { stylePatternsLine } from "@/lib/admin/style-labels";
import { STAGE_TITLES, type StageId } from "@/lib/scenarios/types";

export const EVENT_LABELS: Record<string, string> = {
  engagement_started: "Engagement started",
  engagement_completed: "Engagement completed",
  persona_turn: "Persona reply",
  persona_failed: "Persona call failed",
  persona_style_retry: "Persona reply rewritten",
  persona_output_repair: "Persona reply unwrapped from JSON",
  persona_consistency: "Consistency audit",
  client_reaction: "Client reaction",
  client_reaction_failed: "Client reaction failed",
  fact_elicited: "Hidden fact obtained",
  data_released: "Data released",
  submission_scored: "Submission scored",
  submission_scoring_failed: "Judge call failed",
  submission_rescored: "Submission rescored",
  submission_flagged: "Text addressed to the assessor",
  criterion_skipped: "Criterion skipped by the judge",
  unverified_claim_flagged: "Unverified result",
  score_overridden: "Score overridden",
  stage_advanced: "Stage advanced",
  stage_forced: "Stage forced by instructor",
  message_cap_reached: "Message limit reached",
  checkin_submitted: "Check-in submitted",
  analyst_run_started: "Analyst run started",
  analyst_stage_started: "Analyst stage started",
  analyst_stage_finished: "Analyst stage finished",
  analyst_step: "Analyst step",
  analyst_step_rejected: "Analyst step rejected",
  analyst_step_failed: "Analyst step failed",
  analyst_stage_failed: "Analyst step failed",
  identity_question: "Identity question",
  friction_raised: "Friction raised",
  judge_style_retry: "Judge rationale rewritten",
  early_disclosure_flagged: "Early disclosure",
  budget_refused: "Refused: budget reached",
  // Release, friction and elicitation pipeline events.
  release_withheld: "Release held: scope not stated",
  reaction_leak_filtered: "Client reaction rewritten",
  friction_unconfirmed: "Friction not confirmed",
  fact_elicited_early: "Hidden fact given early",
  criterion_capped_no_exchange: "Criterion capped: no exchange",
  stated_not_elicited: "Stated but not elicited",
  // Withheld-fact guard (persona-v6).
  withheld_leak_blocked: "Hidden fact held back",
};

/** Event types shown as a problem in the log (flag colour). */
const PROBLEM_EVENTS = new Set([
  "persona_failed",
  "client_reaction_failed",
  "submission_scoring_failed",
  "submission_flagged",
  "criterion_skipped",
  "unverified_claim_flagged",
  "message_cap_reached",
  "analyst_step_rejected",
  "analyst_step_failed",
  "analyst_stage_failed",
  "early_disclosure_flagged",
  "budget_refused",
]);

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/_/g, " ");
}

export function isProblemEvent(type: string, detail: unknown): boolean {
  if (PROBLEM_EVENTS.has(type)) return true;
  const d = asRecord(detail);
  return type === "persona_consistency" && d.consistent === false;
}

function asRecord(detail: unknown): Record<string, unknown> {
  return detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function stageTitle(v: unknown): string | null {
  const s = str(v);
  return s ? (STAGE_TITLES[s as StageId] ?? s) : null;
}

export interface EventRowView {
  label: string;
  stage: string | null;
  persona: string | null;
  // Tokens the event metered, both sides summed; null when it metered none.
  tokens: number | null;
  summary: string;
  problem: boolean;
}

/**
 * One event as a table row. `personaName` maps a persona id to the
 * persona's name for this scenario.
 */
export function describeEvent(
  type: string,
  detail: unknown,
  personaName: (id: string) => string = (id) => id,
  // The event log folds a reply's style rewrite into the reply's row
  // (lib/admin/style-retry-fold.ts) and says so itself.
  opts: { omitStyleFlag?: boolean } = {},
): EventRowView {
  const d = asRecord(detail);
  const styleFlag = d.styleRetry && !opts.omitStyleFlag ? "rewritten for style" : null;
  const personaId = str(d.personaId) ?? str(d.persona) ?? str(d.channelPersonaId);
  const tokens =
    n(d.promptTokens) + n(d.completionTokens) + n(d.judgePromptTokens) + n(d.judgeCompletionTokens);
  let summary = "";
  switch (type) {
    case "persona_turn":
      summary = [
        str(d.promptVersion),
        n(d.newFacts) > 0 ? `${n(d.newFacts)} new fact${n(d.newFacts) === 1 ? "" : "s"}` : null,
        Array.isArray(d.releasedFiles) && d.releasedFiles.length > 0 ? `released ${d.releasedFiles.join(", ")}` : null,
        Array.isArray(d.revealedWithheld) && d.revealedWithheld.length > 0 ? `revealed ${d.revealedWithheld.join(", ")}` : null,
        styleFlag,
      ]
        .filter(Boolean)
        .join(" · ");
      break;
    case "client_reaction":
      summary = [
        str(d.outcome),
        n(d.newFacts) > 0 ? `${n(d.newFacts)} new fact${n(d.newFacts) === 1 ? "" : "s"}` : null,
        Array.isArray(d.droppedFacts) && d.droppedFacts.length > 0 ? `${d.droppedFacts.length} fact dropped` : null,
        Array.isArray(d.revealedWithheld) && d.revealedWithheld.length > 0 ? `revealed ${d.revealedWithheld.join(", ")}` : null,
        styleFlag,
        d.audited ? "audited" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      break;
    case "persona_failed":
      summary = `${str(d.kind) ?? "turn"}, ${n(d.attempts)} failed attempt${n(d.attempts) === 1 ? "" : "s"}, ${d.recovered ? "recovered on retry" : "no reply"}${str(d.errorClass) ? ` (${d.errorClass})` : ""}`;
      break;
    case "persona_style_retry":
      summary = `${stylePatternsLine(d.patterns) || "style"}${d.resolved ? "; fixed by the rewrite" : "; still present after the rewrite"}`;
      break;
    case "persona_output_repair": {
      const repairs = Array.isArray(d.repairs) ? d.repairs.map(asRecord) : [];
      summary = repairs
        .map((r) => `${str(r.call) ?? "reply"}: ${r.kind === "truncated-json" ? "cut-off JSON stripped" : "nested JSON unwrapped"}${Array.isArray(r.mergedFields) && r.mergedFields.length > 0 ? ` (${r.mergedFields.join(", ")} merged)` : ""}`)
        .join("; ");
      break;
    }
    case "persona_consistency":
      summary =
        d.consistent === true ? "consistent" : d.consistent === false ? `inconsistent${str(d.contradiction) ? `: ${d.contradiction}` : ""}` : "audit failed";
      break;
    case "fact_elicited":
      summary = `${str(d.factId) ?? "fact"} after ${n(d.learnerMessagesSoFar)} learner message${n(d.learnerMessagesSoFar) === 1 ? "" : "s"}${
        d.verified === true ? ", verified in the reply" : d.verified === false ? ", reported but not found in the reply" : ""
      }`;
      break;
    case "identity_question": {
      const outcomes: Record<string, string> = {
        stated: "the reply already said it is simulated",
        replaced: "a claim to be human was replaced with the fixed line",
        prepended: "the fixed line was put first",
      };
      summary = outcomes[str(d.outcome) ?? ""] ?? str(d.outcome) ?? "";
      break;
    }
    case "friction_raised":
      summary = `${stageTitle(d.stage) ?? ""} friction, raised in ${d.via === "reaction" ? "a gate reaction" : "a chat reply"}`;
      break;
    case "judge_style_retry": {
      const hits = Array.isArray(d.criteria) ? d.criteria.length : 0;
      summary = `${hits} rationale${hits === 1 ? "" : "s"} rewritten${d.resolved ? ", fixed by the rewrite" : ", still flagged after the rewrite"}`;
      break;
    }
    case "early_disclosure_flagged":
      summary = Array.isArray(d.factIds) ? `gave ${d.factIds.join(", ")} before its condition was met` : "";
      break;
    case "budget_refused":
      summary = `${str(d.route) ?? "call"} refused: ${d.scope === "sandbox" ? "the sandbox cohort's" : "the deployment's"} daily limit of USD ${n(d.limitUsd).toFixed(2)} was reached`;
      break;
    case "data_released":
      summary = str(d.file) ?? "";
      break;
    case "submission_scored": {
      const ratio = typeof d.scoreRatio === "number" ? `${Math.round(d.scoreRatio * 100)}%` : "";
      const passed = d.passed === true ? "passed" : d.passed === false ? "not passed" : "formative";
      summary = [`attempt ${n(d.attempt)}`, ratio, passed, d.advanced ? "advanced" : null, str(d.promptVersion)]
        .filter(Boolean)
        .join(" · ");
      break;
    }
    case "unverified_claim_flagged": {
      const criteria = Array.isArray(d.criteria) ? (d.criteria as Record<string, unknown>[]) : [];
      const notes = criteria.map((c) => str(c.note)).filter(Boolean);
      summary = `${criteria.length} criteri${criteria.length === 1 ? "on" : "a"}, ${d.capped ? "capped (analyst agent)" : "score kept"}${notes.length > 0 ? `: ${[...new Set(notes)].join("; ")}` : ""}`;
      break;
    }
    case "criterion_skipped":
      summary = str(d.criterionId) ?? "";
      break;
    case "submission_flagged":
      summary = str(d.quote) ? `«${d.quote}»` : "";
      break;
    case "score_overridden":
      summary = `${str(d.criterionId) ?? ""}: ${n(d.judgeScore)} to ${d.overrideScore === null ? "cleared" : n(d.overrideScore)}`;
      break;
    case "stage_advanced":
    case "stage_forced":
      summary = `${stageTitle(d.from) ?? ""} to ${stageTitle(d.to) ?? "completion"}`;
      break;
    case "message_cap_reached":
      summary = `${n(d.sent)} of ${n(d.cap)} messages sent`;
      break;
    case "analyst_step":
    case "analyst_step_rejected":
      summary = [str(d.action), str(d.reason), str(d.reasoning)].filter(Boolean).join(" · ");
      break;
    case "analyst_step_failed":
    case "analyst_stage_failed":
    case "client_reaction_failed":
    case "submission_scoring_failed":
      summary = [str(d.errorClass), str(d.message)].filter(Boolean).join(": ");
      break;
    default:
      summary = "";
  }
  return {
    label: eventLabel(type),
    stage: stageTitle(d.stage),
    persona: personaId ? personaName(personaId) : null,
    tokens: tokens > 0 ? tokens : null,
    summary,
    problem: isProblemEvent(type, detail),
  };
}
