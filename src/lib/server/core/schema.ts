import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
// Relative, not #lib: drizzle-kit loads this file outside Vite, which maps .js to .ts.
import { JOB_STATES } from '../../types';
import type { AudienceEvidence } from '#lib/server/pipeline/hashtags.js';

const at = (name: string) => timestamp(name, { withTimezone: true });
const quotedStates = JOB_STATES.map((state) => `'${state}'`).join(', ');
export const appRole = pgRole('soundboard_app').existing();
export const cleanupRole = pgRole('soundboard_cleanup').existing();
const principal = sql`nullif(current_setting('app.user_sub', true), '')`;
const activeUser = sql`exists (select 1 from public.users u where u.uid = ${principal} and u.active)`;
const callerArtist = sql`(select u.artist_id from public.users u where u.uid = ${principal} and u.active)`;

/**
 * One artist profile per user, linked by `users.artist_id`. New profiles are created only through
 * `soundboard_create_artist`.
 */
export const artists = pgTable(
  'artists',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    bandcampUrl: text('bandcamp_url'),
    contactLine: text('contact_line'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    pgPolicy('artists_owner_read', {
      for: 'select',
      to: appRole,
      using: sql`${t.id} = ${callerArtist}`,
    }),
    pgPolicy('artists_owner_update', {
      for: 'update',
      to: appRole,
      using: sql`${t.id} = ${callerArtist}`,
      withCheck: sql`${t.id} = ${callerArtist}`,
    }),
    check(
      'artists_name_check',
      sql`${t.name} = btrim(${t.name}) and char_length(${t.name}) between 1 and 100 and ${t.name} !~ '[<>,]' and ${t.name} !~ '^#'`,
    ),
    check(
      'artists_bandcamp_check',
      sql`${t.bandcampUrl} is null or ${t.bandcampUrl} ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\\.bandcamp\\.com$'`,
    ),
    check(
      'artists_contact_check',
      sql`${t.contactLine} is null or (${t.contactLine} = btrim(${t.contactLine}) and char_length(${t.contactLine}) between 1 and 200 and ${t.contactLine} !~ '[<>#]')`,
    ),
  ],
).enableRLS();

/**
 * The allowlist and the accounts in one table: add a lowercased email by hand; its first Google
 * sign-in binds `uid`. `active = false` signs the account out on its next request.
 */
export const users = pgTable(
  'users',
  {
    email: text('email').primaryKey(),
    uid: text('uid').unique(),
    artistId: text('artist_id')
      .unique()
      .references(() => artists.id),
    active: boolean('active').notNull().default(true),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    pgPolicy('users_self', {
      for: 'select',
      to: appRole,
      using: sql`${t.uid} = ${principal} and ${t.active}`,
    }),
  ],
).enableRLS();

// One YouTube connection per user.
export const connections = pgTable(
  'connections',
  {
    uid: text('uid')
      .primaryKey()
      .references(() => users.uid, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['connected', 'missing_scopes', 'no_channel', 'revoked'],
    }).notNull(),
    channelId: text('channel_id'),
    channelTitle: text('channel_title'),
    scopes: text('scopes').array().notNull(),
    tokenCiphertext: text('token_ciphertext'),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    pgPolicy('connections_owner', {
      for: 'all',
      to: appRole,
      using: sql`${t.uid} = ${principal} and ${activeUser}`,
      withCheck: sql`${t.uid} = ${principal} and ${activeUser}`,
    }),
    check(
      'connections_status_check',
      sql`${t.status} in ('connected', 'missing_scopes', 'no_channel', 'revoked')`,
    ),
    // Only a connected row holds a token, and it always names a channel.
    check(
      'connections_shape_check',
      sql`(${t.status} = 'connected') = (${t.tokenCiphertext} is not null) and (${t.status} <> 'connected' or ${t.channelId} is not null)`,
    ),
  ],
).enableRLS();

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid),
    artistId: text('artist_id').references(() => artists.id),
    parentId: text('parent_id').references((): AnyPgColumn => jobs.id),
    state: text('state', { enum: JOB_STATES }).notNull(),
    createdAt: at('created_at').notNull(),
    claimUntil: at('claim_until'),
    claimToken: text('claim_token'),
    destinationChannelId: text('destination_channel_id'),
    destinationChannelTitle: text('destination_channel_title'),
    uploadStartedAt: at('upload_started_at'),
    finalChunkAt: at('final_chunk_at'),
    videoId: text('video_id'),
    data: jsonb('data').notNull(),
    // Pick v is at index v - 1; chunk i at index i.
    picks: jsonb('picks').notNull().default([]),
    chunks: jsonb('chunks').notNull().default([]),
    // Feedback on a job not tied to an artist; artist jobs write it to artist_memory.
    feedback: jsonb('feedback').notNull().default([]),
  },
  (t) => [
    pgPolicy('jobs_read', {
      for: 'select',
      to: appRole,
      using: sql`${t.ownerUid} = ${principal} and ${activeUser}`,
    }),
    pgPolicy('jobs_insert', {
      for: 'insert',
      to: appRole,
      withCheck: sql`${t.ownerUid} = ${principal} and ${activeUser} and ((${t.parentId} is null and ${t.artistId} is not null and ${t.artistId} = ${callerArtist}) or public.soundboard_owns_job(${t.parentId}, ${t.artistId}))`,
    }),
    pgPolicy('jobs_update', {
      for: 'update',
      to: appRole,
      using: sql`${t.ownerUid} = ${principal} and ${activeUser}`,
      withCheck: sql`${t.ownerUid} = ${principal} and ${activeUser}`,
    }),
    pgPolicy('jobs_delete', {
      for: 'delete',
      to: appRole,
      using: sql`${t.ownerUid} = ${principal} and ${activeUser}`,
    }),
    check('jobs_state_check', sql`${t.state} in (${sql.raw(quotedStates)})`),
    check(
      'jobs_research_external',
      sql`not (${t.data} ? 'audience') and not (${t.data} ? 'hashtagCandidates')`,
    ),
    index('jobs_owner_list_idx')
      .on(t.ownerUid, t.createdAt.desc())
      .where(sql`${t.parentId} is null`),
  ],
).enableRLS();

export const jobAudience = pgTable(
  'job_audience',
  {
    jobId: text('job_id')
      .primaryKey()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    retrievedAt: at('retrieved_at').notNull(),
    evidence: jsonb('evidence').$type<AudienceEvidence>().notNull(),
  },
  (t) => [
    index('job_audience_retrieved_idx').on(t.retrievedAt),
    pgPolicy('audience_read', {
      for: 'select',
      to: appRole,
      using: sql`${t.retrievedAt} > now() - interval '30 days' and exists (select 1 from public.jobs j where j.id = ${t.jobId} and j.owner_uid = ${principal})`,
    }),
    pgPolicy('audience_cleanup_read', {
      for: 'select',
      to: cleanupRole,
      using: sql`${t.retrievedAt} <= now() - interval '30 days'`,
    }),
    pgPolicy('audience_cleanup_delete', {
      for: 'delete',
      to: cleanupRole,
      using: sql`${t.retrievedAt} <= now() - interval '30 days'`,
    }),
  ],
).enableRLS();

export const jobAudienceFresh = pgView('job_audience_fresh')
  .with({ securityInvoker: true })
  .as((qb) =>
    qb
      .select()
      .from(jobAudience)
      .where(sql`${jobAudience.retrievedAt} > now() - interval '30 days'`),
  );

/**
 * Everything kept per artist. Facts and publishes are keyed (fact key, video ID); feedback rows have
 * no key and read newest-first by `id`.
 */
export const artistMemory = pgTable(
  'artist_memory',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id),
    kind: text('kind', { enum: ['fact', 'feedback', 'publish'] }).notNull(),
    key: text('key'),
    data: jsonb('data').notNull(),
  },
  (t) => [
    pgPolicy('memory_artist', {
      for: 'all',
      to: appRole,
      using: sql`exists (select 1 from public.users u where u.uid = ${principal} and u.active and u.artist_id = ${t.artistId})`,
      withCheck: sql`exists (select 1 from public.users u where u.uid = ${principal} and u.active and u.artist_id = ${t.artistId})`,
    }),
    unique('artist_memory_key').on(t.artistId, t.kind, t.key),
    check(
      'artist_memory_kind_check',
      sql`${t.kind} in ('fact', 'feedback', 'publish') and (${t.key} is null) = (${t.kind} = 'feedback')`,
    ),
  ],
).enableRLS();

/** The caller is linked to the row's artist; `artistId` must be the policy table's own column. */
const ownArtist = (artistId: AnyPgColumn) =>
  sql`exists (select 1 from public.users u where u.uid = ${principal} and u.active and u.artist_id = ${artistId})`;
const GUIDE_EXPIRY = sql.raw(`interval '29 days'`);

/**
 * Per artist and kind, at most one proposal and one approved version. Proposals list the uploads
 * they read, so they expire 29 days after their claim and only `soundboard_save_proposal` writes
 * them; approved rows hold source counts only.
 */
export const artistGuides = pgTable(
  'artist_guides',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id),
    kind: text('kind', { enum: ['voice', 'brand'] }).notNull(),
    status: text('status', { enum: ['proposed', 'approved'] }).notNull(),
    body: jsonb('body').notNull(),
    sources: jsonb('sources').notNull(),
    proposedAt: at('proposed_at').notNull(),
    approvedAt: at('approved_at'),
    // The connection generation (`connections.updated_at`) the proposal's uploads were read through.
    grantAt: at('grant_at'),
    // The artist's saved slider settings; only on the approved brand row (spec 006).
    influence: jsonb('influence'),
  },
  (t) => {
    const fresh = sql`(${t.status} = 'approved' or ${t.proposedAt} > now() - ${GUIDE_EXPIRY})`;
    const approvedWrite = sql`${ownArtist(t.artistId)} and ${t.status} = 'approved' and ${t.proposedAt} <= now() and ${t.proposedAt} > now() - ${GUIDE_EXPIRY}`;
    const expired = sql`${t.status} = 'proposed' and ${t.proposedAt} <= now() - ${GUIDE_EXPIRY}`;
    const typed = (key: string, type: string) =>
      sql.raw(`jsonb_typeof("artist_guides"."sources"->'${key}') is not distinct from '${type}'`);
    return [
      check('artist_guides_kind_check', sql`${t.kind} in ('voice', 'brand')`),
      check('artist_guides_status_check', sql`${t.status} in ('proposed', 'approved')`),
      check(
        'artist_guides_approved_check',
        sql`(${t.status} = 'approved') = (${t.approvedAt} is not null) and (${t.status} = 'proposed' or ${t.grantAt} is null)`,
      ),
      // Exact keys and types per status; a missing key fails instead of passing as SQL null.
      check(
        'artist_guides_sources_check',
        sql`jsonb_typeof(${t.sources}) is not distinct from 'object' and case ${t.status}
          when 'proposed' then ${t.sources} - array['uploads','drafts','edits','approvals','thin'] = '{}'::jsonb
            and ${typed('uploads', 'array')} and ${typed('drafts', 'array')}
            and ${typed('edits', 'number')} and ${typed('approvals', 'number')} and ${typed('thin', 'boolean')}
          else ${t.sources} - array['uploads','drafts','edits','approvals','carriedOver'] = '{}'::jsonb
            and ${typed('uploads', 'number')} and ${typed('drafts', 'number')}
            and ${typed('edits', 'number')} and ${typed('approvals', 'number')} and ${typed('carriedOver', 'boolean')}
          end`,
      ),
      check(
        'artist_guides_influence_slot_check',
        sql`${t.influence} is null or (${t.kind} = 'brand' and ${t.status} = 'approved')`,
      ),
      check(
        'artist_guides_influence_check',
        sql`${t.influence} is null or public.soundboard_influence_ok(${t.influence})`,
      ),
      unique('artist_guides_slot').on(t.artistId, t.kind, t.status),
      index('artist_guides_expiry_idx')
        .on(t.proposedAt)
        .where(sql`${t.status} = 'proposed'`),
      pgPolicy('guides_read', {
        for: 'select',
        to: appRole,
        using: sql`${ownArtist(t.artistId)} and ${fresh}`,
      }),
      pgPolicy('guides_insert', { for: 'insert', to: appRole, withCheck: approvedWrite }),
      pgPolicy('guides_update', {
        for: 'update',
        to: appRole,
        using: sql`${ownArtist(t.artistId)} and ${fresh}`,
        withCheck: approvedWrite,
      }),
      pgPolicy('guides_delete', {
        for: 'delete',
        to: appRole,
        using: sql`${ownArtist(t.artistId)} and ${t.status} = 'proposed'`,
      }),
      pgPolicy('guides_cleanup_read', { for: 'select', to: cleanupRole, using: expired }),
      pgPolicy('guides_cleanup_delete', { for: 'delete', to: cleanupRole, using: expired }),
    ];
  },
).enableRLS();

/**
 * One proposal claim per artist and kind. Only `soundboard_claim_proposal` sets the claim time and
 * connection generation, so the app can't backdate or forward-date a proposal through it.
 */
export const guideClaims = pgTable(
  'guide_claims',
  {
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id),
    kind: text('kind', { enum: ['voice', 'brand'] }).notNull(),
    claimToken: text('claim_token'),
    claimedAt: at('claimed_at'),
    claimUntil: at('claim_until'),
    limitUntil: at('limit_until'),
    grantAt: at('grant_at'),
  },
  (t) => [
    primaryKey({ columns: [t.artistId, t.kind] }),
    check('guide_claims_kind_check', sql`${t.kind} in ('voice', 'brand')`),
    pgPolicy('claims_own', {
      for: 'all',
      to: appRole,
      using: ownArtist(t.artistId),
      withCheck: ownArtist(t.artistId),
    }),
  ],
).enableRLS();

const RESEARCH_EXPIRY = sql.raw(`interval '29 days'`);
const ANALYTICS_SCOPE_SQL = sql.raw(`'{https://www.googleapis.com/auth/yt-analytics.readonly}'`);
const freshAt = (retrievedAt: AnyPgColumn) => sql`${retrievedAt} > now() - ${RESEARCH_EXPIRY}`;
const expiredAt = (retrievedAt: AnyPgColumn) => sql`${retrievedAt} <= now() - ${RESEARCH_EXPIRY}`;
/** Cleanup may read and delete a row only once it's hidden from the app. */
const cleanupPolicies = (name: string, retrievedAt: AnyPgColumn) => [
  pgPolicy(`${name}_cleanup_read`, {
    for: 'select',
    to: cleanupRole,
    using: expiredAt(retrievedAt),
  }),
  pgPolicy(`${name}_cleanup_delete`, {
    for: 'delete',
    to: cleanupRole,
    using: expiredAt(retrievedAt),
  }),
];

/**
 * One research run per job: its stage, committed cursor and claim. Holds no YouTube data; a new
 * run replaces the row with a new `id`.
 */
export const researchRuns = pgTable(
  'research_runs',
  {
    jobId: text('job_id')
      .primaryKey()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    id: text('id').notNull().unique(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid),
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id),
    stage: text('stage', {
      enum: ['learn', 'discover', 'match', 'releases', 'done', 'failed'],
    }).notNull(),
    seq: integer('seq').notNull().default(0),
    cursor: integer('cursor').notNull().default(0),
    claimToken: text('claim_token'),
    claimUntil: at('claim_until'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    wait: text('wait'),
    error: text('error'),
    limits: text('limits')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    startedAt: at('started_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
    finishedAt: at('finished_at'),
  },
  (t) => [
    check(
      'research_runs_stage_check',
      sql`${t.stage} in ('learn', 'discover', 'match', 'releases', 'done', 'failed')`,
    ),
    pgPolicy('runs_owner', {
      for: 'all',
      to: appRole,
      using: sql`${t.ownerUid} = ${principal} and ${activeUser}`,
      // A run only for the caller's own job, under the caller's own artist.
      withCheck: sql`${t.ownerUid} = ${principal} and exists (select 1 from public.jobs j join public.users u on u.uid = ${principal} where j.id = ${t.jobId} and j.owner_uid = ${principal} and u.active and u.artist_id = ${t.artistId})`,
    }),
  ],
).enableRLS();

/** Peer evidence per run (Non-Authorized Data): hidden at 29 days, written only by its claim. */
export const jobResearch = pgTable(
  'job_research',
  {
    // Not a foreign key: a replaced run keeps its evidence until expiry, so old citations resolve.
    runId: text('run_id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    retrievedAt: at('retrieved_at').notNull(),
    evidence: jsonb('evidence').notNull(),
  },
  (t) => [
    index('job_research_retrieved_idx').on(t.retrievedAt),
    index('job_research_job_idx').on(t.jobId),
    pgPolicy('research_read', {
      for: 'select',
      to: appRole,
      using: sql`${freshAt(t.retrievedAt)} and exists (select 1 from public.jobs j where j.id = ${t.jobId} and j.owner_uid = ${principal}) and ${activeUser}`,
    }),
    ...cleanupPolicies('research', t.retrievedAt),
  ],
).enableRLS();

/** The artist's own results (YouTube Analytics), readable only while analytics is shared. */
export const artistOutcomes = pgTable(
  'artist_outcomes',
  {
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id),
    videoId: text('video_id').notNull(),
    retrievedAt: at('retrieved_at').notNull(),
    publishedAt: at('published_at').notNull(),
    requestedStart: date('requested_start').notNull(),
    requestedEnd: date('requested_end').notNull(),
    coverage: text('coverage', { enum: ['open', 'complete', 'unknown'] }).notNull(),
    metrics: jsonb('metrics').notNull(),
    live: jsonb('live').notNull(),
    differsFromApproved: boolean('differs_from_approved'),
  },
  (t) => [
    primaryKey({ columns: [t.artistId, t.videoId] }),
    check('artist_outcomes_coverage_check', sql`${t.coverage} in ('open', 'complete', 'unknown')`),
    pgPolicy('outcomes_read', {
      for: 'select',
      to: appRole,
      using: sql`${ownArtist(t.artistId)} and ${freshAt(t.retrievedAt)} and exists (select 1 from public.connections c where c.uid = ${principal} and c.status = 'connected' and c.scopes @> ${ANALYTICS_SCOPE_SQL})`,
    }),
    ...cleanupPolicies('outcomes', t.retrievedAt),
  ],
).enableRLS();

/** Channels the artist marked "Not a peer"; refreshed by each discover stage, else hidden at 29 days. */
export const peerRejections = pgTable(
  'peer_rejections',
  {
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id),
    channelId: text('channel_id').notNull(),
    retrievedAt: at('retrieved_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artistId, t.channelId] }),
    pgPolicy('rejections_read', {
      for: 'select',
      to: appRole,
      using: sql`${ownArtist(t.artistId)} and ${freshAt(t.retrievedAt)}`,
    }),
    ...cleanupPolicies('rejections', t.retrievedAt),
  ],
).enableRLS();
