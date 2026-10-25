CREATE TABLE "artists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"bandcamp_url" text,
	"contact_line" text,
	"curated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artists_name_check" CHECK ("artists"."name" = btrim("artists"."name") and char_length("artists"."name") between 1 and 100 and "artists"."name" !~ '[<>,]' and "artists"."name" !~ '^#'),
	CONSTRAINT "artists_bandcamp_check" CHECK ("artists"."bandcamp_url" is null or "artists"."bandcamp_url" ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\.bandcamp\.com$'),
	CONSTRAINT "artists_contact_check" CHECK ("artists"."contact_line" is null or ("artists"."contact_line" = btrim("artists"."contact_line") and char_length("artists"."contact_line") between 1 and 200 and "artists"."contact_line" !~ '[<>#]'))
);
--> statement-breakpoint
ALTER TABLE "artists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO artists (id, name, bandcamp_url, contact_line, curated)
VALUES ('flr', 'Flies Like Robots', 'https://flieslikerobots.bandcamp.com', 'Contact at flieslikerobots@gmail.com.', true);
--> statement-breakpoint
INSERT INTO artist_memory (artist_id, kind, key, data) VALUES
  ('flr', 'fact', 'home', '{"key":"home","value":"Virginia","kind":"FACT","public":true}'::jsonb),
  ('flr', 'fact', 'mr-kill', '{"key":"mr-kill","value":"Connected to the artist Mr. Kill","kind":"INFERENCE","public":false}'::jsonb)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM artist_memory WHERE artist_id = 'flr' AND kind = 'fact' AND key = 'artist-name';
--> statement-breakpoint
UPDATE jobs SET picks = (
  SELECT jsonb_agg(
    e.pick || jsonb_build_object('artistName', CASE WHEN jobs.artist_id = 'flr' THEN 'Flies Like Robots' END)
    ORDER BY e.ord)
  FROM jsonb_array_elements(jobs.picks) WITH ORDINALITY AS e(pick, ord)
) WHERE jsonb_array_length(picks) > 0;
--> statement-breakpoint
UPDATE artist_memory
SET data = (data - 'basedOn') || jsonb_build_object('uploadCount', jsonb_array_length(data->'basedOn'))
WHERE kind = 'brand' AND data ? 'basedOn';
--> statement-breakpoint
ALTER TABLE "artist_memory" ADD CONSTRAINT "artist_memory_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_artist_id_unique" UNIQUE("artist_id");--> statement-breakpoint
CREATE POLICY "artists_owner_read" ON "artists" AS PERMISSIVE FOR SELECT TO "soundboard_app" USING ("artists"."id" = (select u.artist_id from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active));--> statement-breakpoint
CREATE POLICY "artists_owner_update" ON "artists" AS PERMISSIVE FOR UPDATE TO "soundboard_app" USING ("artists"."id" = (select u.artist_id from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active)) WITH CHECK ("artists"."id" = (select u.artist_id from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active));--> statement-breakpoint
ALTER POLICY "jobs_insert" ON "jobs" TO soundboard_app WITH CHECK ("jobs"."owner_uid" = nullif(current_setting('app.user_sub', true), '') and exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active) and (("jobs"."parent_id" is null and "jobs"."artist_id" is not null and "jobs"."artist_id" = (select u.artist_id from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active)) or public.soundboard_owns_job("jobs"."parent_id", "jobs"."artist_id")));
--> statement-breakpoint
ALTER TABLE artists FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON artists FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, UPDATE (name, bandcamp_url, contact_line, updated_at) ON artists TO soundboard_app;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_create_artist(p_name text, p_bandcamp text, p_contact text)
RETURNS SETOF public.artists LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_sub text := nullif(current_setting('app.user_sub', true), '');
  v_linked text;
  v_artist public.artists;
BEGIN
  SELECT u.artist_id INTO v_linked FROM public.users u WHERE u.uid = v_sub AND u.active FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verified identity required' USING ERRCODE = '42501';
  END IF;
  IF v_linked IS NOT NULL THEN
    RAISE EXCEPTION 'Artist profile exists' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.artists (id, name, bandcamp_url, contact_line)
    VALUES (gen_random_uuid()::text, p_name, p_bandcamp, p_contact)
    RETURNING * INTO v_artist;
  UPDATE public.users u SET artist_id = v_artist.id WHERE u.uid = v_sub;
  RETURN NEXT v_artist;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_create_artist(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_create_artist(text, text, text) TO soundboard_app;
