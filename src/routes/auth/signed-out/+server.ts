import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// A server-only route: the client router can't follow a redirect here in place, so it reloads the
// page and drops the signed-in data it cached.
export const GET: RequestHandler = () => redirect(303, '/');
