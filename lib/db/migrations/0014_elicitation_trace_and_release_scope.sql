CREATE TABLE IF NOT EXISTS "data_releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"file" text NOT NULL,
	"persona_id" text NOT NULL,
	"stage" text NOT NULL,
	"scope_message_id" integer,
	"scope_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "elicitation_trace" boolean;--> statement-breakpoint
ALTER TABLE "fact_elicitations" ADD COLUMN "detection" text DEFAULT 'reported' NOT NULL;--> statement-breakpoint
ALTER TABLE "fact_elicitations" ADD COLUMN "early" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rubric_scores" ADD COLUMN "stated_not_elicited" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_releases" ADD CONSTRAINT "data_releases_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "data_releases_engagement_file_idx" ON "data_releases" USING btree ("engagement_id","file");