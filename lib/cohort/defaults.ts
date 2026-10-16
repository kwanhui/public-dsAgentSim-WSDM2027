import { z } from "zod";

// =========================================================================
// Schema for cohort.configJson, Zod-validated on read and write.
// =========================================================================

export const CohortConfigSchema = z.object({
  scenarios: z.object({
    // Scenario ids from configs/scenarios/ that learners in this cohort may
    // start. The learner picks one on first visit to the workspace.
    allowed: z.array(z.string()),
  }),
  gates: z.object({
    // If set, a stage only advances when the mean rubric score for the gate
    // submission reaches this fraction of the maximum (0..1). When null the
    // stage advances on any scored submission, the score is formative, and
    // no submission is reported to the learner as having passed a gate.
    minScoreRatio: z.number().min(0).max(1).nullable(),
    // How many times a learner may resubmit a stage artifact after falling
    // short of minScoreRatio before the gate opens anyway.
    maxRetries: z.number().int().min(0).max(10),
  }),
  // The provider and model ids are deployment settings (LLM_PROVIDER,
  // LLM_PERSONA_MODEL, LLM_RUBRIC_MODEL), not cohort settings. Configs saved
  // before that change still carry an llm.provider key; z.object drops
  // unknown keys, so they parse unchanged and the key disappears on the next
  // save. The temperature applies only where the active provider accepts it
  // (see samplingParams in lib/llm/client.ts).
  llm: z
    .object({
      temperature: z.number().min(0).max(2).default(0.4),
    })
    .default({}),
  ui: z.object({
    // Whether learners see rubric scores and rationales immediately after a
    // gate submission, or only the persona's in-character reaction.
    showRubricScores: z.boolean(),
  }),
  research: z.object({
    // Collect the six-item confidence check-in at engagement start and
    // completion (pre/post outcome measure). Off by default: the feature is
    // behind this flag, and the flag also gates the analytics section and the
    // check-in CSV export.
    checkins: z.boolean().default(false),
    // Offer the optional reflection textarea with each gate submission, store
    // what the learner writes, and show it in the monitor and compare views.
    // Off by default for the same reason as checkins. Turning it off hides
    // reflections already stored; it never deletes them.
    reflections: z.boolean().default(false),
    // Fraction of persona turns audited for consistency against the
    // world-fact ledger. Each persona's first two turns per engagement are
    // always audited regardless of this rate, so even a short run logs
    // consistency telemetry; the rate then applies to later turns (0 samples
    // none of them; 1 audits every turn). Each audit is an extra LLM call,
    // so this trades measurement density against cost.
    consistencyAuditRate: z.number().min(0).max(1),
  }),
  limits: z
    .object({
      // Learner messages allowed per engagement across all channels. Stops a
      // single engagement from running up an unbounded bill; a showcase or
      // sandbox cohort can set it lower.
      maxLearnerMessages: z.number().int().min(1).max(5000).default(200),
    })
    .default({}),
  sandbox: z
    .object({
      // When true, the public /try route creates a fresh pseudonymous learner
      // in this cohort without an invite. For demonstration cohorts only.
      openJoin: z.boolean().default(false),
      // Upper bound on learners created through /try per UTC day.
      maxJoinsPerDay: z.number().int().min(0).max(10000).default(50),
      // This cohort's own daily spend limit in USD, counted over its
      // engagements only and applied while openJoin is on
      // (lib/llm/budget.ts checkCohortBudget). It keeps anonymous visitors
      // from using up the deployment's budget, which the course and showcase
      // cohorts share. null switches it off (the global limit still
      // applies).
      dailyBudgetUsd: z.number().min(0).max(10000).nullable().default(2),
      // Learner messages per engagement for seats that joined through the
      // sandbox. The lower of this and limits.maxLearnerMessages applies
      // (lib/cohort/limits.ts).
      maxLearnerMessages: z.number().int().min(1).max(5000).default(40),
    })
    .default({}),
  showcase: z
    .object({
      // The pair the compare view opens on for this cohort, by engagement id.
      // Pinning it keeps the default comparison fixed while other runs are
      // added to the cohort; unset, the view pairs the furthest agent run
      // with the furthest human engagement. Added after the first release,
      // so it defaults to null and older stored configs parse unchanged.
      comparePair: z
        .object({ human: z.string().min(1), agent: z.string().min(1) })
        .nullable()
        .default(null),
      // Whether the read-only reviewer account may see this cohort at all
      // (lists, monitors, compare view, analytics, exports). Off by default,
      // so a course cohort or the sandbox on the same deployment stays out
      // of reach of the reviewer password printed in the paper. Configs stored
      // before this flag existed parse as false.
      reviewerVisible: z.boolean().default(false),
      // Short labels for showcase runs, by engagement id ("A1", "H1",
      // "exhibit"), shown in the cohort table, the compare pickers and the
      // monitor header so the runs a paper names can be found. Empty for
      // other cohorts.
      labels: z.record(z.string().min(1), z.string().min(1).max(40)).default({}),
      // Engagement ids of runs that an author script replayed rather than a
      // learner working live (H1 and the exhibit). The replay scripts set it
      // (scripts/replay/cohort.ts finalize); the admin views label these runs
      // "Scripted reference (author replay)" and call their wall clock
      // replay time. Labels H1 and exhibit count as replays without it, for
      // showcases regenerated before it existed (lib/admin/run-kind.ts).
      scriptedReplays: z.array(z.string().min(1)).default([]),
      // The replay patch applied to the regenerated reference human run H1
      // (scripts/replay/patches/), by file and sha256, so the showcase
      // records exactly which text H1 submitted. Null for other cohorts and
      // for a showcase regenerated before patches existed.
      h1Patch: z
        .object({ file: z.string().min(1).max(200), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
        .nullable()
        .default(null),
    })
    .default({}),
});

export type CohortConfig = z.infer<typeof CohortConfigSchema>;

// Configs are stored as JSON and older cohorts predate some keys. Every key
// added since the first release carries a default in the schema above, so a
// stored config parses as long as the keys it does have are valid; only a
// config that fails outright falls back to the defaults. Every reader goes
// through this one function so old and new configs are read the same way.
//
// A config that fails outright falls back to NEW_COHORT_CONFIG, the
// formative configuration a new cohort starts with, never to a hard gate:
// a corrupted row must not start gating learners on an unvalidated judge.
// The failure is logged once per distinct config so it can be found.
const reportedParseFailures = new Set<string>();

export function parseCohortConfig(raw: unknown): CohortConfig {
  const parsed = CohortConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const key = safeKey(raw);
  if (!reportedParseFailures.has(key)) {
    reportedParseFailures.add(key);
    if (reportedParseFailures.size > 100) reportedParseFailures.clear();
    console.warn(
      `cohort config failed to parse; using the formative new-cohort config (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")})`,
    );
  }
  return NEW_COHORT_CONFIG;
}

function safeKey(raw: unknown): string {
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

// =========================================================================
// Default config seeded into every new cohort. Instructors override
// per-cohort via the admin UI.
// =========================================================================

export const DEFAULT_COHORT_CONFIG: CohortConfig = {
  scenarios: {
    allowed: ["customer-churn", "customer-segmentation", "demand-forecasting"],
  },
  gates: {
    // A stage advances when the artifact reaches 60% of the rubric maximum,
    // or when the learner runs out of retries. Instructors who want purely
    // formative scoring set this to null in the cohort config; the learner
    // then sees "submitted and advancing" rather than a pass.
    minScoreRatio: 0.6,
    maxRetries: 2,
  },
  llm: {
    temperature: 0.4,
  },
  ui: {
    showRubricScores: true,
  },
  research: {
    checkins: false,
    reflections: false,
    consistencyAuditRate: 0.25,
  },
  limits: {
    maxLearnerMessages: 200,
  },
  sandbox: {
    openJoin: false,
    maxJoinsPerDay: 50,
    dailyBudgetUsd: 2,
    maxLearnerMessages: 40,
  },
  showcase: {
    comparePair: null,
    reviewerVisible: false,
    labels: {},
    scriptedReplays: [],
    h1Patch: null,
  },
};

// A cohort created from the admin page starts with formative gates: every
// scored submission advances, and nothing is reported to the learner as a
// pass or a fail. The judge's agreement with instructors has not been
// measured yet, so a hard gate is something an instructor turns on, not
// something they inherit. DEFAULT_COHORT_CONFIG keeps the 60% gate as the
// schema default for stored configs, and the showcase cohort sets its gate
// explicitly in its own config.
export const NEW_COHORT_CONFIG: CohortConfig = {
  ...DEFAULT_COHORT_CONFIG,
  gates: { ...DEFAULT_COHORT_CONFIG.gates, minScoreRatio: null },
};
