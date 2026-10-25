import { create, type CreateInput } from '#lib/server/jobs/create.js';
import { ActionError } from '#lib/server/core/errors.js';
import { readBody, respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, locals, url }) =>
  respond(async () => {
    if (!locals.user) throw new ActionError(401, 'Sign in first.');
    return create((await readBody(request)) as CreateInput, locals.user, url.origin);
  });
