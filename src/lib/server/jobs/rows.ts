// Maps jobs between their in-app shape and their row. Kept apart from jobs.ts, which needs the
// database client: the E2E build's fake client seeds fixture rows through these.
import { sql } from 'drizzle-orm';
import { jobs } from '#lib/server/core/schema.js';
import type { JobDoc } from './jobs';

type Row = typeof jobs.$inferSelect;
const transient = new Set(['audience', 'hashtagCandidates']);

const toDate = (ms: number | null) => (ms === null ? null : new Date(ms));
const toMs = (date: Date | null) => (date === null ? null : date.getTime());

export function fromRow(row: Row): JobDoc {
  const data = row.data as JobData;
  return {
    ...data,
    // Rows written before uploads were resumable have no key.
    videoUpload: data.videoUpload ?? null,
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
    audience: null,
    hashtagCandidates: null,
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
    data: Object.fromEntries(Object.entries(data).filter(([key]) => !transient.has(key))),
  };
}

// Identity and lineage are fixed at insert; the destination and the upload markers change only
// through their own statements, never a step or action patch.
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
type JobData = Omit<
  JobDoc,
  (typeof GUARDED)[number] | 'state' | 'videoId' | 'audience' | 'hashtagCandidates'
>;

/** What a step or action may change on a job; `jobSet` drops the guarded fields at runtime too. */
export type JobPatch = Partial<Omit<JobDoc, (typeof GUARDED)[number] | 'updatedAt'>>;

/**
 * A patch as an UPDATE's SET: column fields directly, everything else merged into `data` in the
 * same statement, so no read-modify-write races another writer. Undefined fields and guarded ones
 * a widened patch carries are left alone, and a saved `videoId` is never replaced or cleared.
 */
export function jobSet(patch: JobPatch) {
  const { state, videoId, ...rest } = patch;
  const data = Object.fromEntries(
    Object.entries(rest).filter(([key]) => !guarded.has(key) && !transient.has(key)),
  );
  return {
    state,
    videoId: videoId === undefined ? undefined : sql`coalesce(${jobs.videoId}, ${videoId})`,
    data: sql`${jobs.data} || ${JSON.stringify({ ...data, updatedAt: Date.now() })}::jsonb`,
  };
}
