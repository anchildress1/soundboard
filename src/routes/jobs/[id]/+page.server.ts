import { signedReadUrl } from '$lib/server/gcs';
import { authorizedJob, buildView } from '$lib/server/view';
import { videosByIds } from '$lib/server/youtube';
import type { LiveMetadata } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
  const job = await authorizedJob(params.id, locals.session?.allowlisted ?? false);
  locals.jobTrace = job.trace;
  const [view, playbackUrl, live] = await Promise.all([
    buildView(job),
    job.state === 'AWAITING_UPLOAD' ? Promise.resolve(null) : signedReadUrl(job.object),
    liveMetadata(job.liveVideoId),
  ]);
  return { view, playbackUrl, live, trace: job.trace };
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
