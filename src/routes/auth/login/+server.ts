import { error, redirect } from '@sveltejs/kit';
import { authUrl, newOAuthState, OAUTH_COOKIE, OAUTH_TTL_SEC, sign } from '$lib/server/auth/auth';
import type { RequestHandler } from './$types';

/** `/auth/login` signs in with Google. */
export const GET: RequestHandler = ({ url, cookies }) => {
  if (url.searchParams.has('connect')) error(400, 'Unknown connection');
  const state = newOAuthState('sign-in', null);
  cookies.set(OAUTH_COOKIE, sign(state), {
    path: '/auth',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: OAUTH_TTL_SEC,
  });
  redirect(303, authUrl(url.origin, state));
};
