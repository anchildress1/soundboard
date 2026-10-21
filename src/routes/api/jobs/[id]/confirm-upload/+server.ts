import { confirmUpload } from '$lib/server/jobs/actions';
import { readBody, respond, text } from '$lib/server/core/http';
import { getJob } from '$lib/server/jobs/jobs';
import { authorizedJob, buildView } from '$lib/server/jobs/view';
import type { RequestHandler } from './$types';

/** The owner's answer to "upload outcome unknown": the URL of the video YouTube kept. */
export const POST: RequestHandler = ({ params, request, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.user?.uid);
    const body = await readBody(request);
    await confirmUpload(job, text(body.url));
    return buildView((await getJob(job.id)) ?? job);
  });
