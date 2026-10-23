CREATE TABLE "job_audience" (
	"job_id" text PRIMARY KEY NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"evidence" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_audience" ADD CONSTRAINT "job_audience_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_audience_retrieved_idx" ON "job_audience" USING btree ("retrieved_at");
--> statement-breakpoint
UPDATE "jobs" SET "data" = "data" - 'audience' - 'hashtagCandidates';
