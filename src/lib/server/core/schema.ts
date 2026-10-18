import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true });

export const invites = pgTable('invites', {
  email: text('email').primaryKey(),
  active: boolean('active').notNull().default(true),
  artistId: text('artist_id'),
  boundSub: text('bound_sub').unique(),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  uid: text('uid').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  inviteEmail: text('invite_email').references(() => invites.email),
  artistId: text('artist_id'),
  accessGeneration: integer('access_generation').notNull().default(1),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const connections = pgTable(
  'connections',
  {
    uid: text('uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
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
    primaryKey({ columns: [t.uid, t.platform] }),
    check('connections_platform_check', sql`${t.platform} = 'youtube'`),
    check(
      'connections_status_check',
      sql`${t.status} in ('connected', 'missing_scopes', 'no_channel', 'revoked')`,
    ),
    check(
      'connections_token_check',
      sql`${t.status} = 'connected' or ${t.tokenCiphertext} is null`,
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
    state: text('state').notNull(),
    createdAt: at('created_at').notNull(),
    claimUntil: at('claim_until'),
    claimToken: text('claim_token'),
    destinationChannelId: text('destination_channel_id'),
    destinationChannelTitle: text('destination_channel_title'),
    uploadStartedAt: at('upload_started_at'),
    finalChunkAt: at('final_chunk_at'),
    videoId: text('video_id'),
    data: jsonb('data').notNull(),
  },
  (t) => [
    index('jobs_owner_list_idx')
      .on(t.ownerUid, t.createdAt.desc())
      .where(sql`${t.parentId} is null`),
  ],
);

const jobId = () =>
  text('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' });

export const jobPicks = pgTable(
  'job_picks',
  { jobId: jobId(), version: integer('version').notNull(), data: jsonb('data').notNull() },
  (t) => [primaryKey({ columns: [t.jobId, t.version] })],
);

export const jobChunks = pgTable(
  'job_chunks',
  { jobId: jobId(), index: integer('index').notNull(), data: jsonb('data').notNull() },
  (t) => [primaryKey({ columns: [t.jobId, t.index] })],
);

// Feedback rows have no natural key: Firestore stored them under auto IDs.
export const jobFeedback = pgTable(
  'job_feedback',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    jobId: jobId(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('job_feedback_job_idx').on(t.jobId)],
);

export const artistFacts = pgTable(
  'artist_facts',
  {
    artistId: text('artist_id').notNull(),
    key: text('key').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.artistId, t.key] })],
);

export const artistFeedback = pgTable(
  'artist_feedback',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    artistId: text('artist_id').notNull(),
    at: at('at').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('artist_feedback_recent_idx').on(t.artistId, t.at.desc())],
);

export const artistPublishes = pgTable(
  'artist_publishes',
  {
    artistId: text('artist_id').notNull(),
    videoId: text('video_id').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.artistId, t.videoId] })],
);

export const artistBrand = pgTable(
  'artist_brand',
  {
    artistId: text('artist_id').notNull(),
    slot: text('slot', { enum: ['proposal', 'approved'] }).notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artistId, t.slot] }),
    check('artist_brand_slot_check', sql`${t.slot} in ('proposal', 'approved')`),
  ],
);
