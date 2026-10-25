import { discardProposal } from '#lib/server/artist/guides.js';
import { requireArtist } from '#lib/server/artist/profile.js';
import { ActionError } from '#lib/server/core/errors.js';
import { readBody, respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

/** Discards the proposal named by `proposalId`; the approved version stays. */
export const POST: RequestHandler = ({ locals, params, request }) => {
  const artistId = requireArtist(locals.user);
  return respond(async () => {
    const { proposalId } = await readBody(request);
    if (typeof proposalId !== 'number')
      throw new ActionError(400, 'Name the proposal being discarded.');
    await discardProposal(artistId, params.kind, proposalId);
    return { proposal: null };
  });
};
