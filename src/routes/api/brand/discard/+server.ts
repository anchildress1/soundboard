import { discardBrandProposal, requireArtist } from '#lib/server/artist/brand.js';
import { respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals }) => {
  requireArtist(locals.user);
  return respond(async () => {
    await discardBrandProposal();
    return { proposal: null };
  });
};
