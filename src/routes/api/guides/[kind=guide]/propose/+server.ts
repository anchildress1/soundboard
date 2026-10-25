import { proposeBrand } from '#lib/server/artist/brand.js';
import { requireArtist } from '#lib/server/artist/profile.js';
import { proposeVoice } from '#lib/server/artist/voice.js';
import { respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

/**
 * One proposal step. Answers `{wait}` while YouTube or the model is busy, the quota is spent, or
 * the grant is lost.
 */
export const POST: RequestHandler = ({ locals, params }) => {
  const artistId = requireArtist(locals.user);
  const user = { uid: locals.user!.uid, artistId };
  return respond(() => (params.kind === 'voice' ? proposeVoice(user) : proposeBrand(user)));
};
