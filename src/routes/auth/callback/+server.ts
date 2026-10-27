import { captureException, captureMessage } from '@sentry/sveltekit';
import { redirect, type Cookies } from '@sveltejs/kit';
import {
  exchangeCode,
  OAUTH_COOKIE,
  readOAuthState,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  sessionCookie,
  type OAuthState,
} from '#lib/server/auth/auth.js';
import { admit } from '#lib/server/auth/users.js';
import { withIdentity } from '#lib/server/core/identity.js';
import {
  analyticsShared,
  ANALYTICS_SCOPE,
  connectGrant,
  getConnection,
  type ConnectOutcome,
} from '#lib/server/platforms/youtube/index.js';
import type { RequestHandler } from './$types';

type Callback = { url: URL; cookies: Cookies; code: string };

/**
 * Admits the account (per SIGNUP_MODE), starts its session, then evaluates the YouTube half of the
 * grant.
 */
async function signIn({ url, cookies, code }: Callback): Promise<never> {
  const grant = await exchangeCode(url.origin, code);
  if (!grant) redirect(303, '/?signin=expired');
  // Nothing is written for an account the allowlist turns away.
  const user = await admit(grant.sub, grant.email);
  if (user === 'denied') {
    captureMessage('Sign-in denied', { level: 'info' });
    redirect(303, '/?signin=denied');
  }
  cookies.set(SESSION_COOKIE, sessionCookie(user.uid), {
    path: '/',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: SESSION_TTL_SEC,
  });
  // The session is already set: a YouTube or KMS failure leaves the user signed in, unconnected.
  let outcome: ConnectOutcome | null = null;
  try {
    outcome = await withIdentity(user.uid, () => connectGrant(user.uid, grant, 'sign-in'));
  } catch (error) {
    captureException(error, { tags: { component: 'sign-in-connect' } });
  }
  redirect(303, outcome === 'consent' ? '/auth/login?connect=youtube' : '/');
}

/**
 * Re-grants the channel for the session that started the connect. A stale callback (another
 * browser session, or sign-out and back in) or another Google account changes nothing. The
 * analytics connect also needs the Analytics scope: without it nothing is written, so a connected
 * row is never downgraded.
 */
async function connect(
  { url, code }: Callback,
  state: OAuthState,
  user: App.Locals['user'],
): Promise<never> {
  if (user?.uid !== state.uid || user.sid !== state.sid)
    redirect(303, '/connections?connect=mismatch');
  const { uid } = user;
  const grant = await exchangeCode(url.origin, code);
  if (!grant) redirect(303, '/?signin=expired');
  if (grant.sub !== uid) redirect(303, '/connections?connect=wrong-account');
  const analytics = state.purpose === 'analytics';
  if (analytics && !grant.scopes.includes(ANALYTICS_SCOPE))
    redirect(303, '/connections?analytics=declined');
  let outcome: ConnectOutcome | 'failed';
  let shared = false;
  try {
    outcome = await connectGrant(uid, grant, 'connect');
    // A grant that brought no refresh token leaves the stored row, and its scopes, as they were.
    shared = analytics && analyticsShared(await getConnection(uid));
  } catch (error) {
    // A YouTube or KMS failure fails before any write, so a stored connection stays as it was.
    captureException(error, { tags: { component: 'connect' } });
    outcome = 'failed';
  }
  if (outcome !== 'connected') redirect(303, `/connections?connect=${outcome}`);
  if (!analytics) redirect(303, '/connections');
  redirect(303, `/connections?analytics=${shared ? 'shared' : 'declined'}`);
}

export const GET: RequestHandler = async ({ url, cookies, locals }) => {
  const state = readOAuthState(cookies.get(OAUTH_COOKIE));
  // One use only: a replayed callback finds no state.
  cookies.delete(OAUTH_COOKIE, { path: '/auth' });
  const code = url.searchParams.get('code');
  if (!state || !code || url.searchParams.get('state') !== state.nonce)
    redirect(303, '/?signin=expired');
  const callback = { url, cookies, code };
  return state.purpose === 'sign-in' ? signIn(callback) : connect(callback, state, locals.user);
};
