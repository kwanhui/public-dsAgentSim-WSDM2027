ALTER TABLE "rubric_scores" ADD COLUMN "unverified_claim" boolean;--> statement-breakpoint
ALTER TABLE "rubric_scores" ADD COLUMN "raw_score" integer;--> statement-breakpoint
UPDATE "world_facts" SET "provenance" = 'system' WHERE "fact" LIKE 'The data owner released the dataset file %';
