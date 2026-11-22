// Attempt numbering for gate submissions. Only scored submissions are
// attempts: a row left pending or marked failed (the judge was unavailable)
// never gave the learner a verdict, so it does not use up a retry and gets no
// attempt number. Pure, so the workspace, the monitor and tests agree.

export interface AttemptSubmission {
  id: string;
  stage: string;
  status: string;
}

export function isScored(s: { status: string }): boolean {
  return s.status === "scored";
}

/** Attempt number per scored submission id, counted per stage in the given
 * (chronological) order. Unscored submissions are absent from the map. */
export function attemptNumbers(submissions: AttemptSubmission[]): Map<string, number> {
  const perStage = new Map<string, number>();
  const numbers = new Map<string, number>();
  for (const s of submissions) {
    if (!isScored(s)) continue;
    const n = (perStage.get(s.stage) ?? 0) + 1;
    perStage.set(s.stage, n);
    numbers.set(s.id, n);
  }
  return numbers;
}

/** Scored attempts at one stage. */
export function attemptsUsed(submissions: AttemptSubmission[], stage: string): number {
  return submissions.filter((s) => s.stage === stage && isScored(s)).length;
}
