import { error, redirect } from '@sveltejs/kit';
import {
  exchangeCode,
  isAllowlisted,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  sessionCookie,
  unsign,
  type OAuthState,
} from '$lib/server/auth';
import { storeRefreshToken } from '$lib/server/tokens';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies, locals }) => {
  const state = unsign<OAuthState>(cookies.get(OAUTH_COOKIE));
  cookies.delete(OAUTH_COOKIE, { path: '/auth' });
  const code = url.searchParams.get('code');
  if (!state || !code || url.searchParams.get('state') !== state.nonce)
    error(400, 'Sign-in expired. Try again.');

  const { email, refreshToken } = await exchangeCode(url.origin, code);

  if (state.purpose === 'connect') {
    if (!locals.session?.allowlisted || !state.channel) error(403, 'Not allowed');
    if (!refreshToken)
      error(
        400,
        'Google returned no refresh token. Remove the app at myaccount.google.com/permissions and connect again.',
      );
    await storeRefreshToken(state.channel, refreshToken);
    redirect(303, `/?connected=${state.channel}`);
  }

  if (!isAllowlisted(email)) redirect(303, '/?signin=denied');
  cookies.set(SESSION_COOKIE, sessionCookie(email), {
    path: '/',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: SESSION_TTL_SEC,
  });
  redirect(303, '/');
};
