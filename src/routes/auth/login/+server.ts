import { error, redirect } from '@sveltejs/kit';
import { authUrl, newOAuthState, OAUTH_COOKIE, sign } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/**
 * `/auth/login` signs in. `/auth/login?connect=nathan|sandbox` connects a YouTube channel for uploads,
 * which only an allowlisted session may do.
 */
export const GET: RequestHandler = ({ url, cookies, locals }) => {
  const connect = url.searchParams.get('connect');
  if (connect !== null && connect !== 'nathan' && connect !== 'sandbox')
    error(400, 'Unknown channel');
  if (connect && !locals.session?.allowlisted)
    error(403, 'Sign in with an allowlisted account first');
  const state = newOAuthState(connect ? 'connect' : 'sign-in', connect);
  cookies.set(OAUTH_COOKIE, sign(state), {
    path: '/auth',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: 600,
  });
  redirect(303, authUrl(url.origin, state));
};
