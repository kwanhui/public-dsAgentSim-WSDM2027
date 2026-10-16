ALTER TABLE "rubric_scores" ADD COLUMN "unverified_note" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "attempt" integer;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "gate_passed" boolean;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "gate_advanced" boolean;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "assessor_directed" boolean;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "assessor_quote" text;--> statement-breakpoint
UPDATE "submissions" AS s SET
  "attempt" = CASE WHEN jsonb_typeof(e."detail_json" -> 'attempt') = 'number' THEN (e."detail_json" ->> 'attempt')::integer END,
  "gate_passed" = CASE WHEN jsonb_typeof(e."detail_json" -> 'passed') = 'boolean' THEN (e."detail_json" ->> 'passed')::boolean END,
  "gate_advanced" = CASE WHEN jsonb_typeof(e."detail_json" -> 'advanced') = 'boolean' THEN (e."detail_json" ->> 'advanced')::boolean END
FROM (
  SELECT DISTINCT ON ("detail_json" ->> 'submissionId') "detail_json"
  FROM "events" WHERE "type" = 'submission_scored'
  ORDER BY "detail_json" ->> 'submissionId', "id" DESC
) AS e
WHERE e."detail_json" ->> 'submissionId' = s."id" AND s."attempt" IS NULL;--> statement-breakpoint
UPDATE "submissions" AS s SET
  "assessor_directed" = true,
  "assessor_quote" = CASE WHEN jsonb_typeof(e."detail_json" -> 'quote') = 'string' THEN e."detail_json" ->> 'quote' END
FROM (
  SELECT DISTINCT ON ("detail_json" ->> 'submissionId') "detail_json"
  FROM "events" WHERE "type" = 'submission_flagged'
  ORDER BY "detail_json" ->> 'submissionId', "id" DESC
) AS e
WHERE e."detail_json" ->> 'submissionId' = s."id" AND s."assessor_directed" IS NULL;--> statement-breakpoint
UPDATE "rubric_scores" AS r SET "unverified_note" = c."note"
FROM (
  SELECT e."detail_json" ->> 'submissionId' AS "submission_id", x ->> 'criterionId' AS "criterion_id", x ->> 'note' AS "note"
  FROM "events" AS e, jsonb_array_elements(CASE WHEN jsonb_typeof(e."detail_json" -> 'criteria') = 'array' THEN e."detail_json" -> 'criteria' ELSE '[]'::jsonb END) AS x
  WHERE e."type" = 'unverified_claim_flagged' AND jsonb_typeof(x -> 'note') = 'string'
) AS c
WHERE r."submission_id" = c."submission_id" AND r."criterion_id" = c."criterion_id" AND r."unverified_note" IS NULL;
