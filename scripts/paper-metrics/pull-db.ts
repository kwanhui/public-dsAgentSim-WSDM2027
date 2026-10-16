// Read-only pull of one cohort into the CSVs that analyse.py reads.
//
//   tsx scripts/paper-metrics/pull-db.ts --source pglite:<dir> --cohort <slug-or-id> --out <dir>
//   POSTGRES_URL_NON_POOLING=... tsx scripts/paper-metrics/pull-db.ts --source postgres --cohort <slug-or-id> --out <dir>
//
// Writes, into --out:
//   <slug>-events.csv, <slug>-rubric-scores.csv   same columns as the instructor exports
//   db-messages.csv          per-message token counts (the exports do not carry them)
//   db-submissions.csv       submission timestamps and lengths, no text
//   db-world-facts.csv       ledger fact lengths
//   db-cohorts.csv, db-engagements.csv, db-cohort-event-counts.csv
//
// Check-ins, reflections and submission text are not read. SELECT only.
import { mkdirSync, writeFileSync } from "node:fs";
import { flag, openSource, toCsvText, type Row } from "./source";

const EVENT_COLUMNS = [
  "engagement_id",
  "learner_hash",
  "scenario_id",
  "mode",
  "event_type",
  "detail_json",
  "timestamp_iso",
];

const SCORE_COLUMNS = [
  "engagement_id",
  "learner_hash",
  "scenario_id",
  "mode",
  "stage",
  "artifact_kind",
  "submission_id",
  "submitted_at_iso",
  "attempt",
  "passed",
  "criterion_id",
  "score",
  "effective_score",
  "max_score",
  "judge_model",
  "served_model",
  "prompt_version",
  "override_score",
  "override_note",
];

const USAGE = `Usage:
  tsx scripts/paper-metrics/pull-db.ts --source pglite:<dir>|postgres --cohort <slug-or-id> --out <dir>`;

async function main(argv: string[]): Promise<void> {
  const spec = flag(argv, "source");
  const ref = flag(argv, "cohort");
  const out = flag(argv, "out");
  if (!spec || !ref || !out) {
    console.error(USAGE);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  const db = await openSource(spec);
  try {
    const [cohort] = await db.query(`SELECT id, slug FROM cohorts WHERE slug = $1 OR id = $1 LIMIT 1`, [ref]);
    if (!cohort) throw new Error(`No cohort with slug or id "${ref}" in ${spec}`);
    const cohortId = String(cohort.id);
    const slug = String(cohort.slug);
    const write = (name: string, rows: Row[], columns?: string[]) => {
      writeFileSync(`${out}/${name}`, toCsvText(rows, columns), "utf8");
      console.log(`${name}: ${rows.length} rows`);
    };

    write(
      "db-cohorts.csv",
      await db.query(`SELECT id, slug, name, archived_at, config_json FROM cohorts ORDER BY created_at`),
    );
    write(
      "db-engagements.csv",
      await db.query(
        `SELECT e.id, e.cohort_id, e.mode, e.status, e.current_stage, e.created_at, e.completed_at,
                (SELECT count(*) FROM events v WHERE v.engagement_id = e.id) AS n_events
           FROM engagements e ORDER BY e.created_at`,
      ),
    );
    write(
      "db-messages.csv",
      await db.query(
        `SELECT m.id, m.engagement_id, m.channel_id, c.persona_id, m.sender,
                m.prompt_tokens, m.completion_tokens, m.timestamp_iso, length(m.content) AS content_chars
           FROM messages m JOIN channels c ON c.id = m.channel_id
           JOIN engagements e ON e.id = m.engagement_id
          WHERE e.cohort_id = $1 ORDER BY m.id`,
        [cohortId],
      ),
    );
    write(
      "db-submissions.csv",
      await db.query(
        `SELECT s.id, s.engagement_id, s.stage, s.kind, s.status, s.created_at, length(s.content_text) AS content_chars
           FROM submissions s JOIN engagements e ON e.id = s.engagement_id
          WHERE e.cohort_id = $1 ORDER BY s.created_at`,
        [cohortId],
      ),
    );
    write(
      "db-world-facts.csv",
      await db.query(
        `SELECT w.id, w.engagement_id, w.source, w.stage, w.created_at, length(w.fact) AS fact_chars
           FROM world_facts w JOIN engagements e ON e.id = w.engagement_id
          WHERE e.cohort_id = $1 ORDER BY w.id`,
        [cohortId],
      ),
    );
    write(
      "db-cohort-event-counts.csv",
      await db.query(
        `SELECT e.cohort_id, e.mode, count(*) FILTER (WHERE v.type = 'persona_turn') AS persona_turns,
                count(*) FILTER (WHERE v.type = 'persona_consistency') AS audits,
                count(*) FILTER (WHERE v.type = 'submission_scored') AS scored,
                count(*) FILTER (WHERE v.type = 'analyst_step') AS analyst_steps,
                count(DISTINCT e.id) AS engagements,
                min(v.timestamp_iso) AS first_event, max(v.timestamp_iso) AS last_event
           FROM events v JOIN engagements e ON e.id = v.engagement_id
          GROUP BY e.cohort_id, e.mode ORDER BY min(v.timestamp_iso)`,
      ),
    );

    // Events, in the instructor export's shape.
    const eventRows = await db.query(
      `SELECT v.engagement_id, s.learner_hash, e.scenario_id, e.mode, v.type AS event_type,
              v.detail_json, v.timestamp_iso
         FROM events v
         JOIN engagements e ON e.id = v.engagement_id
         JOIN students s ON s.id = e.student_id
        WHERE v.cohort_id = $1 ORDER BY v.id`,
      [cohortId],
    );
    write(`${slug}-events.csv`, eventRows, EVENT_COLUMNS);

    // Rubric scores, in the instructor export's shape. The attempt number and
    // the gate verdict live on submission_scored events, joined here by
    // submission id as the export route does.
    const gateBySubmission = new Map<string, { attempt: unknown; passed: unknown }>();
    for (const r of eventRows) {
      if (r.event_type !== "submission_scored") continue;
      const d = (typeof r.detail_json === "string" ? JSON.parse(r.detail_json) : r.detail_json) as {
        submissionId?: string;
        attempt?: unknown;
        passed?: unknown;
      } | null;
      if (d?.submissionId) {
        gateBySubmission.set(d.submissionId, {
          attempt: typeof d.attempt === "number" ? d.attempt : "",
          passed: typeof d.passed === "boolean" ? String(d.passed) : "",
        });
      }
    }
    const scoreRows = (
      await db.query(
        `SELECT r.engagement_id, s.learner_hash, e.scenario_id, e.mode, sub.stage, sub.kind AS artifact_kind,
                r.submission_id, sub.created_at AS submitted_at_iso, r.criterion_id, r.score,
                coalesce(r.override_score, r.score) AS effective_score, r.max_score,
                r.judge_model, r.served_model, r.prompt_version, r.override_score, r.override_note
           FROM rubric_scores r
           JOIN submissions sub ON sub.id = r.submission_id
           JOIN engagements e ON e.id = r.engagement_id
           JOIN students s ON s.id = e.student_id
          WHERE e.cohort_id = $1 ORDER BY r.id`,
        [cohortId],
      )
    ).map((r) => ({
      ...r,
      attempt: gateBySubmission.get(String(r.submission_id))?.attempt ?? "",
      passed: gateBySubmission.get(String(r.submission_id))?.passed ?? "",
    }));
    write(`${slug}-rubric-scores.csv`, scoreRows, SCORE_COLUMNS);
    console.log(`\nExport directory ready: --source export-dir:${out} --cohort ${slug}`);
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
