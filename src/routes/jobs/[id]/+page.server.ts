import { redirect } from '@sveltejs/kit';
import { signedReadUrl } from '#lib/server/media/gcs.js';
import { finishDiscardCleanup } from '#lib/server/jobs/actions.js';
import { getJob, uploadGeneration } from '#lib/server/jobs/jobs.js';
import { savedAmount } from '#lib/server/jobs/upload-session.js';
import { authorizedJob, buildView, mediaExpired, reviewData } from '#lib/server/jobs/view.js';
import { getConnection } from '#lib/server/platforms/youtube/index.js';
import type { Destination } from '#lib/types.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
  const job = await authorizedJob(params.id, locals.user?.uid);
  // A Short is reviewed in its video's Short tab.
  if (job.parentId) redirect(307, `/jobs/${job.parentId}`);
  locals.jobTrace = job.trace;
  // A discarded job whose upload cleanup didn't finish owes it; this touch repeats it.
  await finishDiscardCleanup(job);
  const expired = await mediaExpired(job);
  const [view, playbackUrl, { short, shortExpired }, approveTo, uploadSaved] = await Promise.all([
    buildView(job),
    job.state === 'AWAITING_UPLOAD' || expired ? Promise.resolve(null) : signedReadUrl(job.object),
    shortView(job.shortId),
    connectedChannel(job.ownerUid),
    savedAmount(job),
  ]);
  return {
    view,
    // Page loads only read; nothing here starts research.
    research: await reviewData(view.pick),
    playbackUrl,
    short,
    shortExpired,
    trace: job.trace,
    expired,
    approveTo,
    uploadSaved,
    // The observed generation a re-pick sends; not a secret.
    uploadGeneration: uploadGeneration(job),
  };
};

/** The channel an approval would pin now; approve refuses if it changed before the click. */
async function connectedChannel(uid: string): Promise<Destination | null> {
  const connection = await getConnection(uid);
  return connection?.status === 'connected'
    ? { channelId: connection.channelId, channelTitle: connection.channelTitle }
    : null;
}

async function shortView(id: string | null) {
  const short = id ? await getJob(id) : null;
  if (!short || short.state === 'DISCARDED') return { short: null, shortExpired: false };
  const [view, shortExpired] = await Promise.all([buildView(short), mediaExpired(short)]);
  return { short: view, shortExpired };
}
