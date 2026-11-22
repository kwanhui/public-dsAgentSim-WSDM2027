CREATE TABLE IF NOT EXISTS "checkins" (
	"id" serial PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"kind" text NOT NULL,
	"answers_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rubric_scores" ADD COLUMN "override_score" integer;--> statement-breakpoint
ALTER TABLE "rubric_scores" ADD COLUMN "override_note" text;--> statement-breakpoint
ALTER TABLE "rubric_scores" ADD COLUMN "overridden_at" timestamp;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "reflection_text" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkins" ADD CONSTRAINT "checkins_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkins_engagement_id_idx" ON "checkins" USING btree ("engagement_id");