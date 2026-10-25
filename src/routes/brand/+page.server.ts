import { getGuides } from '#lib/server/artist/guides.js';
import { requireArtist } from '#lib/server/artist/profile.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => getGuides(requireArtist(locals.user));
