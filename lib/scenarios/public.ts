// Learner-visible projection of a scenario config. Persona cards, data
// dictionaries, and world-fact seeds are instructor/agent material and must
// never reach the browser: learners are supposed to elicit that knowledge
// by talking to the personas.

import type { Scenario, StageId } from "./types";

export interface PublicPersona {
  id: string;
  role: string;
  name: string;
  title: string;
  channelName: string;
  unlockedAtStage: StageId;
}

export interface PublicStage {
  id: StageId;
  title: string;
  guidance: string;
  gate: {
    kind: string;
    instructions: string;
    // criterion is the learner wording (learnerText), never the full
    // fact-bearing text the judge reads. exchangeWith is the persona id of a
    // criterion that is capped when the learner has not messaged that
    // persona (requiresExchange), so the gate box can say so in advance.
    rubric: { id: string; criterion: string; maxScore: number; exchangeWith?: string }[];
  };
}

export interface PublicScenario {
  id: string;
  title: string;
  sector: string;
  task: string;
  estimatedEffort?: string;
  brief: string;
  personas: PublicPersona[];
  stages: PublicStage[];
}

export function toPublicScenario(s: Scenario): PublicScenario {
  return {
    id: s.id,
    title: s.title,
    sector: s.sector,
    task: s.task,
    estimatedEffort: s.estimatedEffort,
    brief: s.brief,
    personas: s.personas.map(({ id, role, name, title, channelName, unlockedAtStage }) => ({
      id,
      role,
      name,
      title,
      channelName,
      unlockedAtStage,
    })),
    // The rubric is shown to learners in its learner wording: what good work
    // looks like, without the figures and defects the full criterion checks
    // for. The full text stays with the judge and the
    // instructor.
    stages: s.stages.map((st) => ({
      id: st.id,
      title: st.title,
      guidance: st.guidance,
      gate: {
        kind: st.gate.kind,
        instructions: st.gate.instructions,
        rubric: st.gate.rubric.map(({ id, learnerText, maxScore, owner, requiresExchange }) => ({
          id,
          criterion: learnerText,
          maxScore,
          ...(requiresExchange && owner ? { exchangeWith: owner } : {}),
        })),
      },
    })),
  };
}
