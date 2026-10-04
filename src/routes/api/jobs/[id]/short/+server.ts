import { makeShort } from '$lib/server/actions';
import { respond } from '$lib/server/http';
import { getJob } from '$lib/server/jobs';
import { authorizedJob, buildView } from '$lib/server/view';
import type { RequestHandler } from './$types';

/** Starts the video's Short, or returns the one it already has; the page then drives its steps. */
export const POST: RequestHandler = ({ params, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.session?.allowlisted ?? false);
    const id = await makeShort(job);
    const short = await getJob(id);
    if (!short) throw new Error(`Short ${id} vanished after it was created.`);
    return buildView(short);
  });
