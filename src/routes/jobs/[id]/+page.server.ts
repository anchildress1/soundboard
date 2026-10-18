import { redirect } from '@sveltejs/kit';
import { signedReadUrl } from '$lib/server/media/gcs';
import { getJob } from '$lib/server/jobs/jobs';
import { authorizedJob, buildView } from '$lib/server/jobs/view';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
  const job = await authorizedJob(params.id, locals.user?.uid);
  // A Short is reviewed in its video's Short tab.
  if (job.parentId) redirect(307, `/jobs/${job.parentId}`);
  locals.jobTrace = job.trace;
  const [view, playbackUrl, short] = await Promise.all([
    buildView(job),
    job.state === 'AWAITING_UPLOAD' ? Promise.resolve(null) : signedReadUrl(job.object),
    shortView(job.shortId),
  ]);
  return { view, playbackUrl, short, trace: job.trace };
};

async function shortView(id: string | null) {
  const short = id ? await getJob(id) : null;
  return short && short.state !== 'DISCARDED' ? buildView(short) : null;
}
