import { error } from '@sveltejs/kit';
import type { JobState, JobView, Pick, Wait } from '$lib/types';
import { signedReadUrl } from '$lib/server/media/gcs';
import { getJob, latestPick, listChunks, toPublic, type JobDoc } from './jobs';

/** Loads the caller's own job; anyone else's, or any job when signed out, reads as missing. */
export async function authorizedJob(id: string, uid: string | undefined): Promise<JobDoc> {
  const job = uid ? await getJob(id) : null;
  if (!job || job.ownerUid !== uid) error(404, 'Job not found');
  return job;
}

/** States in which a Short's rendered object is the one on screen. */
const RENDERED: ReadonlySet<JobState> = new Set([
  'REVIEW',
  'PUBLISHING',
  'CLAIMED_COMPLETE',
  'VERIFIED',
]);

export async function buildView(job: JobDoc, wait?: Wait): Promise<JobView> {
  const rendered = Boolean(job.short?.renders) && RENDERED.has(job.state);
  const [chunks, stored, playbackUrl] = await Promise.all([
    listChunks(job.id),
    latestPick(job.id),
    rendered ? signedReadUrl(job.object) : null,
  ]);
  // `skipped` rides along; the browser ignores it.
  const pick: Pick | null = stored;
  return {
    job: toPublic(job),
    chunks,
    pick,
    ...(wait ? { wait } : {}),
    ...(playbackUrl ? { playbackUrl } : {}),
  };
}
