import { DEFAULT_INFLUENCE } from '#lib/influence.js';
import { influenceSettings } from '#lib/server/artist/guides.js';
import type { PageServerLoad } from './$types';

/** The caller's own profile and peer-influence settings; signed-out requests never reach here. */
export const load: PageServerLoad = async ({ locals }) => {
  const artist = locals.user?.artist;
  if (!artist) return { artist: null, influence: DEFAULT_INFLUENCE, saved: false, canSave: false };
  return {
    artist: { name: artist.name, bandcampUrl: artist.bandcampUrl, contactLine: artist.contactLine },
    ...(await influenceSettings(artist.id)),
  };
};
