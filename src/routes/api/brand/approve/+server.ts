import { approveBrand, requireCurated } from '#lib/server/artist/brand.js';
import { readBody, respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, request }) => {
  const artistId = requireCurated(locals.user);
  return respond(async () => ({
    approved: await approveBrand(artistId, await readBody(request)),
  }));
};
