import { redirect } from '@sveltejs/kit';
import { signedReadUrl } from '$lib/server/gcs';
import { getJob } from '$lib/server/jobs';
import { authorizedJob, buildView } from '$lib/server/view';
import { videosByIds } from '$lib/server/youtube';
import type { LiveMetadata } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
  const job = await authorizedJob(params.id, locals.session?.allowlisted ?? false);
  // A Short is reviewed in its video's Short tab.
  if (job.short) redirect(307, `/jobs/${job.short.parentId}`);
  locals.jobTrace = job.trace;
  const [view, playbackUrl, live, short] = await Promise.all([
    buildView(job),
    job.state === 'AWAITING_UPLOAD' ? Promise.resolve(null) : signedReadUrl(job.object),
    liveMetadata(job.liveVideoId),
    shortView(job.shortId),
  ]);
  return { view, playbackUrl, live, short, trace: job.trace };
};

async function liveMetadata(videoId: string | null): Promise<LiveMetadata | null> {
  if (!videoId) return null;
  try {
    const [video] = await videosByIds([videoId]);
    return video
      ? { videoId, title: video.title, description: video.description, tags: video.tags }
      : null;
  } catch {
    return null;
  }
}

async function shortView(id: string | null) {
  const short = id ? await getJob(id) : null;
  return short && short.state !== 'DISCARDED' ? buildView(short) : null;
}
