import { approve } from '$lib/server/actions';
import { num, readBody, respond, text } from '$lib/server/http';
import { getJob } from '$lib/server/jobs';
import { splitTags } from '$lib/metadata';
import { authorizedJob, buildView } from '$lib/server/view';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.session?.allowlisted ?? false);
    const body = await readBody(request);
    const tags = Array.isArray(body.tags)
      ? body.tags.map((tag) => text(tag).trim()).filter(Boolean)
      : splitTags(text(body.tags));
    await approve(job, {
      title: text(body.title),
      description: text(body.description),
      pickVersion: num(body.pickVersion),
      tags,
    });
    return buildView((await getJob(job.id)) ?? job);
  });
