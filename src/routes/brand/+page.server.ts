import { getBrand, requireArtist } from '#lib/server/artist/brand.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  requireArtist(locals.user);
  return getBrand();
};
