import { redirect, type Cookies } from '@sveltejs/kit';
import {
  exchangeCode,
  OAUTH_COOKIE,
  readOAuthState,
  readSession,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  sessionCookie,
  type OAuthState,
} from '$lib/server/auth/auth';
import { redeemInvite, upsertUser } from '$lib/server/auth/users';
import { connectGrant } from '$lib/server/platforms/youtube';
import type { RequestHandler } from './$types';

type Callback = { url: URL; cookies: Cookies; code: string };

/** Admits an invited account, starts its session, then evaluates the YouTube half of the grant. */
async function signIn({ url, cookies, code }: Callback): Promise<never> {
  const grant = await exchangeCode(url.origin, code);
  if (!grant) redirect(303, '/?signin=expired');
  // Nothing is written for an account the invite check turns away.
  const redeemed = await redeemInvite(grant.sub, grant.email);
  if (redeemed === 'denied') redirect(303, '/?signin=denied');
  const user = (await upsertUser(grant.sub, { email: grant.email, name: grant.name })) ?? redeemed;
  cookies.set(SESSION_COOKIE, sessionCookie(user.uid, user.accessGeneration), {
    path: '/',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: SESSION_TTL_SEC,
  });
  if ((await connectGrant(user.uid, grant, 'sign-in')) === 'consent')
    redirect(303, '/auth/login?connect=youtube');
  redirect(303, '/');
}

/**
 * Re-grants the channel for the session that started the connect. A stale callback (another
 * browser session, or sign-out and back in) or another Google account changes nothing.
 */
async function connect(
  { url, cookies, code }: Callback,
  state: OAuthState,
  uid: string | undefined,
): Promise<never> {
  const session = readSession(cookies.get(SESSION_COOKIE));
  if (!uid || session?.uid !== uid || uid !== state.uid || session.sid !== state.sid)
    redirect(303, '/connections?connect=mismatch');
  const grant = await exchangeCode(url.origin, code);
  if (!grant) redirect(303, '/?signin=expired');
  if (grant.sub !== uid) redirect(303, '/connections?connect=wrong-account');
  await connectGrant(uid, grant, 'connect');
  redirect(303, '/connections');
}

export const GET: RequestHandler = async ({ url, cookies, locals }) => {
  const state = readOAuthState(cookies.get(OAUTH_COOKIE));
  // One use only: a replayed callback finds no state.
  cookies.delete(OAUTH_COOKIE, { path: '/auth' });
  const code = url.searchParams.get('code');
  if (!state || !code || url.searchParams.get('state') !== state.nonce)
    redirect(303, '/?signin=expired');
  const callback = { url, cookies, code };
  return state.purpose === 'connect'
    ? connect(callback, state, locals.user?.uid)
    : signIn(callback);
};
