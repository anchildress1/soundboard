import { respond } from '#lib/server/core/http.js';
import { authorizedJob, buildView } from '#lib/server/jobs/view.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, locals }) =>
  respond(async () => buildView(await authorizedJob(params.id, locals.user?.uid)));
