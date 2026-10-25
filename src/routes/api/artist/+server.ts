import { saveArtist } from '#lib/server/artist/profile.js';
import { ActionError } from '#lib/server/core/errors.js';
import { readBody, respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

/** Creates or updates the caller's artist profile; `id` and `curated` never leave the server. */
export const PUT: RequestHandler = ({ request, locals }) =>
  respond(async () => {
    if (!locals.user) throw new ActionError(401, 'Sign in first.');
    const { name, bandcampUrl, contactLine } = await saveArtist(
      locals.user,
      await readBody(request),
    );
    return { artist: { name, bandcampUrl, contactLine } };
  });
