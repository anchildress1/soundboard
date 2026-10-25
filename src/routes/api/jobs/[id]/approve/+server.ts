import { approve } from '#lib/server/jobs/actions.js';
import { num, readBody, respond, text } from '#lib/server/core/http.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { splitTags } from '#lib/metadata.js';
import { authorizedJob, buildView } from '#lib/server/jobs/view.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.user?.uid);
    const body = await readBody(request);
    const tags = Array.isArray(body.tags)
      ? body.tags.map((tag) => text(tag).trim()).filter(Boolean)
      : splitTags(text(body.tags));
    await approve(job, {
      title: text(body.title),
      description: text(body.description),
      pickVersion: num(body.pickVersion),
      channelId: text(body.channelId),
      tags,
    });
    return buildView((await getJob(job.id)) ?? job);
  });
