DELETE FROM "job_audience" WHERE jsonb_typeof("evidence" -> 'candidateLists') IS DISTINCT FROM 'array';
--> statement-breakpoint
CREATE VIEW "public"."job_audience_fresh" AS (select "job_id", "retrieved_at", "evidence" from "job_audience" where "job_audience"."retrieved_at" > now() - interval '30 days');
