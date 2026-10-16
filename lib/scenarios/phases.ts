import type { StageId } from "./types";

// A generic phase label for each pipeline stage, so the six stages read as
// one CRISP-DM-style pipeline in the stage strip. Display only: the stage
// ids, the scenario stage titles and STAGE_TITLES stay as they are, and no
// prompt reads this map. The icon is a lucide-react component name.
//
// The lead is the one line the stage panel shows above "More guidance": what
// the learner does at the stage, in at most 22 words. It names roles rather
// than personas so it holds for every scenario; the scenario's own guidance
// stays in full under "More guidance".
export interface StagePhase {
  phase: string;
  icon: "Target" | "Database" | "Filter" | "ChartLine" | "ClipboardCheck" | "PackageCheck";
  blurb: string;
  lead: string;
}

export const STAGE_PHASES: Record<StageId, StagePhase> = {
  formulation: {
    phase: "Understand",
    icon: "Target",
    blurb: "Turn the request into a decision problem",
    lead: "Talk to the client sponsor and turn the request into a decision problem, with a target and a measure of success.",
  },
  "data-collection": {
    phase: "Collect",
    icon: "Database",
    blurb: "Agree the scope of use, get the extract",
    lead: "To get the extract released, state what data you need and why. The data owner answers only the questions you ask.",
  },
  cleaning: {
    phase: "Prepare",
    icon: "Filter",
    blurb: "Find and fix the defects",
    lead: "Profile the file against its data dictionary to find the defects, then record what you fixed and what you left.",
  },
  modelling: {
    phase: "Model",
    icon: "ChartLine",
    blurb: "Fit and justify a model",
    lead: "Fit a model that serves the objective you agreed, and ask the end user how they will use its output.",
  },
  testing: {
    phase: "Validate",
    icon: "ClipboardCheck",
    blurb: "Test it with the end user",
    lead: "Show the results to the end user as they would use them, and revise the output if their constraints demand it.",
  },
  deployment: {
    phase: "Deliver",
    icon: "PackageCheck",
    blurb: "Hand over what will run",
    lead: "Write the handover for the people who will run the model after you leave.",
  },
};

// "Understand · Problem formulation"; the title alone for an unknown id.
export function phaseLabel(id: string, title: string): string {
  const p = STAGE_PHASES[id as StageId];
  return p ? `${p.phase} · ${title}` : title;
}

// The stage panel's visible line: the authored lead, or for an unknown id
// the scenario guidance as given.
export function stageLead(id: string, guidance: string): string {
  return STAGE_PHASES[id as StageId]?.lead ?? guidance;
}
