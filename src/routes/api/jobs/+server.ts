import { create, type CreateInput } from '$lib/server/create';
import { readBody, respond } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, locals, getClientAddress }) =>
  respond(async () =>
    create((await readBody(request)) as CreateInput, {
      allowlisted: locals.session?.allowlisted ?? false,
      demo: locals.session?.demo ?? false,
      ip: getClientAddress(),
    }),
  );
