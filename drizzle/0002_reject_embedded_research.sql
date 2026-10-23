UPDATE "jobs" SET "data" = "data" - 'audience' - 'hashtagCandidates';
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_research_external" CHECK (not ("jobs"."data" ? 'audience') and not ("jobs"."data" ? 'hashtagCandidates'));
