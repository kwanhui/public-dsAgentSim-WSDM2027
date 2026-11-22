ALTER TABLE "data_releases" ADD COLUMN IF NOT EXISTS "scope_text_chars" integer;--> statement-breakpoint
ALTER TABLE "data_releases" ADD COLUMN IF NOT EXISTS "scope_text_sha256" text;--> statement-breakpoint
ALTER TABLE "data_releases" ADD COLUMN IF NOT EXISTS "scope_text_purged_at" timestamp with time zone;
