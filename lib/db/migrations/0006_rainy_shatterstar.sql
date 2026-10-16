ALTER TABLE "cohort_invites" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "archived_at" timestamp with time zone;