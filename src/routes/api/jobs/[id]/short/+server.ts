import { makeShort } from '#lib/server/jobs/actions.js';
import { respond } from '#lib/server/core/http.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { authorizedJob, buildView } from '#lib/server/jobs/view.js';
import type { RequestHandler } from './$types';

/** Starts the video's Short, or returns the one it already has; the page then drives its steps. */
export const POST: RequestHandler = ({ params, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.user?.uid);
    const id = await makeShort(job);
    const short = await getJob(id);
    if (!short) throw new Error(`Short ${id} vanished after it was created.`);
    return buildView(short);
  });
