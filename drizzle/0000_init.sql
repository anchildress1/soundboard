CREATE TABLE "artist_memory" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "artist_memory_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"artist_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"data" jsonb NOT NULL,
	CONSTRAINT "artist_memory_key" UNIQUE("artist_id","kind","key"),
	CONSTRAINT "artist_memory_kind_check" CHECK ("artist_memory"."kind" in ('fact', 'feedback', 'publish', 'brand') and ("artist_memory"."key" is null) = ("artist_memory"."kind" = 'feedback'))
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"uid" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"channel_id" text,
	"channel_title" text,
	"scopes" text[] NOT NULL,
	"token_ciphertext" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connections_status_check" CHECK ("connections"."status" in ('connected', 'missing_scopes', 'no_channel', 'revoked')),
	CONSTRAINT "connections_shape_check" CHECK (("connections"."status" = 'connected') = ("connections"."token_ciphertext" is not null) and ("connections"."status" <> 'connected' or "connections"."channel_id" is not null))
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
	"picks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chunks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feedback" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_uid_users_uid_fk" FOREIGN KEY ("owner_uid") REFERENCES "public"."users"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_id_jobs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invite_email_invites_email_fk" FOREIGN KEY ("invite_email") REFERENCES "public"."invites"("email") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_owner_list_idx" ON "jobs" USING btree ("owner_uid","created_at" DESC NULLS LAST) WHERE "jobs"."parent_id" is null;