CREATE TABLE "artist_brand" (
	"artist_id" text NOT NULL,
	"slot" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "artist_brand_artist_id_slot_pk" PRIMARY KEY("artist_id","slot"),
	CONSTRAINT "artist_brand_slot_check" CHECK ("artist_brand"."slot" in ('proposal', 'approved'))
);
--> statement-breakpoint
CREATE TABLE "artist_facts" (
	"artist_id" text NOT NULL,
	"key" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "artist_facts_artist_id_key_pk" PRIMARY KEY("artist_id","key")
);
--> statement-breakpoint
CREATE TABLE "artist_feedback" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "artist_feedback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"artist_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artist_publishes" (
	"artist_id" text NOT NULL,
	"video_id" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "artist_publishes_artist_id_video_id_pk" PRIMARY KEY("artist_id","video_id")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"uid" text NOT NULL,
	"platform" text NOT NULL,
	"status" text NOT NULL,
	"channel_id" text,
	"channel_title" text,
	"scopes" text[] NOT NULL,
	"token_ciphertext" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connections_uid_platform_pk" PRIMARY KEY("uid","platform"),
	CONSTRAINT "connections_platform_check" CHECK ("connections"."platform" = 'youtube'),
	CONSTRAINT "connections_status_check" CHECK ("connections"."status" in ('connected', 'missing_scopes', 'no_channel', 'revoked')),
	CONSTRAINT "connections_token_check" CHECK ("connections"."status" = 'connected' or "connections"."token_ciphertext" is null),
	CONSTRAINT "connections_connected_check" CHECK ("connections"."status" <> 'connected' or ("connections"."token_ciphertext" is not null and "connections"."channel_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"email" text PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"artist_id" text,
	"bound_sub" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_bound_sub_unique" UNIQUE("bound_sub")
);
--> statement-breakpoint
CREATE TABLE "job_chunks" (
	"job_id" text NOT NULL,
	"index" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "job_chunks_job_id_index_pk" PRIMARY KEY("job_id","index")
);
--> statement-breakpoint
CREATE TABLE "job_feedback" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_feedback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"job_id" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_picks" (
	"job_id" text NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "job_picks_job_id_version_pk" PRIMARY KEY("job_id","version")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_uid" text NOT NULL,
	"artist_id" text,
	"parent_id" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"claim_until" timestamp with time zone,
	"claim_token" text,
	"destination_channel_id" text,
	"destination_channel_title" text,
	"upload_started_at" timestamp with time zone,
	"final_chunk_at" timestamp with time zone,
	"video_id" text,
	"data" jsonb NOT NULL,
	CONSTRAINT "jobs_state_check" CHECK ("jobs"."state" in ('AWAITING_UPLOAD', 'PREP', 'ANALYZE', 'PICK', 'HOOK', 'RENDER', 'REVIEW', 'PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED', 'FAILED', 'DISCARDED'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"uid" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"invite_email" text,
	"artist_id" text,
	"access_generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_uid_users_uid_fk" FOREIGN KEY ("uid") REFERENCES "public"."users"("uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_chunks" ADD CONSTRAINT "job_chunks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_picks" ADD CONSTRAINT "job_picks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_uid_users_uid_fk" FOREIGN KEY ("owner_uid") REFERENCES "public"."users"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_id_jobs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invite_email_invites_email_fk" FOREIGN KEY ("invite_email") REFERENCES "public"."invites"("email") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artist_feedback_recent_idx" ON "artist_feedback" USING btree ("artist_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_feedback_job_idx" ON "job_feedback" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_owner_list_idx" ON "jobs" USING btree ("owner_uid","created_at" DESC NULLS LAST) WHERE "jobs"."parent_id" is null;