import { redirect } from '@sveltejs/kit';
import { OAUTH_COOKIE, SESSION_COOKIE } from '#lib/server/auth/auth.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
  cookies.delete(SESSION_COOKIE, { path: '/' });
  // A connect started before sign-out must not complete afterwards.
  cookies.delete(OAUTH_COOKIE, { path: '/auth' });
  redirect(303, '/');
};
