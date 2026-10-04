import { randomBytes } from 'node:crypto';
import type { Transaction } from '@google-cloud/firestore';
import type { Channel, Chunk, JobOwner, JobState, Pick, PickFields, PublicJob } from '$lib/types';
import { db } from './clients';
import type { AudienceEvidence } from './hashtags';

/** A step's claim on a job; an aborted request frees the job when it lapses. */
export const CLAIM_TTL_MS = 3 * 60 * 1000;

/** Longest video each owner may run, in minutes. */
export const MAX_MINUTES = { nathan: 15, demo: 15, visitor: 5 } as const;

export type JobDoc = PublicJob & {
  object: string;
  contentType: string;
  liveVideoId: string | null;
  ipHash: string | null;
  consecutiveFailures: number;
  claim: { token: string; until: number } | null;
  trace: { sentryTrace: string; baggage: string } | null;
  upload: { sessionUri: string; total: number } | null;
  finalFields: PickFields | null;
  /** Version of the recommendation on screen; approve must name it. */
  pickVersion: number | null;
  /** The genre search behind the pick; re-runs reuse it. */
  audience: AudienceEvidence | null;
  verifyAttempts: number;
  /** A Short job's source video object; null on video jobs. */
  sourceObject: string | null;
  updatedAt: number;
};

export type NewJob = {
  owner: JobOwner;
  channel: Channel;
  songTitle: string;
  notes: string;
  filename: string;
  contentType: string;
  object: string | null;
  sampleId: string | null;
  liveVideoId: string | null;
  ipHash: string | null;
  trace: JobDoc['trace'];
};

/** 128 random bits: job IDs double as the capability to read a visitor job. */
export function newJobId(): string {
  return randomBytes(16).toString('base64url');
}

const jobs = () => db().collection('jobs');
const pad = (n: number) => String(n).padStart(4, '0');
export const jobRef = (id: string) => jobs().doc(id);

export function newJobDoc(input: NewJob, id: string, now = Date.now()): JobDoc {
  return {
    id,
    state: input.object ? 'PREP' : 'AWAITING_UPLOAD',
    owner: input.owner,
    channel: input.channel,
    songTitle: input.songTitle,
    notes: input.notes,
    filename: input.filename,
    contentType: input.contentType,
    sampleId: input.sampleId,
    liveVideoId: input.liveVideoId,
    object: input.object ?? `uploads/${id}`,
    ipHash: input.ipHash,
    probe: null,
    measurements: null,
    chunkCount: 0,
    chunkIndex: 0,
    failedState: null,
    error: null,
    uploadProgress: null,
    videoId: null,
    payload: null,
    consecutiveFailures: 0,
    claim: null,
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
    createdAt: now,
    updatedAt: now,
  };
}

export async function createJob(input: NewJob, id = newJobId()): Promise<JobDoc> {
  const doc = newJobDoc(input, id);
  await jobs().doc(id).set(doc);
  return doc;
}

export async function getJob(id: string): Promise<JobDoc | null> {
  const snap = await jobs().doc(id).get();
  return snap.exists ? (snap.data() as JobDoc) : null;
}

export async function updateJob(id: string, patch: Partial<JobDoc>): Promise<void> {
  await jobs()
    .doc(id)
    .update({ ...patch, updatedAt: Date.now() });
}

/**
 * Claims the job for one step and returns the job as read inside the claim, so the step never runs
 * on a snapshot another request already moved past. Returns null while another request holds an
 * unexpired claim, so a second tab waits instead of double-running the step.
 */
export async function claimJob(
  id: string,
  now = Date.now(),
): Promise<{ token: string; job: JobDoc } | null> {
  const ref = jobs().doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const job = snap.data() as JobDoc;
    if (job.claim && job.claim.until > now) return null;
    const token = randomBytes(8).toString('hex');
    tx.update(ref, { claim: { token, until: now + CLAIM_TTL_MS } });
    return { token, job };
  });
}

/**
 * Applies the step's result and drops the claim. The patch is skipped when the claim lapsed to
 * someone else or an action (discard, re-run) moved the job off the state the step started from.
 */
export async function releaseJob(
  id: string,
  token: string,
  claimedState: JobState,
  patch: Partial<JobDoc> = {},
  writes: { pick?: Pick; chunk?: Chunk } = {},
): Promise<boolean> {
  const ref = jobs().doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const job = snap.data() as JobDoc;
    if (job.claim?.token !== token) return false;
    if (job.state !== claimedState) {
      tx.update(ref, { claim: null, updatedAt: Date.now() });
      return false;
    }
    // Step output lands in the same transaction, so a worker that lost its claim persists nothing.
    if (writes.pick) {
      const stored: StoredPick = { ...writes.pick, skipped: false };
      tx.set(ref.collection('pick').doc(pad(writes.pick.version)), stored);
    }
    if (writes.chunk) tx.set(ref.collection('chunks').doc(pad(writes.chunk.index)), writes.chunk);
    tx.update(ref, { ...patch, claim: null, updatedAt: Date.now() });
    return true;
  });
}

/** Moves the job to a new state only if it is still in one of `from`; false when it already moved. */
export async function transitionJob(
  id: string,
  from: readonly JobState[],
  patch: Partial<JobDoc>,
): Promise<boolean> {
  const ref = jobs().doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || !from.includes((snap.data() as JobDoc).state)) return false;
    tx.update(ref, { ...patch, updatedAt: Date.now() });
    return true;
  });
}

export async function saveChunk(id: string, chunk: Chunk): Promise<void> {
  await jobs().doc(id).collection('chunks').doc(pad(chunk.index)).set(chunk);
}

export async function listChunks(id: string): Promise<Chunk[]> {
  const snap = await jobs().doc(id).collection('chunks').get();
  return snap.docs.map((d) => d.data() as Chunk).sort((a, b) => a.index - b.index);
}

export type StoredPick = Pick & { skipped: boolean };

export async function savePick(id: string, pick: Pick): Promise<void> {
  const stored: StoredPick = { ...pick, skipped: false };
  await jobs().doc(id).collection('pick').doc(pad(pick.version)).set(stored);
}

/**
 * Marks the pick skipped, queues a new pick, and commits `alsoWrite` (the SKIPPED feedback) in one
 * transaction; false if the job already left REVIEW.
 */
export async function skipAndRepick(
  id: string,
  version: number | null,
  alsoWrite: (tx: Transaction) => void = () => {},
): Promise<boolean> {
  const ref = jobs().doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || (snap.data() as JobDoc).state !== 'REVIEW') return false;
    if (version !== null) tx.update(ref.collection('pick').doc(pad(version)), { skipped: true });
    alsoWrite(tx);
    tx.update(ref, { state: 'PICK', consecutiveFailures: 0, error: null, updatedAt: Date.now() });
    return true;
  });
}

/** Firestore key for a pick version, zero-padded so keys sort in version order. */
export const pickKey = (version: number) => pad(version);

export async function listPicks(id: string): Promise<StoredPick[]> {
  const snap = await jobs().doc(id).collection('pick').get();
  return snap.docs.map((d) => d.data() as StoredPick).sort((a, b) => a.version - b.version);
}

export async function latestPick(id: string): Promise<StoredPick | null> {
  return (await listPicks(id)).at(-1) ?? null;
}

/** Strips server-only fields before a job reaches the browser. */
export function toPublic(doc: JobDoc): PublicJob {
  return {
    id: doc.id,
    state: doc.state,
    owner: doc.owner,
    channel: doc.channel,
    songTitle: doc.songTitle,
    notes: doc.notes,
    filename: doc.filename,
    sampleId: doc.sampleId,
    probe: doc.probe,
    measurements: doc.measurements,
    chunkCount: doc.chunkCount,
    chunkIndex: doc.chunkIndex,
    failedState: doc.failedState,
    error: doc.error,
    uploadProgress: doc.uploadProgress,
    videoId: doc.videoId,
    payload: doc.payload,
    hashtagCandidates: doc.hashtagCandidates,
    shortId: doc.shortId,
    short: doc.short,
    createdAt: doc.createdAt,
  };
}

/** Visitor and demo jobs are reachable by their unguessable ID; Nathan's only from an allowlisted session. */
export function canAccess(doc: { owner: JobOwner }, allowlisted: boolean): boolean {
  return doc.owner !== 'nathan' || allowlisted;
}

/** A step that succeeded: the failure streak and the shown error reset. */
export const ok = (patch: Partial<JobDoc>): Partial<JobDoc> => ({
  ...patch,
  consecutiveFailures: 0,
  error: null,
});

export function fail(state: JobState, message: string): Partial<JobDoc> {
  return { state: 'FAILED', failedState: state, error: message };
}

/**
 * Cuts a Short job from a video job: the parent's reviewed metadata becomes the Short's pick v1, its
 * candidate lists come along so approve holds the same rules, and its trace is shared, so the Short
 * lands in the video's trace. One live Short per video: an existing one that isn't discarded is
 * returned instead. Null when the parent left `states` before the transaction ran.
 */
export async function createShort(
  parent: JobDoc,
  pick: Pick,
  states: readonly JobState[],
  id = newJobId(),
): Promise<string | null> {
  const parentRef = jobs().doc(parent.id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(parentRef);
    const current = snap.exists ? (snap.data() as JobDoc) : null;
    if (!current || !states.includes(current.state)) return null;
    if (current.shortId) {
      const existing = await tx.get(jobs().doc(current.shortId));
      if (existing.exists && (existing.data() as JobDoc).state !== 'DISCARDED') {
        return current.shortId;
      }
    }
    const base = newJobDoc(
      {
        owner: current.owner,
        channel: current.channel,
        songTitle: current.songTitle,
        notes: current.notes,
        filename: `${current.filename.replace(/\.[^.]+$/, '')} (Short).mp4`,
        contentType: 'video/mp4',
        object: null,
        sampleId: current.sampleId,
        liveVideoId: null,
        ipHash: current.ipHash,
        trace: current.trace,
      },
      id,
    );
    const doc: JobDoc = {
      ...base,
      state: 'HOOK',
      hashtagCandidates: current.hashtagCandidates,
      audience: current.audience,
      pickVersion: 1,
      sourceObject: current.object,
      short: {
        parentId: current.id,
        sourceDurationSec: current.probe?.durationSec ?? 0,
        reframe: 'blur',
        hook: null,
        skipped: [],
        renders: 0,
        modelMs: 0,
      },
    };
    const stored: StoredPick = { ...pick, version: 1, skipped: false };
    tx.set(jobs().doc(id), doc);
    tx.set(jobs().doc(id).collection('pick').doc(pad(1)), stored);
    tx.update(parentRef, { shortId: id, updatedAt: Date.now() });
    return id;
  });
}
