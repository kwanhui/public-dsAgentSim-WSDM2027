CREATE TABLE IF NOT EXISTS "deletion_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text DEFAULT 'data_deleted' NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"cohort_id" text,
	"actor_id" text,
	"rows_json" jsonb NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
