import { discardBrandProposal, requireCurated } from '#lib/server/artist/brand.js';
import { respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals }) => {
  const artistId = requireCurated(locals.user);
  return respond(async () => {
    await discardBrandProposal(artistId);
    return { proposal: null };
  });
};
