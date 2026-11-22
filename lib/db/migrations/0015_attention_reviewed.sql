ALTER TABLE "engagements" ADD COLUMN IF NOT EXISTS "attention_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN IF NOT EXISTS "attention_reviewed_by" text;
