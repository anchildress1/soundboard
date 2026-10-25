import type { PageServerLoad } from './$types';

/** The caller's own editable profile; signed-out requests never reach here (`hooks.server.ts`). */
export const load: PageServerLoad = ({ locals }) => {
  const artist = locals.user?.artist;
  return {
    artist: artist
      ? { name: artist.name, bandcampUrl: artist.bandcampUrl, contactLine: artist.contactLine }
      : null,
  };
};
