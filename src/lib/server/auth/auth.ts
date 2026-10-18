import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { required } from '$lib/server/core/env';
import { invalidGrant } from '$lib/server/core/errors';
import { YOUTUBE_SCOPES } from '$lib/server/platforms/youtube';

export const SESSION_COOKIE = 'sb_session';
export const OAUTH_COOKIE = 'sb_oauth';
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
export const OAUTH_TTL_SEC = 10 * 60;

/** One consent covers identity and the YouTube channel, so sign-in also connects it. */
export const SCOPES = ['openid', 'email', ...YOUTUBE_SCOPES];

/** `sid` is random per sign-in, so each browser session is distinct; `exp` never slides. */
export type Session = { uid: string; sid: string; gen: number; exp: number };

const mac = (value: string) =>
  createHmac('sha256', required('SESSION_SECRET')).update(value).digest('base64url');

/** `payload.mac`, both base64url. */
export function sign(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body)}`;
}

export function unsign<T>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(mac(body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

const randomId = () => randomBytes(16).toString('base64url');

/** A new session for `uid` at access generation `gen`, signed for the cookie. */
export function sessionCookie(uid: string, gen: number, now = Date.now()): string {
  const session: Session = { uid, sid: randomId(), gen, exp: now + SESSION_TTL_SEC * 1000 };
  return sign(session);
}

/**
 * The signed session, or null for a bad signature, an expired one, or a malformed payload. Whether the user still exists at that generation is the caller's check.
 */
export function readSession(cookie: string | undefined, now = Date.now()): Session | null {
  const data = unsign<Partial<Session>>(cookie);
  if (!data || typeof data.uid !== 'string' || !data.uid) return null;
  if (typeof data.exp !== 'number' || data.exp <= now) return null;
  if (typeof data.sid !== 'string' || typeof data.gen !== 'number') return null;
  return { uid: data.uid, sid: data.sid, gen: data.gen, exp: data.exp };
}

/** On `connect`, `uid` and `sid` name the session that started it, so a stale callback fails. */
export type OAuthState = {
  nonce: string;
  purpose: 'sign-in' | 'connect';
  uid: string | null;
  sid: string | null;
  exp: number;
};

export function newOAuthState(
  purpose: OAuthState['purpose'],
  session: Pick<Session, 'uid' | 'sid'> | null,
  now = Date.now(),
): OAuthState {
  return {
    nonce: randomId(),
    purpose,
    uid: session?.uid ?? null,
    sid: session?.sid ?? null,
    exp: now + OAUTH_TTL_SEC * 1000,
  };
}

/** The signed OAuth state, or null when it is missing, tampered with, or past its 10 minutes. */
export function readOAuthState(cookie: string | undefined, now = Date.now()): OAuthState | null {
  const state = unsign<OAuthState>(cookie);
  if (!state || typeof state.nonce !== 'string' || typeof state.exp !== 'number') return null;
  return state.exp > now ? state : null;
}

export function oauthClient(origin: string): OAuth2Client {
  return new OAuth2Client({
    clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri: `${origin}/auth/callback`,
  });
}

/**
 * Every flow asks for all scopes offline, folding in earlier grants. Sign-in shows the account
 * chooser; connect also forces consent so Google returns a refresh token, and passes `loginHint`
 * (the user's email) because the grant must belong to them. Sign-in ignores `loginHint`.
 */
export function authUrl(origin: string, state: OAuthState, loginHint?: string): string {
  const connect = state.purpose === 'connect';
  return oauthClient(origin).generateAuthUrl({
    scope: SCOPES,
    state: state.nonce,
    access_type: 'offline',
    include_granted_scopes: true,
    prompt: connect ? 'select_account consent' : 'select_account',
    ...(connect && loginHint ? { login_hint: loginHint } : {}),
  });
}

/** What one code exchange proves and grants. Tokens never leave the callback. */
export type Grant = {
  sub: string;
  email: string;
  name: string | null;
  scopes: string[];
  refreshToken: string | null;
  accessToken: string;
};

/**
 * Exchanges the code and verifies the ID token's audience and verified email. Returns null for a
 * used or expired code and for a missing or unverified email; any other failure throws.
 */
export async function exchangeCode(origin: string, code: string): Promise<Grant | null> {
  const client = oauthClient(origin);
  let tokens: Credentials;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (error) {
    if (invalidGrant(error)) return null;
    throw error;
  }
  if (!tokens.id_token || !tokens.access_token) throw new Error('Google returned no tokens');
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: required('GOOGLE_OAUTH_CLIENT_ID'),
  });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified) return null;
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? null,
    scopes: tokens.scope?.split(' ').filter(Boolean) ?? [],
    refreshToken: tokens.refresh_token ?? null,
    accessToken: tokens.access_token,
  };
}
