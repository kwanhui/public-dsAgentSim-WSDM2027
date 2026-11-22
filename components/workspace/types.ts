// Client-side shape of GET /api/engagement/me.

export interface BundleChannel {
  id: string;
  personaId: string;
  unlocked: boolean;
  /** Messages the personas have sent in this channel, for the unread mark. */
  messagesFromPersona: number;
}

export interface BundleScore {
  criterionId: string;
  /** Effective score: the instructor's override when present, else the judge. */
  score: number;
  /** The judge's own score, kept for display when an override differs. */
  judgeScore?: number;
  /** An instructor override that differs from the judge's score. */
  adjusted?: boolean;
  /** The instructor's note on the override, when they wrote one. */
  overrideNote?: string | null;
  maxScore: number;
  rationale: string;
  improve?: string | null;
}

export interface BundleSubmission {
  id: string;
  /** The instructor has reviewed this submission (an override, or the
   * engagement's flags marked reviewed after it came in). */
  reviewed?: boolean;
  stage: string;
  kind: string;
  status: string;
  createdAt: string;
  text: string;
  reflection: string | null;
  scores: BundleScore[];
}

export interface BundleStage {
  id: string;
  title: string;
  guidance: string;
  gate: {
    kind: string;
    instructions: string;
    /** The learner wording of each criterion, always set since rubric-v4
     * (lib/engagement/rubric-visibility.ts); nullable in the type only. */
    rubric: { id: string; criterion: string | null; maxScore: number; exchangeWith?: string }[];
  };
}

export interface BundlePersona {
  id: string;
  role: string;
  name: string;
  title: string;
  channelName: string;
  unlockedAtStage: string;
}

export interface BundleFile {
  file: string;
  description: string;
  dictionary: string;
}

export interface BundlePendingFile {
  file: string;
  description: string;
  columns: string[];
}

export interface WorkspaceBundle {
  engagement: {
    id: string;
    scenarioId: string;
    currentStage: string;
    status: string;
    /** An earlier engagement opened from the list, shown read-only. */
    past?: boolean;
  };
  /** Every engagement of this learner, newest first. */
  engagements?: BundleEngagementLink[];
  learner: {
    pseudonym: string;
    cohortName: string;
    joinRoute: "invite" | "sandbox" | "agent";
    provider?: string;
    /** DEMO_CONTACT for a sandbox seat, null otherwise or when unset. */
    demoContact?: string | null;
  };
  limits: {
    maxLearnerMessages: number;
    messagesSent: number;
    messagesRemaining: number;
  };
  scenario: {
    id: string;
    title: string;
    sector: string;
    task: string;
    brief: string;
    personas: BundlePersona[];
    stages: BundleStage[];
  };
  channels: BundleChannel[];
  releasedFiles: BundleFile[];
  /** Files not released yet, from the stage they become available: name,
   * description and column names only. Absent from older bundles. */
  pendingFiles?: BundlePendingFile[];
  submissions: BundleSubmission[];
  ui: { showRubricScores: boolean };
  /** Whether the cohort asks for the optional reflection with a submission. */
  research: { reflections: boolean };
  /** The cohort's gate policy, stated to the learner in the stage panel.
   * `minScoreRatio` is null for a formative cohort (no bar, always advances). */
  gates: { minScoreRatio: number | null; maxRetries: number };
  checkins: {
    enabled: boolean;
    goal: string | null;
    start: { answers: Record<string, number> } | null;
    complete: { answers: Record<string, number> } | null;
  };
}

export interface BundleEngagementLink {
  id: string;
  scenarioTitle: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  /** The engagement /workspace opens by default. */
  current: boolean;
}

export interface ChatMessage {
  id: number;
  sender: string;
  content: string;
  timestampIso: string;
  /** A platform line shown under the reply (a dropped file release); not
   * part of the stored message. */
  platformNote?: string | null;
}
