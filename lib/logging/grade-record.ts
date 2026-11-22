// The grade record of each scored submission, kept on the rows that the
// retention purge does not touch (submissions and rubric_scores): the attempt
// number and the gate decision, the assessor-directed flag and quote, and the
// judge's note on an unverified result. The scoring path writes these columns
// directly (recordRubricScores and applyGateDecision in
// lib/agents/stage-gate.ts). The statements below are the fallback for rows
// scored before it did: they copy the same values from the events
// (submission_scored, submission_flagged, unverified_claim_flagged).
// Migration 0012 ran them once, and purgeExpiredLogs runs them again before
// it deletes any event. Each statement only fills columns that are still
// null, so a value written at scoring time is never replaced and running
// them twice changes nothing.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export const GRADE_RECORD_STATEMENTS: readonly string[] = [
  `UPDATE "submissions" AS s SET
  "attempt" = CASE WHEN jsonb_typeof(e."detail_json" -> 'attempt') = 'number' THEN (e."detail_json" ->> 'attempt')::integer END,
  "gate_passed" = CASE WHEN jsonb_typeof(e."detail_json" -> 'passed') = 'boolean' THEN (e."detail_json" ->> 'passed')::boolean END,
  "gate_advanced" = CASE WHEN jsonb_typeof(e."detail_json" -> 'advanced') = 'boolean' THEN (e."detail_json" ->> 'advanced')::boolean END
FROM (
  SELECT DISTINCT ON ("detail_json" ->> 'submissionId') "detail_json"
  FROM "events" WHERE "type" = 'submission_scored'
  ORDER BY "detail_json" ->> 'submissionId', "id" DESC
) AS e
WHERE e."detail_json" ->> 'submissionId' = s."id" AND s."attempt" IS NULL`,
  `UPDATE "submissions" AS s SET
  "assessor_directed" = true,
  "assessor_quote" = CASE WHEN jsonb_typeof(e."detail_json" -> 'quote') = 'string' THEN e."detail_json" ->> 'quote' END
FROM (
  SELECT DISTINCT ON ("detail_json" ->> 'submissionId') "detail_json"
  FROM "events" WHERE "type" = 'submission_flagged'
  ORDER BY "detail_json" ->> 'submissionId', "id" DESC
) AS e
WHERE e."detail_json" ->> 'submissionId' = s."id" AND s."assessor_directed" IS NULL`,
  `UPDATE "rubric_scores" AS r SET "unverified_note" = c."note"
FROM (
  SELECT e."detail_json" ->> 'submissionId' AS "submission_id", x ->> 'criterionId' AS "criterion_id", x ->> 'note' AS "note"
  FROM "events" AS e, jsonb_array_elements(CASE WHEN jsonb_typeof(e."detail_json" -> 'criteria') = 'array' THEN e."detail_json" -> 'criteria' ELSE '[]'::jsonb END) AS x
  WHERE e."type" = 'unverified_claim_flagged' AND jsonb_typeof(x -> 'note') = 'string'
) AS c
WHERE r."submission_id" = c."submission_id" AND r."criterion_id" = c."criterion_id" AND r."unverified_note" IS NULL`,
];

export async function syncGradeRecord(): Promise<void> {
  for (const statement of GRADE_RECORD_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}
