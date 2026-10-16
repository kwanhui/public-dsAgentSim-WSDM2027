// Learner-facing lines that more than one workspace component shows, kept in
// one pure module so the result banner, the past-submission rows, the help
// panel and the tests read the same words.

import { SANDBOX_SEAT_LINE } from "@/app/privacy/provider-line";

export type LearnerJoinRoute = "invite" | "sandbox" | "agent";

/** Under every scored result the learner sees, until an instructor has
 * looked at it. A language model scores the work, and the instructor can
 * change a score later, so no stage result reads as final. */
export const JUDGE_SCORE_NOTE = "Judge's score; your instructor may review it.";

/** Once the instructor has looked at the submission (an override, or the
 * engagement's flags marked reviewed after it came in). */
export const REVIEWED_NOTE = "Reviewed by your instructor.";

/** A sandbox seat has no instructor, so its scores stay the judge's. */
export const SANDBOX_SCORE_NOTE = "Judge's score. No instructor reviews scores in the demo sandbox.";

/** The one line a mock deployment shows in place of placeholder rationales
 * and suggestions. */
export const MOCK_LINE = "Demo mode: replies and scores are placeholders.";

/** When a score is below the maximum and the judge gave no suggestion (or
 * an instructor lowered a full-marks score). */
export const GENERIC_IMPROVE =
  "Reread the criterion above and check which part of it your submission does not yet cover.";

/** Formative gates move on either way, so the feedback is for what comes
 * next rather than for a revision of this artifact. */
export const FORMATIVE_CARRY_LINE = "Carry this feedback into your next artifact.";

/** "16 of 20 points": the one score format the learner sees. */
export function pointsLine(score: number, max: number): string {
  return `${score} of ${max} ${max === 1 ? "point" : "points"}`;
}

/** "4 of 5": a criterion score, where "points" would repeat on every row. */
export function criterionScore(score: number, max: number): string {
  return `${score} of ${max}`;
}

/** "Adjusted by your instructor (judge: 4 of 5)". */
export function adjustedLine(judgeScore: number, max: number): string {
  return `Adjusted by your instructor (judge: ${criterionScore(judgeScore, max)})`;
}

/** The suggestion to show under a criterion: the judge's own, or the
 * generic line when the standing score is below the maximum and the judge
 * gave none. Null at full marks. */
export function improveFor(score: { score: number; maxScore: number; improve?: string | null }): string | null {
  if (score.improve && score.improve.trim()) return score.improve;
  return score.score < score.maxScore ? GENERIC_IMPROVE : null;
}

/** The review line under a result: reviewed, or the judge's score. A
 * sandbox seat is never reviewed, and its line does not mention an
 * instructor. */
export function reviewNote(reviewed: boolean | undefined, joinRoute: LearnerJoinRoute = "invite"): string {
  if (joinRoute === "sandbox") return SANDBOX_SCORE_NOTE;
  return reviewed ? REVIEWED_NOTE : JUDGE_SCORE_NOTE;
}

/** The completion banner's note on scores. */
export function completedScoresLine(joinRoute: LearnerJoinRoute): string {
  return joinRoute === "sandbox"
    ? "Scores are the judge's; no instructor reviews the demo sandbox. "
    : "Scores are the judge's until your instructor reviews them. ";
}

/** How a learner gets back to this engagement from another device. A
 * sandbox visitor has no instructor, and a sandbox seat cannot be resumed. */
export function otherDeviceLine(joinRoute: LearnerJoinRoute): string {
  return joinRoute === "sandbox"
    ? SANDBOX_SEAT_LINE
    : "To continue on another device, ask your instructor for a resume link.";
}

/** The closing paragraph of "How this works". */
export function helpStorageLine(joinRoute: LearnerJoinRoute): string {
  return joinRoute === "sandbox"
    ? `Drafts are saved in this browser only. ${SANDBOX_SEAT_LINE}`
    : "Drafts are saved in this browser only, and you stay signed in on this device. To continue on another device, ask your instructor for a resume link.";
}

/** A mock persona reply ends with a "(Demo mode: ...)" note from the mock
 * model. The workspace says it once in the channel header instead. */
export function withoutMockNote(content: string): string {
  return content.replace(/\s*\(Demo mode:[^)]*\)\s*$/, "");
}
