import { respond } from '$lib/server/http';
import { authorizedJob, buildView } from '$lib/server/view';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, locals }) =>
  respond(async () =>
    buildView(await authorizedJob(params.id, locals.session?.allowlisted ?? false)),
  );
