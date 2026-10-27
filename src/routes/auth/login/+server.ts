import { error, redirect } from '@sveltejs/kit';
import {
  authUrl,
  newOAuthState,
  OAUTH_COOKIE,
  OAUTH_TTL_SEC,
  sign,
} from '#lib/server/auth/auth.js';
import type { RequestHandler } from './$types';

/**
 * `/auth/login` signs in with Google; `?connect=youtube` re-grants the signed-in user's channel and
 * `?connect=analytics` also asks to share their YouTube Analytics.
 */
const PURPOSES = { youtube: 'connect', analytics: 'analytics' } as const;

export const GET: RequestHandler = ({ url, cookies, locals }) => {
  const connect = url.searchParams.get('connect');
  if (connect !== null && connect !== 'youtube' && connect !== 'analytics')
    error(400, 'Unknown connection');
  // The gate exempts this route, so a connect checks for a user itself.
  if (connect && !locals.user) error(401, 'Sign in first.');

  const purpose = connect ? PURPOSES[connect] : 'sign-in';
  const state = newOAuthState(purpose, connect ? locals.user : null);
  cookies.set(OAUTH_COOKIE, sign(state), {
    path: '/auth',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: OAUTH_TTL_SEC,
  });
  // Google's consent page is the app's only off-site redirect; any other origin throws.
  redirect(303, authUrl(url.origin, state, locals.user?.email), {
    external: ['https://accounts.google.com'],
  });
};
