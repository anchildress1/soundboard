import { approveBrand, requireArtist } from '#lib/server/artist/brand.js';
import { readBody, respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, request }) => {
  requireArtist(locals.user);
  return respond(async () => ({ approved: await approveBrand(await readBody(request)) }));
};
