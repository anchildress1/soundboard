import { create, type CreateInput } from '$lib/server/jobs/create';
import { ActionError } from '$lib/server/core/errors';
import { readBody, respond } from '$lib/server/core/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, locals }) =>
  respond(async () => {
    if (!locals.user) throw new ActionError(401, 'Sign in first.');
    return create((await readBody(request)) as CreateInput, locals.user);
  });
