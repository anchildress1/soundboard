import { discard } from '$lib/server/actions';
import { respond } from '$lib/server/http';
import { getJob } from '$lib/server/jobs';
import { authorizedJob, buildView } from '$lib/server/view';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.session?.allowlisted ?? false);
    await discard(job);
    return buildView((await getJob(job.id)) ?? job);
  });
