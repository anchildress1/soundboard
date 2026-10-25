import { proposeBrand, requireArtist } from '#lib/server/artist/brand.js';
import { respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

/** Answers `{wait}` while the model is busy or its quota is spent; the page calls again on busy. */
export const POST: RequestHandler = ({ locals }) => {
  requireArtist(locals.user);
  return respond(proposeBrand);
};
