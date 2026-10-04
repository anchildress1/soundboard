import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { allowlist, required } from './env';

export const SESSION_COOKIE = 'sb_session';
export const OAUTH_COOKIE = 'sb_oauth';
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

export const SIGN_IN_SCOPES = ['openid', 'email'];
export const CHANNEL_SCOPES = [
  ...SIGN_IN_SCOPES,
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export type Session = { email: string; allowlisted: boolean };

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

export function isAllowlisted(email: string): boolean {
  return allowlist().has(email.trim().toLowerCase());
}

/** Allowlist membership is re-checked on every request, so removing an email revokes access at once. */
export function readSession(cookie: string | undefined, now = Date.now()): Session | null {
  const data = unsign<{ email: string; exp: number }>(cookie);
  if (!data || typeof data.email !== 'string' || data.exp < now) return null;
  return { email: data.email, allowlisted: isAllowlisted(data.email) };
}

export function sessionCookie(email: string, now = Date.now()): string {
  return sign({ email, exp: now + SESSION_TTL_SEC * 1000 });
}

export type OAuthState = {
  nonce: string;
  purpose: 'sign-in' | 'connect';
  channel: 'nathan' | 'sandbox' | null;
};

export function newOAuthState(
  purpose: OAuthState['purpose'],
  channel: OAuthState['channel'],
): OAuthState {
  return { nonce: randomBytes(16).toString('base64url'), purpose, channel };
}

export function oauthClient(origin: string): OAuth2Client {
  return new OAuth2Client({
    clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri: `${origin}/auth/callback`,
  });
}

/**
 * Sign-in asks for identity only. Connecting a channel asks for upload and read scopes offline,
 * with forced consent so Google returns a refresh token.
 */
export function authUrl(origin: string, state: OAuthState): string {
  const connect = state.purpose === 'connect';
  return oauthClient(origin).generateAuthUrl({
    scope: connect ? CHANNEL_SCOPES : SIGN_IN_SCOPES,
    state: state.nonce,
    access_type: connect ? 'offline' : 'online',
    prompt: connect ? 'consent' : 'select_account',
    include_granted_scopes: false,
  });
}

export type CallbackResult = { email: string; refreshToken: string | null };

/** Exchanges the code and verifies the ID token's audience and verified email. */
export async function exchangeCode(origin: string, code: string): Promise<CallbackResult> {
  const client = oauthClient(origin);
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error('Google returned no ID token');
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: required('GOOGLE_OAUTH_CLIENT_ID'),
  });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified)
    throw new Error('Google account email is not verified');
  return { email: payload.email.toLowerCase(), refreshToken: tokens.refresh_token ?? null };
}
