import { requireArtist } from '#lib/server/artist/brand.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  requireArtist(locals.user);
  return {};
};
