import { respond } from '#lib/server/core/http.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { runStep } from '#lib/server/pipeline/pipeline.js';
import { authorizedJob, buildView } from '#lib/server/jobs/view.js';
import type { RequestHandler } from './$types';

/** One pipeline step per call; the status page keeps calling until the job leaves the driven states. */
export const POST: RequestHandler = ({ params, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.user?.uid);
    const { wait } = await runStep(job);
    return buildView((await getJob(job.id)) ?? job, wait);
  });
