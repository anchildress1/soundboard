import { error } from '@sveltejs/kit';
import type { JobView, Pick, Wait } from '$lib/types';
import { canAccess, getJob, latestPick, listChunks, toPublic, type JobDoc } from './jobs';

/** Loads a job the caller may see. Nathan's jobs read as missing to anyone not allowlisted. */
export async function authorizedJob(id: string, allowlisted: boolean): Promise<JobDoc> {
  const job = await getJob(id);
  if (!job || !canAccess(job, allowlisted)) error(404, 'Job not found');
  return job;
}

export async function buildView(job: JobDoc, wait?: Wait): Promise<JobView> {
  const [chunks, stored] = await Promise.all([listChunks(job.id), latestPick(job.id)]);
  // `skipped` rides along; the browser ignores it.
  const pick: Pick | null = stored;
  return { job: toPublic(job), chunks, pick, ...(wait ? { wait } : {}) };
}
