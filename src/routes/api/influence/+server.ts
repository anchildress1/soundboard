import { influenceError, type Influence } from '#lib/influence.js';
import { saveInfluence } from '#lib/server/artist/guides.js';
import { requireArtist } from '#lib/server/artist/profile.js';
import { ActionError } from '#lib/server/core/errors.js';
import { readBody, respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

/** Saves the caller's peer-influence settings on their approved brand guide; later picks use them. */
export const PUT: RequestHandler = ({ request, locals }) =>
  respond(async () => {
    if (!locals.user) throw new ActionError(401, 'Sign in first.');
    requireArtist(locals.user);
    const body = await readBody(request);
    const problem = influenceError(body);
    if (problem) throw new ActionError(422, problem);
    const influence = body as Influence;
    await saveInfluence(influence);
    return { influence };
  });
