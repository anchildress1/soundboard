import { approveBrand, requireAllowlisted } from '$lib/server/brand';
import { readBody, respond } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, request }) => {
  requireAllowlisted(locals.session);
  return respond(async () => ({ approved: await approveBrand(await readBody(request)) }));
};
