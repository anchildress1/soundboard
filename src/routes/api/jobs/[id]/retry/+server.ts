import { retry } from '#lib/server/jobs/actions.js';
import { respond } from '#lib/server/core/http.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { authorizedJob, buildView } from '#lib/server/jobs/view.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.user?.uid);
    await retry(job);
    return buildView((await getJob(job.id)) ?? job);
  });
