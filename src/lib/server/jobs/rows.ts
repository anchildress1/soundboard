// Maps jobs between their in-app shape and their row. Kept apart from jobs.ts, which needs the
// database client: the E2E build's fake client seeds fixture rows through these.
import { sql } from 'drizzle-orm';
import { jobs } from '$lib/server/core/schema';
import type { JobDoc } from './jobs';

type Row = typeof jobs.$inferSelect;

const toDate = (ms: number | null) => (ms === null ? null : new Date(ms));
const toMs = (date: Date | null) => (date === null ? null : date.getTime());

export function fromRow(row: Row): JobDoc {
  return {
    ...(row.data as JobData),
    id: row.id,
    ownerUid: row.ownerUid,
    artistId: row.artistId,
    parentId: row.parentId,
    state: row.state,
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

// Identity and lineage are fixed at insert; the destination and `uploadStartedAt` change only
// through their own guarded statements, and nothing updates `finalChunkAt`.
const GUARDED = [
  'id',
  'ownerUid',
  'createdAt',
  'artistId',
  'parentId',
  'destination',
  'uploadStartedAt',
  'finalChunkAt',
] as const;
const guarded = new Set<string>(GUARDED);
type JobData = Omit<JobDoc, (typeof GUARDED)[number] | 'state' | 'videoId'>;

/** What a step or action may change on a job; `jobSet` drops the guarded fields at runtime too. */
export type JobPatch = Partial<Omit<JobDoc, (typeof GUARDED)[number] | 'updatedAt'>>;

/**
 * A patch as an UPDATE's SET: column fields directly, everything else merged into `data` in the
 * same statement, so no read-modify-write races another writer. Undefined fields and guarded ones
 * a widened patch carries are left alone, and a saved `videoId` is never replaced or cleared.
 */
export function jobSet(patch: JobPatch) {
  const { state, videoId, ...rest } = patch;
  const data = Object.fromEntries(Object.entries(rest).filter(([key]) => !guarded.has(key)));
  return {
    state,
    videoId: videoId === undefined ? undefined : sql`coalesce(${jobs.videoId}, ${videoId})`,
    data: sql`${jobs.data} || ${JSON.stringify({ ...data, updatedAt: Date.now() })}::jsonb`,
  };
}
