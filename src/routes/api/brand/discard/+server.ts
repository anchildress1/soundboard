import { discardBrandProposal, requireAllowlisted } from '$lib/server/artist/brand';
import { respond } from '$lib/server/core/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals }) => {
  requireAllowlisted(locals.session);
  return respond(async () => {
    await discardBrandProposal();
    return { proposal: null };
  });
};
