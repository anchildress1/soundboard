import { error } from '@sveltejs/kit';
import type { JobState, JobView, Pick, Wait } from '$lib/types';
import { modelRole } from '$lib/status';
import { analystModel, pickModel } from '$lib/server/core/env';
import { objectInfo, signedReadUrl } from '$lib/server/media/gcs';
import { getJob, latestPick, listChunks, toPublic, type JobDoc } from './jobs';

/** Loads the caller's own job; anyone else's, or any job when signed out, reads as missing. */
export async function authorizedJob(id: string, uid: string | undefined): Promise<JobDoc> {
  if (!uid) error(404, 'Job not found');
  const job = await getJob(id);
  if (job?.ownerUid !== uid) error(404, 'Job not found');
  return job;
}

/** States whose remaining work reads the job's media: everything but waiting, read-back and done. */
const NEEDS_MEDIA: ReadonlySet<JobState> = new Set([
  'PREP',
  'ANALYZE',
  'PICK',
  'HOOK',
  'RENDER',
  'REVIEW',
  'PUBLISHING',
]);

/** The object the job's remaining work reads, or null when it needs none. */
function neededMedia(job: JobDoc): string | null {
  // A failed job's remaining work is the step it failed at; retry falls back to PREP.
  const state = job.state === 'FAILED' ? (job.failedState ?? 'PREP') : job.state;
  if (!NEEDS_MEDIA.has(state)) return null;
  // A Short cuts from its video's object; its own object is the render it reviews and uploads.
  if (job.short && (state === 'HOOK' || state === 'RENDER')) return job.sourceObject;
  return job.object;
}

/** Whether the bucket's 7-day lifecycle already deleted media the job's remaining work needs. */
export async function mediaExpired(job: JobDoc): Promise<boolean> {
  const object = neededMedia(job);
  return object !== null && (await objectInfo(object)) === null;
}

/** States in which a Short's rendered object is the one on screen. */
const RENDERED: ReadonlySet<JobState> = new Set([
  'REVIEW',
  'PUBLISHING',
  'CLAIMED_COMPLETE',
  'VERIFIED',
]);

/** Signed playback of a Short's render, or null before it renders or once storage dropped it. */
async function playback(job: JobDoc): Promise<string | null> {
  if (!job.short?.renders || !RENDERED.has(job.state)) return null;
  return (await objectInfo(job.object)) ? signedReadUrl(job.object) : null;
}

export async function buildView(job: JobDoc, wait?: Wait): Promise<JobView> {
  const [chunks, stored, playbackUrl] = await Promise.all([
    listChunks(job.id),
    latestPick(job.id),
    playback(job),
  ]);
  // `skipped` rides along; the browser ignores it.
  const pick: Pick | null = stored;
  return {
    job: toPublic(job),
    chunks,
    pick,
    model: modelRole(job) === 'analyst' ? analystModel() : pickModel(),
    ...(wait ? { wait } : {}),
    ...(playbackUrl ? { playbackUrl } : {}),
  };
}
