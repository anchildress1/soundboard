import { respond } from '$lib/server/http';
import { getJob } from '$lib/server/jobs';
import { runStep } from '$lib/server/pipeline';
import { authorizedJob, buildView } from '$lib/server/view';
import type { RequestHandler } from './$types';

/** One pipeline step per call; the status page keeps calling until the job leaves the driven states. */
export const POST: RequestHandler = ({ params, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.session?.allowlisted ?? false);
    const { wait } = await runStep(job);
    return buildView((await getJob(job.id)) ?? job, wait);
  });
