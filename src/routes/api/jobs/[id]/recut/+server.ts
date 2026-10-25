import { recut } from '#lib/server/jobs/actions.js';
import { num, readBody, respond, text } from '#lib/server/core/http.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { authorizedJob, buildView } from '#lib/server/jobs/view.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.user?.uid);
    const body = await readBody(request);
    await recut(job, {
      startSec: num(body.startSec),
      lengthSec: num(body.lengthSec),
      reframe: text(body.reframe),
    });
    return buildView((await getJob(job.id)) ?? job);
  });
