import { approve } from '$lib/server/actions';
import { readBody, respond } from '$lib/server/http';
import { getJob } from '$lib/server/jobs';
import { splitTags } from '$lib/metadata';
import { authorizedJob, buildView } from '$lib/server/view';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.session?.allowlisted ?? false);
    const body = await readBody(request);
    const tags = Array.isArray(body.tags)
      ? body.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : splitTags(String(body.tags ?? ''));
    await approve(job, {
      title: String(body.title ?? ''),
      description: String(body.description ?? ''),
      tags,
      pickVersion: Number(body.pickVersion),
    });
    return buildView((await getJob(job.id)) ?? job);
  });
