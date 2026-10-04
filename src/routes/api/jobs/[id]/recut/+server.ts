import { recut } from '$lib/server/actions';
import { readBody, respond } from '$lib/server/http';
import { getJob } from '$lib/server/jobs';
import { authorizedJob, buildView } from '$lib/server/view';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.session?.allowlisted ?? false);
    const body = await readBody(request);
    await recut(job, {
      startSec: Number(body.startSec),
      lengthSec: Number(body.lengthSec),
      reframe: String(body.reframe ?? ''),
    });
    return buildView((await getJob(job.id)) ?? job);
  });
