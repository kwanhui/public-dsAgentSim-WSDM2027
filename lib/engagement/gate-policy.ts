// The cohort's gate policy applied to one scored submission. Kept free of
// database and model imports so both the gate handler and its tests can use
// it directly.

import { NO_EXCHANGE_CAP_RATIO } from "@/lib/agents/prompt-provenance";

export interface GateDecision {
  // True or false against the cohort threshold; null when the cohort runs a
  // formative policy (no threshold), where "passed" has no meaning. Stored
  // under this name in the submission_scored event, which the CSV export
  // carries through to analysis.
  passed: boolean | null;
  // Whether the pipeline moves on: a pass, a formative submission, or a
  // shortfall on the last permitted attempt.
  advanced: boolean;
  // Why the pipeline moved on (or did not), for learner-facing copy.
  reason: "passed" | "formative" | "retries-exhausted" | "below-threshold";
}

export interface GateOutcomeCopy {
  headline: string;
  // "pass" is the only celebratory styling, and only a submission that
  // cleared a real threshold earns it.
  tone: "pass" | "neutral" | "shortfall";
}

export function gateOutcomeCopy(input: {
  reason: GateDecision["reason"];
  attempt: number;
  nextStageTitle: string;
  engagementCompleted: boolean;
}): GateOutcomeCopy {
  if (input.engagementCompleted) {
    // The workspace banner already says the engagement is complete; this
    // headline reports the result of the submission only.
    return { headline: "Final handover scored", tone: "pass" };
  }
  switch (input.reason) {
    case "passed":
      return { headline: `Gate passed. You are now in ${input.nextStageTitle}.`, tone: "pass" };
    case "formative":
      return { headline: `Submitted. Moving on to ${input.nextStageTitle}.`, tone: "neutral" };
    case "retries-exhausted":
      return {
        headline: `Below the pass mark on your last attempt. The engagement moves on to ${input.nextStageTitle}.`,
        tone: "neutral",
      };
    default:
      return {
        headline: `Below the pass mark on attempt ${input.attempt}. Revise and resubmit.`,
        tone: "shortfall",
      };
  }
}

// What the banner says when the sponsor's reaction never arrived. The aside
// has to match the verdict above it: "your score and stage are unaffected" is
// reassurance written for a shortfall, and under a pass headline it reads as
// a contradiction.
export function noReactionCopy(input: {
  reason: GateDecision["reason"];
  engagementCompleted: boolean;
}): string {
  if (input.engagementCompleted) {
    return "The client sponsor did not reply this time; your handover still stands.";
  }
  switch (input.reason) {
    case "passed":
      return "The client sponsor did not reply this time; your pass stands.";
    case "formative":
      return "The client sponsor did not reply this time; your submission stands.";
    case "retries-exhausted":
      return "The client sponsor did not reply this time; the engagement still moves on.";
    default:
      return "The client sponsor has not replied to this one; your score and stage are unaffected.";
  }
}

export function formatScoreRatio(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// What the learner is told before they submit: the bar, how many attempts
// they get, what happens to each attempt, and which attempt this one is. A formative cohort has no bar, so
// it is told that plainly instead of a percentage it will never be held to.
export function gateExpectationCopy(input: {
  minScoreRatio: number | null;
  maxRetries: number;
  attemptsUsed: number;
}): string[] {
  const { minScoreRatio, maxRetries, attemptsUsed } = input;
  if (minScoreRatio === null) {
    return [
      "Scoring at this gate is formative: your artifact is scored for feedback and the engagement moves on either way.",
    ];
  }
  const attempts = maxRetries + 1;
  const lines = [
    `You need ${formatScoreRatio(minScoreRatio)} to pass. You have ${attempts} ${
      attempts === 1 ? "attempt" : "attempts"
    }; after that the engagement moves on.`,
    // The rule the code applies: no attempt replaces another. Every scored
    // submission and its scores are stored, and the monitor, the compare
    // view and the CSV export all list each one.
    "Every scored attempt is kept and shown to your instructor.",
  ];
  if (attemptsUsed > 0 && attemptsUsed < attempts) {
    lines.push(`This is attempt ${attemptsUsed + 1} of ${attempts}.`);
  }
  return lines;
}

// One line per stakeholder whose input a criterion at this stage needs
// (requiresExchange), stated before the learner submits: such a criterion is
// capped at NO_EXCHANGE_CAP_RATIO of its points when the learner has sent
// that stakeholder no message (lib/agents/rubric.ts lacksExchange). Display
// only; the cap itself is applied by the scoring pipeline.
export function exchangeCapCopy(
  rubric: readonly { maxScore: number; exchangeWith?: string }[],
  personas: readonly { id: string; name: string }[],
): string[] {
  const byPersona = new Map<string, number[]>();
  for (const c of rubric) {
    if (!c.exchangeWith) continue;
    byPersona.set(c.exchangeWith, [...(byPersona.get(c.exchangeWith) ?? []), c.maxScore]);
  }
  const lines: string[] = [];
  for (const [id, maxes] of byPersona) {
    const name = personas.find((p) => p.id === id)?.name;
    if (!name) continue;
    const subject = maxes.length === 1 ? `The criterion that needs ${name}'s input is` : `Criteria that need ${name}'s input are`;
    const distinct = [...new Set(maxes)];
    const cap =
      distinct.length === 1
        ? `${Math.floor(distinct[0] * NO_EXCHANGE_CAP_RATIO)} of ${distinct[0]}`
        : `${Math.round(NO_EXCHANGE_CAP_RATIO * 100)}% of ${maxes.length === 1 ? "its" : "their"} points`;
    // Same wording as the rubric criterion ("exchanged messages with"). The
    // persona record carries no pronoun, so the name is repeated.
    lines.push(`${subject} capped at ${cap} if you have exchanged no messages with ${name}.`);
  }
  return lines;
}

// The gap between what a submission scored and what it needed, so a learner
// looking at a shortfall knows how far short it fell.
export function gateShortfallCopy(input: {
  scoreRatio: number;
  minScoreRatio: number | null;
}): string | null {
  if (input.minScoreRatio === null) return null;
  return `Scored ${formatScoreRatio(input.scoreRatio)}; the pass mark is ${formatScoreRatio(
    input.minScoreRatio,
  )}.`;
}

export function decideGate(input: {
  scoreRatio: number;
  minScoreRatio: number | null;
  attempt: number;
  maxRetries: number;
}): GateDecision {
  const { scoreRatio, minScoreRatio, attempt, maxRetries } = input;

  if (minScoreRatio === null) {
    return { passed: null, advanced: true, reason: "formative" };
  }
  if (scoreRatio >= minScoreRatio) {
    return { passed: true, advanced: true, reason: "passed" };
  }
  const outOfRetries = attempt > maxRetries;
  return {
    passed: false,
    advanced: outOfRetries,
    reason: outOfRetries ? "retries-exhausted" : "below-threshold",
  };
}
