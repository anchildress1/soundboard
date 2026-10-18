// Maps jobs between their in-app shape and their row. Kept apart from jobs.ts, which needs the
// database client: the E2E build's fake client seeds fixture rows through these.
import { sql } from 'drizzle-orm';
import type { JobState } from '$lib/types';
import { jobs } from '$lib/server/core/schema';
import type { JobDoc } from './jobs';

type Row = typeof jobs.$inferSelect;
type JobData = Omit<
  JobDoc,
  | 'id'
  | 'ownerUid'
  | 'artistId'
  | 'parentId'
  | 'state'
  | 'createdAt'
  | 'destination'
  | 'uploadStartedAt'
  | 'finalChunkAt'
  | 'videoId'
>;

const toDate = (ms: number | null) => (ms === null ? null : new Date(ms));
const toMs = (date: Date | null) => (date === null ? null : date.getTime());

export function fromRow(row: Row): JobDoc {
  return {
    ...(row.data as JobData),
    id: row.id,
    ownerUid: row.ownerUid,
    artistId: row.artistId,
    parentId: row.parentId,
    state: row.state as JobState,
    createdAt: row.createdAt.getTime(),
    destination: row.destinationChannelId
      ? { channelId: row.destinationChannelId, channelTitle: row.destinationChannelTitle }
      : null,
    uploadStartedAt: toMs(row.uploadStartedAt),
    finalChunkAt: toMs(row.finalChunkAt),
    videoId: row.videoId,
  };
}

/** The `jobs` row for a whole job: filtered and locked fields as columns, the rest as `data`. */
export function jobRow(doc: JobDoc): typeof jobs.$inferInsert {
  const {
    id,
    ownerUid,
    artistId,
    parentId,
    state,
    createdAt,
    destination,
    uploadStartedAt,
    finalChunkAt,
    videoId,
    ...data
  } = doc;
  return {
    id,
    ownerUid,
    artistId,
    parentId,
    state,
    createdAt: new Date(createdAt),
    destinationChannelId: destination?.channelId ?? null,
    destinationChannelTitle: destination?.channelTitle ?? null,
    uploadStartedAt: toDate(uploadStartedAt),
    finalChunkAt: toDate(finalChunkAt),
    videoId,
    data,
  };
}

/**
 * A patch as an UPDATE's SET: column fields directly, everything else merged into `data` in the
 * same statement, so no read-modify-write races another writer. Undefined fields are left alone.
 */
export function jobSet(patch: Partial<Omit<JobDoc, 'id' | 'ownerUid' | 'createdAt'>>) {
  const {
    artistId,
    parentId,
    state,
    destination,
    uploadStartedAt,
    finalChunkAt,
    videoId,
    ...data
  } = patch;
  return {
    artistId,
    parentId,
    state,
    ...(destination === undefined
      ? {}
      : {
          destinationChannelId: destination?.channelId ?? null,
          destinationChannelTitle: destination?.channelTitle ?? null,
        }),
    uploadStartedAt: uploadStartedAt === undefined ? undefined : toDate(uploadStartedAt),
    finalChunkAt: finalChunkAt === undefined ? undefined : toDate(finalChunkAt),
    videoId,
    data: sql`${jobs.data} || ${JSON.stringify({ ...data, updatedAt: Date.now() })}::jsonb`,
  };
}
