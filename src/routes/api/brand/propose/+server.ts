import { proposeBrand, requireAllowlisted } from '$lib/server/brand';
import { respond } from '$lib/server/http';
import type { RequestHandler } from './$types';

/** Answers `{wait}` while the model is loading or busy; the page calls again. */
export const POST: RequestHandler = ({ locals }) => {
  requireAllowlisted(locals.session);
  return respond(proposeBrand);
};
