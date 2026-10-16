// The effective score of a rubric criterion: the instructor's override when
// there is one, otherwise the judge's score. The judge's score is never
// changed in place (overrides sit beside it for agreement analysis), so every
// view that reports a grade goes through this one helper: the engagement
// monitor, the compare view, the analytics criterion means, the learner's
// workspace, and the effective_score CSV column. Pure, with no database
// import, so client components can use it too.

export interface ScoreLike {
  score: number;
  maxScore: number;
  overrideScore: number | null;
}

export function effectiveScore(row: ScoreLike): number {
  return row.overrideScore ?? row.score;
}

export interface SubmissionTotals {
  effective: number;
  judge: number;
  max: number;
  // True when any criterion carries an override that differs from the judge.
  adjusted: boolean;
}

export function submissionTotals(rows: ScoreLike[]): SubmissionTotals {
  let effective = 0;
  let judge = 0;
  let max = 0;
  let adjusted = false;
  for (const r of rows) {
    effective += effectiveScore(r);
    judge += r.score;
    max += r.maxScore;
    if (r.overrideScore !== null && r.overrideScore !== r.score) adjusted = true;
  }
  return { effective, judge, max, adjusted };
}

/** "14/20, instructor-adjusted; judge 16/20", or "16/20" when unadjusted. */
export function formatTotals(t: SubmissionTotals): string {
  const base = `${t.effective}/${t.max}`;
  return t.adjusted ? `${base}, instructor-adjusted; judge ${t.judge}/${t.max}` : base;
}

export interface CriterionScoreRow extends ScoreLike {
  scenarioId: string;
  stage: string;
  criterionId: string;
}

export interface CriterionMean {
  scenarioId: string;
  stage: string;
  criterionId: string;
  meanScore: number;
  maxScore: number;
  n: number;
}

/** Mean effective score per scenario, stage and criterion. */
export function meanEffectiveScores(rows: CriterionScoreRow[]): CriterionMean[] {
  const groups = new Map<string, CriterionMean & { sum: number }>();
  for (const r of rows) {
    const key = JSON.stringify([r.scenarioId, r.stage, r.criterionId]);
    const g =
      groups.get(key) ??
      { scenarioId: r.scenarioId, stage: r.stage, criterionId: r.criterionId, meanScore: 0, maxScore: 0, n: 0, sum: 0 };
    g.sum += effectiveScore(r);
    g.n += 1;
    g.maxScore = Math.max(g.maxScore, r.maxScore);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ sum, ...g }) => ({ ...g, meanScore: g.n > 0 ? sum / g.n : 0 }));
}
