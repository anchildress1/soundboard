CREATE TABLE "artist_guides" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "artist_guides_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"artist_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"body" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"grant_at" timestamp with time zone,
	CONSTRAINT "artist_guides_slot" UNIQUE("artist_id","kind","status"),
	CONSTRAINT "artist_guides_kind_check" CHECK ("artist_guides"."kind" in ('voice', 'brand')),
	CONSTRAINT "artist_guides_status_check" CHECK ("artist_guides"."status" in ('proposed', 'approved')),
	CONSTRAINT "artist_guides_approved_check" CHECK (("artist_guides"."status" = 'approved') = ("artist_guides"."approved_at" is not null) and ("artist_guides"."status" = 'proposed' or "artist_guides"."grant_at" is null)),
	CONSTRAINT "artist_guides_sources_check" CHECK (jsonb_typeof("artist_guides"."sources") is not distinct from 'object' and case "artist_guides"."status"
          when 'proposed' then "artist_guides"."sources" - array['uploads','drafts','edits','approvals','thin'] = '{}'::jsonb
            and jsonb_typeof("artist_guides"."sources"->'uploads') is not distinct from 'array' and jsonb_typeof("artist_guides"."sources"->'drafts') is not distinct from 'array'
            and jsonb_typeof("artist_guides"."sources"->'edits') is not distinct from 'number' and jsonb_typeof("artist_guides"."sources"->'approvals') is not distinct from 'number' and jsonb_typeof("artist_guides"."sources"->'thin') is not distinct from 'boolean'
          else "artist_guides"."sources" - array['uploads','drafts','edits','approvals','carriedOver'] = '{}'::jsonb
            and jsonb_typeof("artist_guides"."sources"->'uploads') is not distinct from 'number' and jsonb_typeof("artist_guides"."sources"->'drafts') is not distinct from 'number'
            and jsonb_typeof("artist_guides"."sources"->'edits') is not distinct from 'number' and jsonb_typeof("artist_guides"."sources"->'approvals') is not distinct from 'number' and jsonb_typeof("artist_guides"."sources"->'carriedOver') is not distinct from 'boolean'
          end)
);
--> statement-breakpoint
ALTER TABLE "artist_guides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "guide_claims" (
	"artist_id" text NOT NULL,
	"kind" text NOT NULL,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"claim_until" timestamp with time zone,
	"limit_until" timestamp with time zone,
	"grant_at" timestamp with time zone,
	CONSTRAINT "guide_claims_artist_id_kind_pk" PRIMARY KEY("artist_id","kind"),
	CONSTRAINT "guide_claims_kind_check" CHECK ("guide_claims"."kind" in ('voice', 'brand'))
);
--> statement-breakpoint
ALTER TABLE "guide_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artist_memory" DROP CONSTRAINT "artist_memory_kind_check";--> statement-breakpoint
ALTER TABLE "artist_guides" ADD CONSTRAINT "artist_guides_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide_claims" ADD CONSTRAINT "guide_claims_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artist_guides_expiry_idx" ON "artist_guides" USING btree ("proposed_at") WHERE "artist_guides"."status" = 'proposed';--> statement-breakpoint
DO $$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO public.artist_guides (artist_id, kind, status, body, sources, proposed_at, approved_at)
  SELECT id, 'voice', 'approved', '{"rules": ["Short, plain, literal.", "At most one sentence about the song, said straight, from artistNotes or what the windows show. Never claim what the lyrics say.", "Album placement as a plain statement (\"<song> is track 3 on the album <album>.\") only when notes or facts give it.", "Never write placeholders, brackets, or notes about missing information.", "Dry, self-mocking humor: offhand labels for the video, or doubt about the genre said out loud, about this song.", "At most one aside like \"hehe\" or \"Har! Har!\", inside a sentence, never on its own line. At most one word in caps.", "Quoted phrases here show his style. Never copy them word for word, except the credit line.", "No marketing copy: no \"explores\", \"journey\", \"sonic\", \"soundscape\", \"for fans of\", no calls to like or subscribe, no emoji.", "His credit line in his own wording, like \"Written, performed, recorded, hacked and slashed by\", with the credited name exactly as in recentUploads."]}'::jsonb,
    '{"uploads":0,"drafts":0,"edits":0,"approvals":0,"carriedOver":true}'::jsonb, now(), now()
  FROM public.artists WHERE curated;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> 1 THEN
    RAISE EXCEPTION 'Expected one curated artist';
  END IF;
END;
$$;
--> statement-breakpoint
INSERT INTO public.artist_guides (artist_id, kind, status, body, sources, proposed_at, approved_at)
SELECT artist_id, 'brand', 'approved',
  jsonb_build_object('statement', data->'statement', 'keep', data->'keep', 'fix', data->'fix', 'drop', data->'drop'),
  jsonb_build_object('uploads', coalesce((data->>'uploadCount')::int, 0), 'drafts', 0, 'edits', 0,
    'approvals', 0, 'carriedOver', true),
  coalesce(to_timestamp((data->>'createdAt')::bigint / 1000.0), now()),
  coalesce(to_timestamp((data->>'approvedAt')::bigint / 1000.0), to_timestamp((data->>'createdAt')::bigint / 1000.0), now())
FROM public.artist_memory WHERE kind = 'brand' AND key = 'approved'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM public.artist_memory WHERE kind = 'brand';
--> statement-breakpoint
ALTER TABLE "artists" DROP COLUMN "curated";--> statement-breakpoint
ALTER TABLE "artist_memory" ADD CONSTRAINT "artist_memory_kind_check" CHECK ("artist_memory"."kind" in ('fact', 'feedback', 'publish') and ("artist_memory"."key" is null) = ("artist_memory"."kind" = 'feedback'));--> statement-breakpoint
CREATE POLICY "guides_read" ON "artist_guides" AS PERMISSIVE FOR SELECT TO "soundboard_app" USING (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "artist_guides"."artist_id") and ("artist_guides"."status" = 'approved' or "artist_guides"."proposed_at" > now() - interval '29 days'));--> statement-breakpoint
CREATE POLICY "guides_insert" ON "artist_guides" AS PERMISSIVE FOR INSERT TO "soundboard_app" WITH CHECK (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "artist_guides"."artist_id") and "artist_guides"."status" = 'approved' and "artist_guides"."proposed_at" <= now() and "artist_guides"."proposed_at" > now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "guides_update" ON "artist_guides" AS PERMISSIVE FOR UPDATE TO "soundboard_app" USING (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "artist_guides"."artist_id") and ("artist_guides"."status" = 'approved' or "artist_guides"."proposed_at" > now() - interval '29 days')) WITH CHECK (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "artist_guides"."artist_id") and "artist_guides"."status" = 'approved' and "artist_guides"."proposed_at" <= now() and "artist_guides"."proposed_at" > now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "guides_delete" ON "artist_guides" AS PERMISSIVE FOR DELETE TO "soundboard_app" USING (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "artist_guides"."artist_id") and "artist_guides"."status" = 'proposed');--> statement-breakpoint
CREATE POLICY "guides_cleanup_read" ON "artist_guides" AS PERMISSIVE FOR SELECT TO "soundboard_cleanup" USING ("artist_guides"."status" = 'proposed' and "artist_guides"."proposed_at" <= now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "guides_cleanup_delete" ON "artist_guides" AS PERMISSIVE FOR DELETE TO "soundboard_cleanup" USING ("artist_guides"."status" = 'proposed' and "artist_guides"."proposed_at" <= now() - interval '29 days');--> statement-breakpoint
CREATE POLICY "claims_own" ON "guide_claims" AS PERMISSIVE FOR ALL TO "soundboard_app" USING (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "guide_claims"."artist_id")) WITH CHECK (exists (select 1 from public.users u where u.uid = nullif(current_setting('app.user_sub', true), '') and u.active and u.artist_id = "guide_claims"."artist_id"));
--> statement-breakpoint
ALTER TABLE artist_guides FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE guide_claims FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON artist_guides, guide_claims FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (body, sources, proposed_at, approved_at), DELETE ON artist_guides TO soundboard_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE artist_guides_id_seq TO soundboard_app;
--> statement-breakpoint
GRANT SELECT (id, status, proposed_at), DELETE ON artist_guides TO soundboard_cleanup;
--> statement-breakpoint
GRANT SELECT, UPDATE (claim_token, claim_until, limit_until) ON guide_claims TO soundboard_app;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_claim_proposal(p_kind text, p_token text)
RETURNS SETOF public.guide_claims LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_sub text := nullif(current_setting('app.user_sub', true), '');
  v_artist text;
BEGIN
  SELECT u.artist_id INTO v_artist FROM public.users u
    WHERE u.uid = v_sub AND u.active AND u.artist_id IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artist profile required' USING ERRCODE = '42501';
  END IF;
  IF p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'Claim token required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.guide_claims (artist_id, kind) VALUES (v_artist, p_kind) ON CONFLICT DO NOTHING;
  -- The claim time and the connection generation come from the database, never the app.
  RETURN QUERY UPDATE public.guide_claims c
    SET claim_token = p_token, claimed_at = now(), claim_until = now() + interval '3 minutes',
      grant_at = (SELECT n.updated_at FROM public.connections n
        WHERE n.uid = v_sub AND n.status = 'connected')
    WHERE c.artist_id = v_artist AND c.kind = p_kind
      AND (c.claim_until IS NULL OR c.claim_until <= now())
      AND (c.limit_until IS NULL OR c.limit_until <= now())
    RETURNING c.*;
  IF NOT FOUND THEN
    RETURN QUERY SELECT c.* FROM public.guide_claims c WHERE c.artist_id = v_artist AND c.kind = p_kind;
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_claim_proposal(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_claim_proposal(text, text) TO soundboard_app;
--> statement-breakpoint
CREATE FUNCTION public.soundboard_save_proposal(p_kind text, p_body jsonb, p_sources jsonb, p_claim_token text)
RETURNS SETOF public.artist_guides LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_sub text := nullif(current_setting('app.user_sub', true), '');
  v_artist text;
  v_claimed timestamptz;
  v_grant timestamptz;
BEGIN
  SELECT u.artist_id INTO v_artist FROM public.users u
    WHERE u.uid = v_sub AND u.active AND u.artist_id IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artist profile required' USING ERRCODE = '42501';
  END IF;
  -- Locks the slot, so saves for one artist and kind serialize. A claim time outside the last
  -- 3 minutes is refused whatever claim_until says, so no proposal outlives its expiry.
  SELECT c.claimed_at, c.grant_at INTO v_claimed, v_grant FROM public.guide_claims c
    WHERE c.artist_id = v_artist AND c.kind = p_kind AND c.claim_token = p_claim_token
      AND c.claim_until > now() AND c.claimed_at <= now() AND c.claimed_at > now() - interval '3 minutes'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal claim lost' USING ERRCODE = '55000';
  END IF;
  -- A claim made while connected saves only on the grant it saw, even from edits alone, so a
  -- disconnect or reconnect since then refuses it and no proposal outlives its disconnect.
  IF v_grant IS NOT NULL THEN
    PERFORM 1 FROM public.connections n
      WHERE n.uid = v_sub AND n.status = 'connected' AND n.updated_at = v_grant FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'YouTube disconnected' USING ERRCODE = '28000';
    END IF;
  ELSIF coalesce(jsonb_array_length(p_sources->'uploads'), 0) + coalesce(jsonb_array_length(p_sources->'drafts'), 0) > 0 THEN
    RAISE EXCEPTION 'YouTube disconnected' USING ERRCODE = '28000';
  END IF;
  DELETE FROM public.artist_guides g WHERE g.artist_id = v_artist AND g.kind = p_kind AND g.status = 'proposed';
  UPDATE public.guide_claims c SET claim_token = NULL, claim_until = NULL
    WHERE c.artist_id = v_artist AND c.kind = p_kind;
  RETURN QUERY INSERT INTO public.artist_guides (artist_id, kind, status, body, sources, proposed_at, grant_at)
    VALUES (v_artist, p_kind, 'proposed', p_body, p_sources, v_claimed, v_grant) RETURNING *;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.soundboard_save_proposal(text, jsonb, jsonb, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.soundboard_save_proposal(text, jsonb, jsonb, text) TO soundboard_app;
