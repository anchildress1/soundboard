import { readBody, respond } from '#lib/server/core/http.js';
import { Superseded, uploadSession } from '#lib/server/jobs/upload-session.js';
import { authorizedJob } from '#lib/server/jobs/view.js';
import type { RequestHandler } from './$types';

/** Pick, renew or confirm the owner's browser upload; a superseded request names the generation. */
export const POST: RequestHandler = ({ params, locals, request, url }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.user?.uid);
    try {
      return await uploadSession(job, await readBody(request), url.origin);
    } catch (error) {
      if (!(error instanceof Superseded)) throw error;
      return Response.json(
        { error: error.message, generation: error.generation },
        { status: error.status },
      );
    }
  });
