import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, serial, timestamp, primaryKey, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

// =========================================================================
// Auth.js (NextAuth v5) tables (instructors only).
// Schema follows the Auth.js Drizzle adapter contract:
// https://authjs.dev/getting-started/adapters/drizzle
// =========================================================================

export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
  image: text("image"),
  role: text("role").notNull().default("instructor"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (acc) => [primaryKey({ columns: [acc.provider, acc.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

// =========================================================================
// Cohort + learner tables.
// Instructors own cohorts; learners join via one-time invite tokens and are
// pseudonymous: no email or PII stored, only an HMAC-derived learner hash.
// =========================================================================

export const cohorts = pgTable(
  "cohorts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    instructorId: text("instructor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    configJson: jsonb("config_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // Set when the instructor archives a finished class. Archiving hides the
    // cohort from the default cohort list and from cross-cohort views; no row
    // is deleted, so engagements, scores, and exports stay intact.
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (c) => [index("cohorts_instructor_id_idx").on(c.instructorId)],
);

export const cohortInvites = pgTable(
  "cohort_invites",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    cohortId: text("cohort_id").notNull().references(() => cohorts.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    // Revoking an invite keeps the row (so the instructor can see what was
    // issued and what happened to it) and expires it in the same write, which
    // is what stops redemption: acceptInvite already rejects expired tokens.
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (ci) => [index("invites_cohort_id_idx").on(ci.cohortId)],
);

export const students = pgTable(
  "students",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    cohortId: text("cohort_id").notNull().references(() => cohorts.id, { onDelete: "cascade" }),
    learnerHash: text("learner_hash").notNull().unique(),
    profileJson: jsonb("profile_json"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: "date" }),
  },
  (s) => [index("students_cohort_id_idx").on(s.cohortId)],
);

export const studentSessions = pgTable(
  "student_sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    studentId: text("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
    cookieToken: text("cookie_token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (ss) => [index("student_sessions_student_id_idx").on(ss.studentId)],
);

// =========================================================================
// Engagement domain model.
// An engagement is one learner's run through one scenario: a set of persona
// channels, a pipeline-stage pointer, stage-gate submissions with rubric
// scores, and a world-fact ledger that keeps personas mutually consistent.
// =========================================================================

export const engagements = pgTable(
  "engagements",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    cohortId: text("cohort_id").notNull().references(() => cohorts.id, { onDelete: "cascade" }),
    studentId: text("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").notNull(),
    currentStage: text("current_stage").notNull(),
    status: text("status").notNull().default("active"), // active | completed | abandoned
    // Who drives the learner side: "human" (default) or "agent"; the
    // analyst-agent demo mode. Agent runs go through the identical
    // engagement pipeline; this flag only marks provenance.
    mode: text("mode").notNull().default("human"),
    // True on engagements started after the elicitation trace existed
    // (migration 0014). Null on older rows and on rows restored from a
    // snapshot that lacks the column; lib/engagement/elicitation.ts then
    // decides from the rows and events whether a trace was recorded, so a
    // run that predates the trace reads "not recorded" rather than 0 of N.
    elicitationTrace: boolean("elicitation_trace"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    // The instructor's "Mark reviewed" on the cohort's needs-attention list
    // (lib/admin/attention.ts): who marked it and when. Flags raised before
    // this time drop out of the needs-attention filter; flags raised after it
    // bring the engagement back. The monitor and the export keep every flag.
    attentionReviewedAt: timestamp("attention_reviewed_at", { withTimezone: true, mode: "date" }),
    attentionReviewedBy: text("attention_reviewed_by"),
  },
  (e) => [
    index("engagements_cohort_id_idx").on(e.cohortId),
    index("engagements_student_id_idx").on(e.studentId),
    // DB-level guard behind the app-level check in POST /api/engagement:
    // concurrent starts cannot create two active engagements for a learner.
    uniqueIndex("engagements_one_active_per_student")
      .on(e.studentId)
      .where(sql`status = 'active'`),
  ],
);

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    engagementId: text("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
    personaId: text("persona_id").notNull(), // key into the scenario config's persona cards
    unlockedAt: timestamp("unlocked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (c) => [index("channels_engagement_id_idx").on(c.engagementId)],
);

// Raw transcripts are stored (unlike the hashed-only logs in llmLearnFair):
// the instructor needs to read engagement conversations for formative
// feedback, and learners are already pseudonymous. The retention cron purges
// rows after RETENTION_DAYS.
export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    engagementId: text("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
    sender: text("sender").notNull(), // "learner" or a personaId
    content: text("content").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    timestampIso: text("timestamp_iso").notNull(),
  },
  (m) => [
    index("messages_channel_id_idx").on(m.channelId),
    index("messages_engagement_id_idx").on(m.engagementId),
    index("messages_timestamp_idx").on(m.timestampIso),
  ],
);

export const submissions = pgTable(
  "submissions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    engagementId: text("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    kind: text("kind").notNull(), // e.g. problem-statement, data-quality-notes, model-results, final-report
    contentText: text("content_text").notNull(),
    // Optional learner reflection captured with the artifact. Never scored;
    // shown to the instructor (reflective-practice component).
    reflectionText: text("reflection_text"),
    // pending: stored, judge not yet answered. scored: has rubric_scores rows.
    // failed: the judge call threw. Only scored rows count as attempts; the
    // other two can be rescored by an instructor (lib/agents/rescore.ts).
    status: text("status").notNull().default("pending"), // pending | scored | failed
    // The grade record of a scored attempt: which attempt it was and what
    // the gate decided. Kept on the row, not only in the submission_scored
    // event, because the retention purge deletes events after RETENTION_DAYS
    // and a grade appeal can come later than that. Null on pending and
    // failed rows. lib/logging/grade-record.ts fills these from the events
    // for rows written before the columns existed, and before every purge.
    attempt: integer("attempt"),
    gatePassed: boolean("gate_passed"),
    gateAdvanced: boolean("gate_advanced"),
    // The judge reported text addressed to the assessor rather than the
    // client; the quote is the line it reported (learner text, kept with the
    // submission it came from and deleted with it).
    assessorDirected: boolean("assessor_directed"),
    assessorQuote: text("assessor_quote"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (s) => [index("submissions_engagement_id_idx").on(s.engagementId)],
);

// One row per rubric criterion per scored submission. judgeModel and
// promptVersion make every score traceable for the paper's analysis.
export const rubricScores = pgTable(
  "rubric_scores",
  {
    id: serial("id").primaryKey(),
    submissionId: text("submission_id").notNull().references(() => submissions.id, { onDelete: "cascade" }),
    engagementId: text("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    score: integer("score").notNull(),
    maxScore: integer("max_score").notNull(),
    rationale: text("rationale").notNull(),
    // One line on what would raise the score ("To improve: ..."), from
    // rubric-v3 on. Null on full marks and on rows scored by earlier judges.
    improve: text("improve"),
    // From rubric-v4: the judge found that this criterion rests on an
    // executed result the platform cannot check (a model metric, a split, a
    // computed statistic absent from the release profiles), so the score was
    // capped. rawScore is the judge's score before that cap. Null on rows
    // scored by earlier judges.
    unverifiedClaim: boolean("unverified_claim"),
    rawScore: integer("raw_score"),
    // The judge's note on why the result could not be checked. Copied from
    // the unverified_claim_flagged event so that it survives the purge.
    unverifiedNote: text("unverified_note"),
    // From rubric-v6: the rationale as the learner sees it, with every
    // sentence that names a withheld fact or undocumented defect the
    // submission does not mention removed (lib/agents/rationale-filter.ts).
    // The rationale column above keeps the full text for the instructor.
    // Null on rows scored by earlier judges.
    learnerRationale: text("learner_rationale"),
    // From rubric-v7: ids of withheld facts this criterion names that the
    // submission states although the elicitation trace does not show them
    // as obtained ("stated but not elicited"). For the instructor only; an
    // empty array means none, null means the row predates the check.
    statedNotElicited: jsonb("stated_not_elicited"),
    judgeModel: text("judge_model").notNull(),
    // The model id the provider reported serving (AI SDK response.modelId),
    // beside the configured judgeModel. Null when the provider reports none
    // and on rows scored before this column existed.
    servedModel: text("served_model"),
    promptVersion: text("prompt_version").notNull(),
    // Instructor moderation: the judge's score above is never mutated; an
    // override sits beside it so judge-vs-instructor agreement can be
    // analysed from the export.
    overrideScore: integer("override_score"),
    overrideNote: text("override_note"),
    overriddenAt: timestamp("overridden_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (r) => [
    index("rubric_scores_submission_id_idx").on(r.submissionId),
    index("rubric_scores_engagement_id_idx").on(r.engagementId),
  ],
);

// Shared engagement state: commitments and reveals that all personas must
// stay consistent with (e.g. the client agreed to a scope change, the data
// owner already disclosed the duplicate-rows quirk). Appended by the
// orchestrator, injected into every persona's system prompt.
export const worldFacts = pgTable(
  "world_facts",
  {
    id: serial("id").primaryKey(),
    engagementId: text("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
    fact: text("fact").notNull(),
    source: text("source").notNull(), // personaId or "system" (stage gates, friction events)
    // Where the fact came from, which decides how far the rubric judge may
    // trust it: seed (scenario set-up), release-profile (the deterministic
    // profile of a released file), system (platform events such as a stage
    // advance), or persona (a fact a stakeholder model wrote from its own
    // reply). Null on rows written before the column existed and on rows
    // restored from an older snapshot; lib/engagement/provenance.ts infers
    // those.
    provenance: text("provenance"),
    stage: text("stage").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (w) => [index("world_facts_engagement_id_idx").on(w.engagementId)],
);

// Pre/post confidence check-ins: six Likert items (one per pipeline stage)
// answered at engagement start and completion, giving a
// within-subject outcome measure.
export const checkins = pgTable(
  "checkins",
  {
    id: serial("id").primaryKey(),
    engagementId: text("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // start | complete
    answersJson: jsonb("answers_json").notNull(), // { [stageId]: 1..7 }
    // Optional learner-set goal, captured with the start check-in and echoed
    // at completion so learners can judge their own progress against it.
    goal: text("goal"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (c) => [index("checkins_engagement_id_idx").on(c.engagementId)],
);

// Generic engagement event log (stage_advanced, data_released,
// friction_triggered, submission_scored, ...) for analytics and the
// instructor's engagement monitor.
export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    engagementId: text("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
    cohortId: text("cohort_id").references(() => cohorts.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    detailJson: jsonb("detail_json"),
    timestampIso: text("timestamp_iso").notNull(),
  },
  (e) => [
    index("events_engagement_id_idx").on(e.engagementId),
    index("events_cohort_id_idx").on(e.cohortId),
    index("events_timestamp_idx").on(e.timestampIso),
  ],
);

// Hidden facts obtained, one row per withheld fact per engagement. The
// persona reports the ids it revealed; the row records that self-report and
// whether the delivered reply actually contains one of
// the fact's keys (verified). Grade-relevant, so it lives outside the
// messages and events tables that the retention purge deletes; it is removed
// only with its engagement. messageId names the persona message that shared
// the fact, with no foreign key because messages are purged.
export const factElicitations = pgTable(
  "fact_elicitations",
  {
    id: serial("id").primaryKey(),
    engagementId: text("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
    factId: text("fact_id").notNull(),
    personaId: text("persona_id").notNull(),
    stage: text("stage").notNull(),
    // turn | reaction
    source: text("source").notNull(),
    turnIndex: integer("turn_index").notNull(),
    learnerMessagesSoFar: integer("learner_messages_so_far").notNull(),
    verified: boolean("verified").notNull(),
    // The key found in the reply when verified.
    matchedKey: text("matched_key"),
    // How the reveal was found (migration 0014): "reported" when the persona
    // model listed the fact in revealedWithheld, "detected" when the server
    // found one of its keys in a reply that did not report it.
    detection: text("detection").notNull().default("reported"),
    // The consistency auditor found that the reply stated the fact before
    // the consultant met its condition (early disclosure).
    early: boolean("early").notNull().default(false),
    messageId: integer("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
  },
  (f) => [uniqueIndex("fact_elicitations_engagement_fact_idx").on(f.engagementId, f.factId)],
);

// One row per honoured data release (migration 0014): the file, the data
// owner, and the learner's own words that met the release precondition
// (a dictionary column and a purpose; lib/agents/release-scope.ts). The
// scope text is copied here, up to 500 characters, because the messages and
// events that also hold it are deleted by the retention purge. The text is
// the learner's own chat, so the same purge blanks it once the row is older
// than the retention window (migration 0017) and keeps only its length and
// sha256, which still show that a scope was stated and let a copy of the
// text be matched to the row.
export const dataReleases = pgTable(
  "data_releases",
  {
    id: serial("id").primaryKey(),
    engagementId: text("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
    file: text("file").notNull(),
    personaId: text("persona_id").notNull(),
    stage: text("stage").notNull(),
    // The learner message the release answered; no foreign key because
    // messages are purged.
    scopeMessageId: integer("scope_message_id"),
    scopeText: text("scope_text"),
    // Set by the retention purge when it blanks scope_text (migration 0017).
    scopeTextChars: integer("scope_text_chars"),
    scopeTextSha256: text("scope_text_sha256"),
    scopeTextPurgedAt: timestamp("scope_text_purged_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (d) => [uniqueIndex("data_releases_engagement_file_idx").on(d.engagementId, d.file)],
);

// One row per successful retention purge (lib/logging/retention.ts), so the
// public health endpoint can report when the purge last ran. A purge that
// never runs (CRON_SECRET unset, cron misconfigured) is otherwise silent.
export const purgeRuns = pgTable("purge_runs", {
  id: serial("id").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  cutoffIso: text("cutoff_iso").notNull(),
  messagesDeleted: integer("messages_deleted").notNull(),
  eventsDeleted: integer("events_deleted").notNull(),
});

// One row per instructor deletion of a learner, an engagement or a cohort
// (lib/admin/deletion.ts). No foreign keys, so the row outlives what it
// records, and no content: the kind, the deleted row's id, its cohort, who
// deleted it, and how many rows each table lost. The ids are random uuids
// that link to nothing once the rows are gone.
export const deletionLog = pgTable("deletion_log", {
  id: serial("id").primaryKey(),
  type: text("type").notNull().default("data_deleted"),
  kind: text("kind").notNull(), // learner | engagement | cohort
  targetId: text("target_id").notNull(),
  cohortId: text("cohort_id"),
  actorId: text("actor_id"),
  rowsJson: jsonb("rows_json").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
