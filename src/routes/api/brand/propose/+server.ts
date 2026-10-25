import { proposeBrand, requireCurated } from '#lib/server/artist/brand.js';
import { respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

/** Answers `{wait}` while YouTube or the model is busy, the quota is spent, or the grant is lost. */
export const POST: RequestHandler = ({ locals }) => {
  const artistId = requireCurated(locals.user);
  return respond(() => proposeBrand(locals.user!.uid, artistId));
};
