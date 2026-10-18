import { error, redirect } from '@sveltejs/kit';
import {
  authUrl,
  newOAuthState,
  OAUTH_COOKIE,
  OAUTH_TTL_SEC,
  readSession,
  SESSION_COOKIE,
  sign,
} from '$lib/server/auth/auth';
import type { RequestHandler } from './$types';

/** `/auth/login` signs in with Google; `?connect=youtube` re-grants the signed-in user's channel. */
export const GET: RequestHandler = ({ url, cookies, locals }) => {
  const connect = url.searchParams.get('connect');
  if (connect !== null && connect !== 'youtube') error(400, 'Unknown connection');
  // The gate exempts this route, so a connect checks the session itself.
  const session = connect ? readSession(cookies.get(SESSION_COOKIE)) : null;
  if (connect && (!locals.user || !session)) error(401, 'Sign in first.');

  const state = newOAuthState(connect ? 'connect' : 'sign-in', session);
  cookies.set(OAUTH_COOKIE, sign(state), {
    path: '/auth',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: OAUTH_TTL_SEC,
  });
  redirect(303, authUrl(url.origin, state, locals.user?.email));
};
