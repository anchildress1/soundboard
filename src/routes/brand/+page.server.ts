import { getBrand, requireAllowlisted } from '$lib/server/brand';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  requireAllowlisted(locals.session);
  return getBrand();
};
