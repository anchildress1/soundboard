import { redirect } from '@sveltejs/kit';
import {
  exchangeCode,
  OAUTH_COOKIE,
  readOAuthState,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  sessionCookie,
} from '$lib/server/auth/auth';
import { redeemInvite, upsertUser } from '$lib/server/auth/users';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const state = readOAuthState(cookies.get(OAUTH_COOKIE));
  cookies.delete(OAUTH_COOKIE, { path: '/auth' });
  const code = url.searchParams.get('code');
  if (state?.purpose !== 'sign-in' || !code || url.searchParams.get('state') !== state.nonce)
    redirect(303, '/?signin=expired');

  const grant = await exchangeCode(url.origin, code);
  if (!grant) redirect(303, '/?signin=expired');
  const { sub, email, name } = grant;
  const redeemed = await redeemInvite(sub, email);
  if (redeemed === 'denied') redirect(303, '/?signin=denied');
  const user = (await upsertUser(sub, { email, name })) ?? redeemed;
  cookies.set(SESSION_COOKIE, sessionCookie(user.uid, user.accessGeneration), {
    path: '/',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: SESSION_TTL_SEC,
  });
  redirect(303, '/');
};
