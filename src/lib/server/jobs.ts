import { randomBytes } from 'node:crypto';
import type { Channel, Chunk, JobOwner, JobState, Pick, PickFields, PublicJob } from '$lib/types';
import { db } from './clients';

/** A step's claim on a job; an aborted request frees the job when it lapses. */
export const CLAIM_TTL_MS = 3 * 60 * 1000;

/** Longest video each owner may run, in minutes. */
export const MAX_MINUTES = { nathan: 15, visitor: 5 } as const;

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
  verifyAttempts: number;
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

export async function createJob(input: NewJob, id = newJobId()): Promise<JobDoc> {
  const now = Date.now();
  const doc: JobDoc = {
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
    upload: null,
    finalFields: null,
    verifyAttempts: 0,
    createdAt: now,
    updatedAt: now,
  };
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
 * Claims the job for one step. Returns a token, or null while another request holds an unexpired
 * claim, so a second tab waits instead of double-running the step.
 */
export async function claimJob(id: string, now = Date.now()): Promise<string | null> {
  const ref = jobs().doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const { claim } = snap.data() as JobDoc;
    if (claim && claim.until > now) return null;
    const token = randomBytes(8).toString('hex');
    tx.update(ref, { claim: { token, until: now + CLAIM_TTL_MS } });
    return token;
  });
}

/** Applies the step's result and drops the claim, unless the claim already lapsed to someone else. */
export async function releaseJob(
  id: string,
  token: string,
  patch: Partial<JobDoc> = {},
): Promise<boolean> {
  const ref = jobs().doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || (snap.data() as JobDoc).claim?.token !== token) return false;
    tx.update(ref, { ...patch, claim: null, updatedAt: Date.now() });
    return true;
  });
}

const pad = (n: number) => String(n).padStart(4, '0');

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

export async function markPickSkipped(id: string, version: number): Promise<void> {
  await jobs().doc(id).collection('pick').doc(pad(version)).update({ skipped: true });
}

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
    createdAt: doc.createdAt,
  };
}

/** Visitor jobs are reachable by their unguessable ID; Nathan's only from an allowlisted session. */
export function canAccess(doc: { owner: JobOwner }, allowlisted: boolean): boolean {
  return doc.owner === 'visitor' || allowlisted;
}

export function fail(state: JobState, message: string): Partial<JobDoc> {
  return { state: 'FAILED', failedState: state, error: message };
}
