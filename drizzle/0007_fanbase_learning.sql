CREATE TABLE "artist_outcomes" (
	"artist_id" text NOT NULL,
	"video_id" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"requested_start" date NOT NULL,
	"requested_end" date NOT NULL,
	"coverage" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"live" jsonb NOT NULL,
	"differs_from_approved" boolean,
	CONSTRAINT "artist_outcomes_artist_id_video_id_pk" PRIMARY KEY("artist_id","video_id"),
	CONSTRAINT "artist_outcomes_coverage_check" CHECK ("artist_outcomes"."coverage" in ('open', 'complete', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "artist_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_research" (
	"run_id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"evidence" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_research" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "peer_rejections" (
	"artist_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "peer_rejections_artist_id_channel_id_pk" PRIMARY KEY("artist_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "peer_rejections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_runs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"id" text DEFAULT gen_random_uuid()::text NOT NULL,
	"owner_uid" text NOT NULL,
	"artist_id" text NOT NULL,
	"stage" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"claim_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"wait" text,
	"error" text,
	"limits" text[] DEFAULT '{}'::text[] NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "research_runs_id_unique" UNIQUE("id"),
	CONSTRAINT "research_runs_stage_check" CHECK ("research_runs"."stage" in ('learn', 'discover', 'match', 'releases', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "research_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artist_guides" ADD COLUMN "influence" jsonb;--> statement-breakpoint
ALTER TABLE "artist_outcomes" ADD CONSTRAINT "artist_outcomes_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_research" ADD CONSTRAINT "job_research_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_rejections" ADD CONSTRAINT "peer_rejections_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_owner_uid_users_uid_fk" FOREIGN KEY ("owner_uid") REFERENCES "public"."users"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_research_retrieved_idx" ON "job_research" USING btree ("retrieved_at");--> statement-breakpoint
CREATE INDEX "job_research_job_idx" ON "job_research" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "artist_guides" ADD CONSTRAINT "artist_guides_influence_slot_check" CHECK ("artist_guides"."influence" is null or ("artist_guides"."kind" = 'brand' and "artist_guides"."status" = 'approved'));--> statement-breakpoint
-- Exactly the five slider roles, each a whole number 0-4. Defined before the check that calls it.
CREATE FUNCTION public.soundboard_influence_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p) IS DISTINCT FROM 'object' THEN false
    ELSE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)
        = array['discovery', 'feel', 'sound', 'structure', 'wording']
      AND (SELECT bool_and(CASE WHEN jsonb_typeof(v) = 'number' THEN v::numeric IN (0, 1, 2, 3, 4) ELSE false END)
        FROM jsonb_each(p) e(k, v))
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_influence_ok(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_influence_ok(jsonb) TO soundboard_app;
--> statement-breakpoint
ALTER TABLE "artist_guides" ADD CONSTRAINT "artist_guides_influence_check" CHECK ("artist_guides"."influence" is null or public.soundboard_influence_ok("artist_guides"."influence"));--> statement-breakpoint
CREATE POLICY "outcomes_read" ON "artist_outcomes" AS PERMISSIVE FOR SELECT TO "soundboard_app" USING (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "artist_outcomes"."artist_id") and "artist_outcomes"."retrieved_at" > now() - interval '29 days' and exists (select 1 from public.connections c where c.uid = nullif(current_setting('app.user_sub', true), '') and c.status = 'connected' and c.scopes @> '{https://www.googleapis.com/auth/yt-analytics.readonly}'));--> statement-breakpoint
CREATE POLICY "outcomes_cleanup_read" ON "artist_outcomes" AS PERMISSIVE FOR SELECT TO "soundboard_cleanup" USING ("artist_outcomes"."retrieved_at" <= now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "outcomes_cleanup_delete" ON "artist_outcomes" AS PERMISSIVE FOR DELETE TO "soundboard_cleanup" USING ("artist_outcomes"."retrieved_at" <= now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "research_read" ON "job_research" AS PERMISSIVE FOR SELECT TO "soundboard_app" USING ("job_research"."retrieved_at" > now() - interval '29 days' and exists (select 1 from public.jobs j where j.id = "job_research"."job_id" and j.owner_uid = nullif(current_setting('app.user_sub', true), '')) and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active));--> statement-breakpoint
CREATE POLICY "research_cleanup_read" ON "job_research" AS PERMISSIVE FOR SELECT TO "soundboard_cleanup" USING ("job_research"."retrieved_at" <= now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "research_cleanup_delete" ON "job_research" AS PERMISSIVE FOR DELETE TO "soundboard_cleanup" USING ("job_research"."retrieved_at" <= now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "rejections_read" ON "peer_rejections" AS PERMISSIVE FOR SELECT TO "soundboard_app" USING (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "peer_rejections"."artist_id") and "peer_rejections"."retrieved_at" > now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "rejections_cleanup_read" ON "peer_rejections" AS PERMISSIVE FOR SELECT TO "soundboard_cleanup" USING ("peer_rejections"."retrieved_at" <= now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "rejections_cleanup_delete" ON "peer_rejections" AS PERMISSIVE FOR DELETE TO "soundboard_cleanup" USING ("peer_rejections"."retrieved_at" <= now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "runs_owner" ON "research_runs" AS PERMISSIVE FOR ALL TO "soundboard_app" USING ("research_runs"."owner_uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active)) WITH CHECK ("research_runs"."owner_uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.jobs j join public.users u on u.uid = nullif(current_setting('app.user_sub', true), '') where j.id = "research_runs"."job_id" and j.owner_uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "research_runs"."artist_id"));
--> statement-breakpoint
ALTER TABLE research_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_research FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE artist_outcomes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE peer_rejections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON research_runs, job_research, artist_outcomes, peer_rejections FROM PUBLIC;
--> statement-breakpoint
-- No INSERT or UPDATE of `id`: a run's id keys its evidence, so only the database picks it.
GRANT SELECT, DELETE, INSERT (job_id, owner_uid, artist_id, stage), UPDATE (stage, seq, cursor, claim_token, claim_until, consecutive_failures, wait, error, limits, updated_at, finished_at) ON research_runs TO soundboard_app;
--> statement-breakpoint
GRANT SELECT ON job_research, artist_outcomes, peer_rejections TO soundboard_app;
--> statement-breakpoint
GRANT SELECT (run_id, retrieved_at), DELETE ON job_research TO soundboard_cleanup;
--> statement-breakpoint
GRANT SELECT (artist_id, video_id, retrieved_at), DELETE ON artist_outcomes TO soundboard_cleanup;
--> statement-breakpoint
GRANT SELECT (artist_id, channel_id, retrieved_at), DELETE ON peer_rejections TO soundboard_cleanup;
--> statement-breakpoint
-- The caller's live claim on a run of their own job that isn't discarded; locks the run row.
CREATE FUNCTION public.soundboard_research_claim(p_run text, p_token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_job text;
BEGIN
  SELECT r.job_id INTO v_job FROM public.research_runs r JOIN public.jobs j ON j.id = r.job_id
    WHERE r.id = p_run AND r.claim_token = p_token AND r.claim_until > now()
      AND r.owner_uid = nullif(current_setting('app.user_sub', true), '') AND j.state <> 'DISCARDED'
    FOR UPDATE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research claim lost' USING ERRCODE = '55000';
  END IF;
  RETURN v_job;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_research_claim(text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_save_research(p_run text, p_token text, p_at timestamptz, p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_job text := public.soundboard_research_claim(p_run, p_token);
BEGIN
  -- One minute of tolerance for the app's clock running ahead of the database's.
  IF p_at IS NULL OR p_at > now() + interval '1 minute' OR p_at <= now() - interval '29 days' THEN
    RAISE EXCEPTION 'Retrieval time out of range' USING ERRCODE = '22023';
  END IF;
  -- The first read's time is kept, so a later batch can never extend the evidence's life. A row
  -- under this run id for another job is never overwritten.
  INSERT INTO public.job_research (run_id, job_id, retrieved_at, evidence)
    VALUES (p_run, v_job, p_at, p_evidence)
    ON CONFLICT (run_id) DO UPDATE SET evidence = excluded.evidence
    WHERE public.job_research.job_id = excluded.job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research evidence belongs to another job' USING ERRCODE = '42501';
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_save_research(text, text, timestamptz, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_save_research(text, text, timestamptz, jsonb) TO soundboard_app;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_caller_artist() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_artist text;
BEGIN
  SELECT u.artist_id INTO v_artist FROM public.users u
    WHERE u.uid = nullif(current_setting('app.user_sub', true), '') AND u.active AND u.artist_id IS NOT NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artist profile required' USING ERRCODE = '42501';
  END IF;
  RETURN v_artist;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_caller_artist() FROM PUBLIC;
--> statement-breakpoint
-- The caller's artist, only while it is still the run's: a relink mid-run refuses the write rather
-- than filing what was read for one artist under another.
CREATE FUNCTION public.soundboard_run_artist(p_run text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_artist text := public.soundboard_caller_artist();
BEGIN
  PERFORM 1 FROM public.research_runs r WHERE r.id = p_run AND r.artist_id = v_artist;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research run belongs to another artist' USING ERRCODE = '42501';
  END IF;
  RETURN v_artist;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_run_artist(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_save_outcomes(p_run text, p_token text, p_grant_at timestamptz, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_sub text := nullif(current_setting('app.user_sub', true), '');
  v_artist text;
  v_saved integer;
BEGIN
  PERFORM public.soundboard_research_claim(p_run, p_token);
  -- Only the live grant the reports were read through: a disconnect, a revocation or a reconnect
  -- since then refuses the save, and a disconnect waiting on this lock deletes what it wrote.
  PERFORM 1 FROM public.connections n
    WHERE n.uid = v_sub AND n.status = 'connected' AND n.updated_at = p_grant_at
      AND n.scopes @> '{https://www.googleapis.com/auth/yt-analytics.readonly}'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YouTube analytics not shared' USING ERRCODE = '28000';
  END IF;
  v_artist := public.soundboard_run_artist(p_run);
  DELETE FROM public.artist_outcomes o
    WHERE o.artist_id = v_artist AND o.video_id IN (SELECT r->>'videoId' FROM jsonb_array_elements(p_rows) r);
  INSERT INTO public.artist_outcomes (artist_id, video_id, retrieved_at, published_at, requested_start,
      requested_end, coverage, metrics, live, differs_from_approved)
    SELECT v_artist, r->>'videoId', now(), (r->>'publishedAt')::timestamptz, (r->>'requestedStart')::date,
      (r->>'requestedEnd')::date, r->>'coverage', r->'metrics', r->'live', (r->>'differsFromApproved')::boolean
    FROM jsonb_array_elements(p_rows) r;
  GET DIAGNOSTICS v_saved = ROW_COUNT;
  RETURN v_saved;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_save_outcomes(text, text, timestamptz, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_save_outcomes(text, text, timestamptz, jsonb) TO soundboard_app;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_reject_peer(p_channel text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_artist text := public.soundboard_caller_artist();
BEGIN
  IF p_channel IS NULL OR p_channel = '' THEN
    RAISE EXCEPTION 'Channel required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.peer_rejections (artist_id, channel_id, retrieved_at) VALUES (v_artist, p_channel, now())
    ON CONFLICT (artist_id, channel_id) DO UPDATE SET retrieved_at = now();
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_reject_peer(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_reject_peer(text) TO soundboard_app;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_refresh_rejections(p_run text, p_token text, p_kept text[], p_gone text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_artist text;
BEGIN
  PERFORM public.soundboard_research_claim(p_run, p_token);
  v_artist := public.soundboard_run_artist(p_run);
  UPDATE public.peer_rejections p SET retrieved_at = now()
    WHERE p.artist_id = v_artist AND p.channel_id = ANY (p_kept);
  DELETE FROM public.peer_rejections p WHERE p.artist_id = v_artist AND p.channel_id = ANY (p_gone);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_refresh_rejections(text, text, text[], text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_refresh_rejections(text, text, text[], text[]) TO soundboard_app;
--> statement-breakpoint
-- 005's guides_update needs a fresh proposed_at, so the sliders on an older approved row save here.
CREATE FUNCTION public.soundboard_save_influence(p_influence jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_artist text := public.soundboard_caller_artist();
  v_saved integer;
BEGIN
  UPDATE public.artist_guides g SET influence = p_influence
    WHERE g.artist_id = v_artist AND g.kind = 'brand' AND g.status = 'approved';
  GET DIAGNOSTICS v_saved = ROW_COUNT;
  RETURN v_saved;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_save_influence(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_save_influence(jsonb) TO soundboard_app;
--> statement-breakpoint
-- Sharing ends (disconnect, revocation, a reconnect without the scope or to another channel):
-- the artist's analytics results go with it.
CREATE FUNCTION public.soundboard_forget_outcomes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_scope text[] := '{https://www.googleapis.com/auth/yt-analytics.readonly}';
BEGIN
  IF OLD.status = 'connected' AND OLD.scopes @> v_scope AND (TG_OP = 'DELETE'
      OR NEW.status <> 'connected' OR NOT NEW.scopes @> v_scope
      OR NEW.channel_id IS DISTINCT FROM OLD.channel_id) THEN
    DELETE FROM public.artist_outcomes o USING public.users u
      WHERE u.uid = OLD.uid AND o.artist_id = u.artist_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_forget_outcomes() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER connections_forget_outcomes AFTER DELETE OR UPDATE OF status, scopes, updated_at
  ON public.connections FOR EACH ROW EXECUTE FUNCTION public.soundboard_forget_outcomes();
