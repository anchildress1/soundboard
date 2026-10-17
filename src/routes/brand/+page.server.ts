import { getBrand, requireAllowlisted } from '$lib/server/artist/brand';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  requireAllowlisted(locals.session);
  return getBrand();
};
