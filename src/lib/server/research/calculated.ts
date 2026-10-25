// Numbers calculated from stored YouTube statistics (research R7). Each is per release or per
// outcome, never across channels, and labeled calculated wherever it's shown.
import type { Calculated } from '#lib/types.js';

const calculated = (value: number | null): Calculated => ({ value, calculated: true });

/** Gained minus lost on the artist's own release; null when either is unknown. */
export function netSubscribers(metrics: {
  subscribersGained: number | null;
  subscribersLost: number | null;
}): Calculated {
  const { subscribersGained: gained, subscribersLost: lost } = metrics;
  return calculated(gained === null || lost === null ? null : gained - lost);
}

/** (likes + comments) / views for one release; null when any is unknown or views are 0. */
export function engagementRate(stats: {
  views: number | null;
  likes: number | null;
  comments: number | null;
}): Calculated {
  const { views, likes, comments } = stats;
  if (views === null || likes === null || comments === null || views === 0) return calculated(null);
  return calculated((likes + comments) / views);
}
