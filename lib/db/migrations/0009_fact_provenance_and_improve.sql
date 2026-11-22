ALTER TABLE "rubric_scores" ADD COLUMN "improve" text;--> statement-breakpoint
ALTER TABLE "world_facts" ADD COLUMN "provenance" text;--> statement-breakpoint
UPDATE "world_facts" SET "provenance" = CASE
	WHEN "source" <> 'system' THEN 'persona'
	WHEN "fact" LIKE 'The released file %' THEN 'release-profile'
	WHEN "fact" LIKE 'The consultant delivered the %' OR "fact" LIKE 'The engagement moved past the %' THEN 'system'
	ELSE 'seed'
END WHERE "provenance" IS NULL;
