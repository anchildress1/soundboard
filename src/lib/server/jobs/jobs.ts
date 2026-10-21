import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Chunk, JobState, Pick, PublicJob } from '$lib/types';
import { db, type Database, type Tx } from '$lib/server/core/db';
import { jobs } from '$lib/server/core/schema';
import type { AudienceEvidence } from '$lib/server/pipeline/hashtags';
import { fromRow, jobRow, jobSet, type JobPatch } from './rows';

/** A step's claim on a job; an aborted request frees the job when it lapses. */
export const CLAIM_TTL_MS = 3 * 60 * 1000;

/** Longest video a job accepts. */
export const MAX_MINUTES = 15;

export type JobDoc = PublicJob & {
  ownerUid: string;
  /** The owner's artist link when the job was created. */
  artistId: string | null;
  object: string;
  contentType: string;
  consecutiveFailures: number;
  trace: { sentryTrace: string; baggage: string } | null;
  upload: { sessionUri: string; total: number } | null;
  /** Version of the recommendation on screen; approve must name it. */
  pickVersion: number | null;
  /** The genre search behind the pick; re-runs reuse it. */
  audience: AudienceEvidence | null;
  verifyAttempts: number;
  /** A Short job's source video object; null on video jobs. */
  sourceObject: string | null;
  /** Set before the first upload-initiation request; nothing clears it. */
  uploadStartedAt: number | null;
  /** Set before sending the chunk that reaches the file size; nothing clears it. */
  finalChunkAt: number | null;
  /** When YouTube's spent daily limit resets; publish steps wait without calling it until then. */
  limitUntil: number | null;
  updatedAt: number;
};

/**
 * Whether the upload session was lost after its final bytes may have gone out, so only the owner
 * can say whether YouTube kept the video. No session means the same here as in the upload step.
 */
export const outcomeUnknown = (job: JobDoc): boolean =>
  job.state === 'PUBLISHING' && job.finalChunkAt !== null && !job.upload && job.videoId === null;

export type NewJob = {
  ownerUid: string;
  artistId: string | null;
  songTitle: string;
  notes: string;
  filename: string;
  contentType: string;
  object: string | null;
  trace: JobDoc['trace'];
};

/** 128 random bits, so job IDs can't be guessed or enumerated. */
export function newJobId(): string {
  return randomBytes(16).toString('base64url');
}

export function newJobDoc(input: NewJob, id: string, now = Date.now()): JobDoc {
  return {
    id,
    state: input.object ? 'PREP' : 'AWAITING_UPLOAD',
    ownerUid: input.ownerUid,
    artistId: input.artistId,
    parentId: null,
    destination: null,
    songTitle: input.songTitle,
    notes: input.notes,
    filename: input.filename,
    contentType: input.contentType,
    object: input.object ?? `uploads/${id}`,
    probe: null,
    measurements: null,
    chunkCount: 0,
    chunkIndex: 0,
    failedState: null,
    error: null,
    uploadProgress: null,
    videoId: null,
    consecutiveFailures: 0,
    trace: input.trace,
    hashtagCandidates: null,
    audience: null,
    upload: null,
    finalFields: null,
    pickVersion: null,
    verifyAttempts: 0,
    shortId: null,
    short: null,
    sourceObject: null,
    uploadStartedAt: null,
    finalChunkAt: null,
    limitUntil: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function createJob(input: NewJob, id = newJobId()): Promise<JobDoc> {
  const doc = newJobDoc(input, id);
  await db().insert(jobs).values(jobRow(doc));
  return doc;
}

export async function getJob(id: string): Promise<JobDoc | null> {
  const [row] = await db().select().from(jobs).where(eq(jobs.id, id));
  return row ? fromRow(row) : null;
}

export type JobListItem = { id: string; songTitle: string; state: JobState; createdAt: number };

/** The user's newest 20 root jobs; Shorts are reached through their video. */
export async function listJobs(uid: string): Promise<JobListItem[]> {
  const rows = await db()
    .select({
      id: jobs.id,
      songTitle: sql<string>`${jobs.data}->>'songTitle'`,
      state: jobs.state,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(and(eq(jobs.ownerUid, uid), isNull(jobs.parentId)))
    .orderBy(desc(jobs.createdAt))
    .limit(20);
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.getTime(),
  }));
}

/**
 * Claims the job for one step with a fresh token and returns the job as the claim left it, so the
 * step never runs on a snapshot another request already moved past. Returns null while another
 * request holds an unexpired claim, so a second tab waits instead of double-running the step.
 */
export async function claimJob(id: string): Promise<{ token: string; job: JobDoc } | null> {
  const token = randomBytes(16).toString('hex');
  const [row] = await db()
    .update(jobs)
    .set({
      claimToken: token,
      claimUntil: sql`now() + ${CLAIM_TTL_MS}::int * interval '1 millisecond'`,
    })
    .where(and(eq(jobs.id, id), or(isNull(jobs.claimUntil), lt(jobs.claimUntil, sql`now()`))))
    .returning();
  return row ? { token, job: fromRow(row) } : null;
}

export type StoredPick = Pick & { skipped: boolean };

type ArrayColumn = typeof jobs.picks | typeof jobs.chunks;

/**
 * Sets `value` at `index` of a jsonb array column, appending when `index` is its length. Throws
 * rather than leave a gap: past the end, jsonb_set would append at the wrong position.
 */
async function putAt(
  tx: Tx,
  jobId: string,
  column: ArrayColumn,
  index: number,
  value: unknown,
): Promise<void> {
  const path = `{${index}}`;
  const written = await tx
    .update(jobs)
    .set({
      [column.name]: sql`jsonb_set(${column}, ${path}::text[], ${JSON.stringify(value)}::jsonb, true)`,
    })
    .where(and(eq(jobs.id, jobId), sql`jsonb_array_length(${column}) >= ${index}`))
    .returning({ id: jobs.id });
  if (written.length === 0) throw new Error(`No ${column.name} slot ${index} on job ${jobId}`);
}

const putPick = (tx: Tx, jobId: string, pick: StoredPick) =>
  putAt(tx, jobId, jobs.picks, pick.version - 1, pick);

const putChunk = (tx: Tx, jobId: string, chunk: Chunk) =>
  putAt(tx, jobId, jobs.chunks, chunk.index, chunk);

const released = { claimToken: null, claimUntil: null };

/**
 * Applies the step's result and drops the claim, only while `token` still holds it. When an action
 * (discard, re-run) moved the job off the state the step started from, only the video ID, upload
 * session, and upload progress land, so the record of what YouTube holds survives; a token whose
 * claim lapsed to someone else writes nothing and leaves the newer claim in place.
 */
export async function releaseJob(
  id: string,
  token: string,
  claimedState: JobState,
  patch: JobPatch = {},
  writes: { pick?: Pick; chunk?: Chunk; alsoWrite?: (tx: Tx) => Promise<void> } = {},
): Promise<boolean> {
  const held = and(eq(jobs.id, id), eq(jobs.claimToken, token));
  return db().transaction(async (tx) => {
    const [kept] = await tx
      .update(jobs)
      .set({ ...jobSet(patch), ...released })
      .where(and(held, eq(jobs.state, claimedState)))
      .returning({ id: jobs.id });
    if (!kept) {
      const { videoId, upload, uploadProgress } = patch;
      await tx
        .update(jobs)
        .set({ ...jobSet({ videoId, upload, uploadProgress }), ...released })
        .where(held);
      return false;
    }
    // Step output lands in the same transaction, so a worker that lost its claim persists nothing.
    if (writes.pick) await putPick(tx, id, { ...writes.pick, skipped: false });
    if (writes.chunk) await putChunk(tx, id, writes.chunk);
    if (writes.alsoWrite) await writes.alsoWrite(tx);
    return true;
  });
}

/** Records when the first upload initiation was about to go out; later calls keep that time. */
export async function markUploadStarted(id: string): Promise<void> {
  await db()
    .update(jobs)
    .set({ uploadStartedAt: sql`coalesce(${jobs.uploadStartedAt}, now())` })
    .where(eq(jobs.id, id));
}

/**
 * Records when the final chunk was first about to be sent; later calls keep the first time.
 * Unconditional on the claim: the marker must exist whenever final bytes may have been sent.
 */
export async function markFinalChunk(id: string): Promise<void> {
  await db()
    .update(jobs)
    .set({ finalChunkAt: sql`coalesce(${jobs.finalChunkAt}, now())` })
    .where(eq(jobs.id, id));
}

/** Moves the job to a new state only if it is still in one of `from`; false when it already moved. */
export async function transitionJob(
  id: string,
  from: readonly JobState[],
  patch: JobPatch,
): Promise<boolean> {
  const moved = await db()
    .update(jobs)
    .set(jobSet(patch))
    .where(and(eq(jobs.id, id), inArray(jobs.state, [...from])))
    .returning({ id: jobs.id });
  return moved.length > 0;
}

export async function listChunks(id: string): Promise<Chunk[]> {
  const [row] = await db().select({ chunks: jobs.chunks }).from(jobs).where(eq(jobs.id, id));
  return (row?.chunks as Chunk[] | undefined) ?? [];
}

/**
 * Marks the pick skipped, queues a new pick, and runs `alsoWrite` (the SKIPPED feedback) in one
 * transaction; false if the job already left REVIEW.
 */
export async function skipAndRepick(
  id: string,
  version: number | null,
  alsoWrite: (tx: Tx) => Promise<void> = async () => {},
): Promise<boolean> {
  return db().transaction(async (tx) => {
    const moved = await tx
      .update(jobs)
      .set(jobSet({ state: 'PICK', consecutiveFailures: 0, error: null }))
      .where(and(eq(jobs.id, id), eq(jobs.state, 'REVIEW')))
      .returning({ id: jobs.id });
    if (moved.length === 0) return false;
    if (version !== null) {
      const path = `{${version - 1},skipped}`;
      await tx
        .update(jobs)
        .set({ picks: sql`jsonb_set(${jobs.picks}, ${path}::text[], 'true')` })
        .where(eq(jobs.id, id));
    }
    await alsoWrite(tx);
    return true;
  });
}

async function readPicks(q: Database | Tx, id: string): Promise<StoredPick[]> {
  const [row] = await q.select({ picks: jobs.picks }).from(jobs).where(eq(jobs.id, id));
  return (row?.picks as StoredPick[] | undefined) ?? [];
}

export async function listPicks(id: string): Promise<StoredPick[]> {
  return readPicks(db(), id);
}

export async function latestPick(id: string): Promise<StoredPick | null> {
  return (await readPicks(db(), id)).at(-1) ?? null;
}

/** The stored pick of one version, read inside the caller's transaction. */
export async function pickIn(tx: Tx, id: string, version: number): Promise<StoredPick | null> {
  return (await readPicks(tx, id))[version - 1] ?? null;
}

/** Reads and row-locks the job inside the caller's transaction, so concurrent writers queue. */
export async function lockJob(tx: Tx, id: string): Promise<JobDoc | null> {
  const [row] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
  return row ? fromRow(row) : null;
}

/** Strips server-only fields before a job reaches the browser. */
export function toPublic(doc: JobDoc): PublicJob {
  return {
    id: doc.id,
    state: doc.state,
    parentId: doc.parentId,
    destination: doc.destination,
    songTitle: doc.songTitle,
    notes: doc.notes,
    filename: doc.filename,
    probe: doc.probe,
    measurements: doc.measurements,
    chunkCount: doc.chunkCount,
    chunkIndex: doc.chunkIndex,
    failedState: doc.failedState,
    error: doc.error,
    uploadProgress: doc.uploadProgress,
    videoId: doc.videoId,
    finalFields: doc.finalFields,
    hashtagCandidates: doc.hashtagCandidates,
    shortId: doc.shortId,
    short: doc.short,
    createdAt: doc.createdAt,
  };
}

/** A step that succeeded: the failure streak and the shown error reset. */
export const ok = (patch: JobPatch): JobPatch => ({
  ...patch,
  consecutiveFailures: 0,
  error: null,
});

export function fail(state: JobState, message: string): JobPatch {
  return { state: 'FAILED', failedState: state, error: message };
}

/** The Short job cut from the video `current`, before its hook is picked. */
function shortDoc(current: JobDoc, id: string): JobDoc {
  const base = newJobDoc(
    {
      ownerUid: current.ownerUid,
      artistId: current.artistId,
      songTitle: current.songTitle,
      notes: current.notes,
      filename: `${current.filename.replace(/\.[^.]+$/, '')} (Short).mp4`,
      contentType: 'video/mp4',
      object: null,
      trace: current.trace,
    },
    id,
  );
  return {
    ...base,
    state: 'HOOK',
    parentId: current.id,
    hashtagCandidates: current.hashtagCandidates,
    audience: current.audience,
    pickVersion: 1,
    sourceObject: current.object,
    short: {
      sourceDurationSec: current.probe?.durationSec ?? 0,
      reframe: 'blur',
      hook: null,
      skipped: [],
      renders: 0,
      modelMs: 0,
    },
  };
}

/** Whether the Short exists and wasn't discarded. */
async function isLive(tx: Tx, id: string): Promise<boolean> {
  const [row] = await tx.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, id));
  return row !== undefined && row.state !== 'DISCARDED';
}

export type ShortStart = { id: string } | { noPick: true } | null;

/**
 * Cuts a Short job from a video job. Everything is read inside the transaction, so an approval that
 * lands first is what the Short starts from: the video's approved fields over its pick on screen
 * become the Short's pick v1. Candidate lists come along so approve holds the same rules, and the
 * trace is shared, so the Short lands in the video's trace. One live Short per video: an existing
 * one that isn't discarded is returned instead. Null when the parent left `states` before the
 * transaction ran.
 */
export async function createShort(
  parent: JobDoc,
  states: readonly JobState[],
  id = newJobId(),
): Promise<ShortStart> {
  return db().transaction(async (tx) => {
    const current = await lockJob(tx, parent.id);
    if (!current || !states.includes(current.state)) return null;
    if (current.shortId && (await isLive(tx, current.shortId))) return { id: current.shortId };
    const stored =
      current.pickVersion === null ? null : await pickIn(tx, current.id, current.pickVersion);
    if (!stored) return { noPick: true };
    const pick: StoredPick = { ...stored, ...current.finalFields, version: 1, skipped: false };
    await tx.insert(jobs).values({ ...jobRow(shortDoc(current, id)), picks: [pick] });
    await tx
      .update(jobs)
      .set(jobSet({ shortId: id }))
      .where(eq(jobs.id, current.id));
    return { id };
  });
}
