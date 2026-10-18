import { proposeBrand, requireArtist } from '$lib/server/artist/brand';
import { respond } from '$lib/server/core/http';
import type { RequestHandler } from './$types';

/** Answers `{wait}` while the model is loading or busy; the page calls again. */
export const POST: RequestHandler = ({ locals }) => {
  requireArtist(locals.user);
  return respond(proposeBrand);
};
