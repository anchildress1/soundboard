import { makeShort } from '#lib/server/jobs/actions.js';
import { ActionError, NO_ARTIST } from '#lib/server/core/errors.js';
import { respond } from '#lib/server/core/http.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { authorizedJob, buildView } from '#lib/server/jobs/view.js';
import type { RequestHandler } from './$types';

/** Starts the video's Short, or returns the one it already has; the page then drives its steps. */
export const POST: RequestHandler = ({ params, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.user?.uid);
    const artist = locals.user?.artist;
    if (!artist) throw new ActionError(409, NO_ARTIST);
    const id = await makeShort(job, artist.name);
    const short = await getJob(id);
    if (!short) throw new Error(`Short ${id} vanished after it was created.`);
    return buildView(short);
  });
