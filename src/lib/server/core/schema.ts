import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
// Relative, not $lib: drizzle-kit loads this file outside Vite's aliases.
import { JOB_STATES } from '../../types';
import type { AudienceEvidence } from '$lib/server/pipeline/hashtags';

const at = (name: string) => timestamp(name, { withTimezone: true });
const quotedStates = JOB_STATES.map((state) => `'${state}'`).join(', ');

/**
 * The allowlist and the accounts in one table: add a lowercased email by hand; its first Google
 * sign-in binds `uid`. `active = false` signs the account out on its next request.
 */
export const users = pgTable('users', {
  email: text('email').primaryKey(),
  uid: text('uid').unique(),
  artistId: text('artist_id'),
  active: boolean('active').notNull().default(true),
  createdAt: at('created_at').notNull().defaultNow(),
});

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
);

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid),
    artistId: text('artist_id'),
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
    check('jobs_state_check', sql`${t.state} in (${sql.raw(quotedStates)})`),
    check(
      'jobs_research_external',
      sql`not (${t.data} ? 'audience') and not (${t.data} ? 'hashtagCandidates')`,
    ),
    index('jobs_owner_list_idx')
      .on(t.ownerUid, t.createdAt.desc())
      .where(sql`${t.parentId} is null`),
  ],
);

export const jobAudience = pgTable(
  'job_audience',
  {
    jobId: text('job_id')
      .primaryKey()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    retrievedAt: at('retrieved_at').notNull(),
    evidence: jsonb('evidence').$type<AudienceEvidence>().notNull(),
  },
  (t) => [index('job_audience_retrieved_idx').on(t.retrievedAt)],
);

/**
 * Everything kept per artist. Facts, publishes and brand slots are keyed (fact key, video ID,
 * `proposal`/`approved`); feedback rows have no key and read newest-first by `id`.
 */
export const artistMemory = pgTable(
  'artist_memory',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    artistId: text('artist_id').notNull(),
    kind: text('kind', { enum: ['fact', 'feedback', 'publish', 'brand'] }).notNull(),
    key: text('key'),
    data: jsonb('data').notNull(),
  },
  (t) => [
    unique('artist_memory_key').on(t.artistId, t.kind, t.key),
    check(
      'artist_memory_kind_check',
      sql`${t.kind} in ('fact', 'feedback', 'publish', 'brand') and (${t.key} is null) = (${t.kind} = 'feedback')`,
    ),
  ],
);
