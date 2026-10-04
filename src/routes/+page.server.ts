import { listSamples } from '$lib/server/samples';
import type { Sample } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  let samples: Omit<Sample, 'object'>[] = [];
  try {
    samples = (await listSamples()).map(({ id, songTitle, videoId, durationSec }) => ({
      id,
      songTitle,
      videoId,
      durationSec,
    }));
  } catch {
    // Samples are optional; the upload path still works.
  }
  return { samples };
};
