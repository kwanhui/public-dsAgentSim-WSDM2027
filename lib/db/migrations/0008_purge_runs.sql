CREATE TABLE IF NOT EXISTS "purge_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cutoff_iso" text NOT NULL,
	"messages_deleted" integer NOT NULL,
	"events_deleted" integer NOT NULL
);
