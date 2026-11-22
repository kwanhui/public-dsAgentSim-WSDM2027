// What the learner may see of a stage rubric.
//
// Each criterion has two wordings (lib/scenarios/types.ts). The full text
// names the specifics the learner is supposed to find out ("offer capacity
// (~6,000/month)", "duplicate subscriber_id rows"), and only the judge and
// the instructor read it. The learner wording (learnerText) says what is
// assessed without those facts, so it is shown at every stage, before and
// after the stage closes (the full text, shown once
// a stage closed, still handed over facts that later stages and retries
// depend on). The full text never reaches the learner: toPublicScenario
// already carries only the learner wording, and this module keeps the
// learner payload to that shape.

import type { PublicScenario, PublicStage } from "@/lib/scenarios/public";

export interface LearnerRubricCriterion {
  id: string;
  /** The learner wording of the criterion. Kept nullable for the workspace
   * component's type; it is always set since rubric-v4. */
  criterion: string | null;
  maxScore: number;
  /** Persona id whose channel needs a learner message for full credit. */
  exchangeWith?: string;
}

export interface LearnerStage extends Omit<PublicStage, "gate"> {
  gate: {
    kind: string;
    instructions: string;
    rubric: LearnerRubricCriterion[];
  };
}

export interface LearnerScenario extends Omit<PublicScenario, "stages"> {
  stages: LearnerStage[];
}

/** Stage ids the learner has closed: every stage before the current one,
 * and all of them once the engagement is complete. The rubric wording no
 * longer depends on it; it is kept for callers that show closed stages. */
export function closedStages(input: {
  stageIds: readonly string[];
  currentStage: string;
  completed: boolean;
}): string[] {
  if (input.completed) return [...input.stageIds];
  const current = input.stageIds.indexOf(input.currentStage);
  return current <= 0 ? [] : input.stageIds.slice(0, current);
}

/** The learner's view of the scenario rubric: the learner wording of every
 * criterion at every stage. The second argument (closed stages) no longer
 * changes the result. */
export function applyRubricVisibility(
  scenario: PublicScenario,
  _closedStages: Iterable<string> = [],
): LearnerScenario {
  return {
    ...scenario,
    stages: scenario.stages.map((stage) => ({
      ...stage,
      gate: {
        ...stage.gate,
        rubric: stage.gate.rubric.map(({ id, criterion, maxScore, exchangeWith }) => ({
          id,
          criterion,
          maxScore,
          ...(exchangeWith ? { exchangeWith } : {}),
        })),
      },
    })),
  };
}
