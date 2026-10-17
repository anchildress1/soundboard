import { respond } from '$lib/server/core/http';
import { getJob } from '$lib/server/jobs/jobs';
import { runStep } from '$lib/server/pipeline/pipeline';
import { authorizedJob, buildView } from '$lib/server/jobs/view';
import type { RequestHandler } from './$types';

/** One pipeline step per call; the status page keeps calling until the job leaves the driven states. */
export const POST: RequestHandler = ({ params, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.session?.allowlisted ?? false);
    const { wait } = await runStep(job);
    return buildView((await getJob(job.id)) ?? job, wait);
  });
