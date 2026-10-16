CREATE TABLE IF NOT EXISTS "fact_elicitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"fact_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"stage" text NOT NULL,
	"source" text NOT NULL,
	"turn_index" integer NOT NULL,
	"learner_messages_so_far" integer NOT NULL,
	"verified" boolean NOT NULL,
	"matched_key" text,
	"message_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rubric_scores" ADD COLUMN "learner_rationale" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_elicitations" ADD CONSTRAINT "fact_elicitations_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fact_elicitations_engagement_fact_idx" ON "fact_elicitations" USING btree ("engagement_id","fact_id");