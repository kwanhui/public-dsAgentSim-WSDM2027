// The total a completed engagement shows in its completion banner: the
// standing scores (instructor override, else judge) of the last scored
// submission at each stage. Pure, so the sum is testable apart from React.

interface ScoredSubmission {
  stage: string;
  scores: { score: number; maxScore: number }[];
}

export interface EngagementTotal {
  score: number;
  max: number;
}

/** Null when scores are hidden from the learner or nothing was scored. */
export function engagementTotal(
  submissions: ScoredSubmission[],
  showRubricScores: boolean,
): EngagementTotal | null {
  if (!showRubricScores) return null;
  // Submissions arrive in submission order, so a later one at the same stage
  // replaces the earlier.
  const lastScored = new Map<string, ScoredSubmission>();
  for (const s of submissions) {
    if (s.scores.length > 0) lastScored.set(s.stage, s);
  }
  if (lastScored.size === 0) return null;
  let score = 0;
  let max = 0;
  for (const s of lastScored.values()) {
    for (const r of s.scores) {
      score += r.score;
      max += r.maxScore;
    }
  }
  return { score, max };
}

export function engagementTotalLine(total: EngagementTotal | null): string | null {
  return total ? `Total ${total.score} of ${total.max}.` : null;
}
