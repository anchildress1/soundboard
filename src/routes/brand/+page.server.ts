import { getBrand, requireCurated } from '#lib/server/artist/brand.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => getBrand(requireCurated(locals.user));
