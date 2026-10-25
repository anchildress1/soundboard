CREATE ROLE soundboard_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
CREATE ROLE soundboard_cleanup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_owns_job(p_job text, p_artist text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.jobs j JOIN public.users u ON u.uid = j.owner_uid
    WHERE j.id = p_job AND j.artist_id IS NOT DISTINCT FROM p_artist
      AND u.active AND u.uid = nullif(current_setting('app.user_sub', true), ''));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_owns_job(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_owns_job(text, text) TO soundboard_app;
--> statement-breakpoint
ALTER TABLE "artist_memory" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_audience" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER VIEW "public"."job_audience_fresh" SET (security_invoker = true);
--> statement-breakpoint
CREATE POLICY "memory_artist" ON "artist_memory" AS PERMISSIVE FOR ALL TO "soundboard_app" USING (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "artist_memory"."artist_id")) WITH CHECK (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "artist_memory"."artist_id"));
--> statement-breakpoint
CREATE POLICY "connections_owner" ON "connections" AS PERMISSIVE FOR ALL TO "soundboard_app" USING ("connections"."uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active)) WITH CHECK ("connections"."uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active));
--> statement-breakpoint
CREATE POLICY "audience_read" ON "job_audience" AS PERMISSIVE FOR SELECT TO "soundboard_app" USING ("job_audience"."retrieved_at" > now() - interval '30 days' and exists (select 1 from public.jobs j where j.id = "job_audience"."job_id" and j.owner_uid = nullif(current_setting('app.user_sub', true), '')));
--> statement-breakpoint
CREATE POLICY "audience_cleanup_read" ON "job_audience" AS PERMISSIVE FOR SELECT TO "soundboard_cleanup" USING ("job_audience"."retrieved_at" <= now() - interval '30 days');
--> statement-breakpoint
CREATE POLICY "audience_cleanup_delete" ON "job_audience" AS PERMISSIVE FOR DELETE TO "soundboard_cleanup" USING ("job_audience"."retrieved_at" <= now() - interval '30 days');
--> statement-breakpoint
CREATE POLICY "jobs_read" ON "jobs" AS PERMISSIVE FOR SELECT TO "soundboard_app" USING ("jobs"."owner_uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active));
--> statement-breakpoint
CREATE POLICY "jobs_insert" ON "jobs" AS PERMISSIVE FOR INSERT TO "soundboard_app" WITH CHECK ("jobs"."owner_uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active) and (("jobs"."parent_id" is null and ("jobs"."artist_id" is null or "jobs"."artist_id" = (select u.artist_id from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '')))) or public.soundboard_owns_job("jobs"."parent_id", "jobs"."artist_id")));
--> statement-breakpoint
CREATE POLICY "jobs_update" ON "jobs" AS PERMISSIVE FOR UPDATE TO "soundboard_app" USING ("jobs"."owner_uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active)) WITH CHECK ("jobs"."owner_uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active));
--> statement-breakpoint
CREATE POLICY "jobs_delete" ON "jobs" AS PERMISSIVE FOR DELETE TO "soundboard_app" USING ("jobs"."owner_uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active));
--> statement-breakpoint
CREATE POLICY "users_self" ON "users" AS PERMISSIVE FOR SELECT TO "soundboard_app" USING ("users"."uid" = nullif(current_setting('app.user_sub', true), '') and "users"."active");
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_audience FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE artist_memory FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON users, connections, jobs, job_audience, artist_memory, job_audience_fresh FROM PUBLIC;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO soundboard_app, soundboard_cleanup;
--> statement-breakpoint
GRANT SELECT ON users, connections, jobs, job_audience, job_audience_fresh, artist_memory TO soundboard_app;
--> statement-breakpoint
GRANT INSERT, DELETE ON connections, jobs, artist_memory TO soundboard_app;
--> statement-breakpoint
GRANT UPDATE (status, channel_id, channel_title, scopes, token_ciphertext, updated_at) ON connections TO soundboard_app;
--> statement-breakpoint
GRANT UPDATE (state, claim_until, claim_token, destination_channel_id, destination_channel_title, upload_started_at, final_chunk_at, video_id, data, picks, chunks, feedback) ON jobs TO soundboard_app;
--> statement-breakpoint
GRANT UPDATE (data) ON artist_memory TO soundboard_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE artist_memory_id_seq TO soundboard_app;
--> statement-breakpoint
GRANT SELECT (job_id, retrieved_at), DELETE ON job_audience TO soundboard_cleanup;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_admit(p_sub text, p_email text, p_open boolean)
RETURNS SETOF public.users LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_sub IS NULL OR p_sub = '' OR p_sub IS DISTINCT FROM nullif(current_setting('app.user_sub', true), '') THEN
    RAISE EXCEPTION 'Verified identity required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.uid = p_sub) THEN
    RETURN QUERY SELECT u.* FROM public.users u WHERE u.uid = p_sub AND u.active;
    RETURN;
  END IF;
  IF p_open THEN
    INSERT INTO public.users (email) VALUES (lower(btrim(p_email))) ON CONFLICT DO NOTHING;
  END IF;
  RETURN QUERY UPDATE public.users u SET uid = p_sub
    WHERE u.email = lower(btrim(p_email)) AND u.active AND (u.uid IS NULL OR u.uid = p_sub)
    RETURNING u.*;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_admit(text, text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_admit(text, text, boolean) TO soundboard_app;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_save_audience(p_job text, p_at timestamptz, p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.jobs j JOIN public.users u ON u.uid = j.owner_uid
    WHERE j.id = p_job AND u.active AND u.uid = nullif(current_setting('app.user_sub', true), '')
  ) AND NOT (current_user = session_user AND current_setting('role') = 'none') THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.job_audience (job_id, retrieved_at, evidence) VALUES (p_job, p_at, p_evidence)
    ON CONFLICT (job_id) DO UPDATE SET retrieved_at = excluded.retrieved_at, evidence = excluded.evidence
    WHERE excluded.retrieved_at > job_audience.retrieved_at;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_save_audience(text, timestamptz, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_save_audience(text, timestamptz, jsonb) TO soundboard_app;
