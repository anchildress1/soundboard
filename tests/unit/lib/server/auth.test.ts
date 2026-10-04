// @vitest-environment node
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authUrl,
  CHANNEL_SCOPES,
  exchangeCode,
  isAllowlisted,
  isDemo,
  newOAuthState,
  oauthClient,
  readSession,
  SESSION_TTL_SEC,
  sessionCookie,
  sign,
  SIGN_IN_SCOPES,
  unsign,
} from '$lib/server/auth';

const NATHAN_EMAIL = 'nathan@example.com';
const DEMO_EMAIL = 'demo@example.com';

const oauth = vi.hoisted(() => ({
  options: [] as unknown[],
  generateAuthUrl: vi.fn(
    (opts: unknown) => `https://accounts.google.com/o?${JSON.stringify(opts)}`,
  ),
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    constructor(options: unknown) {
      oauth.options.push(options);
    }
    generateAuthUrl = oauth.generateAuthUrl;
    getToken = oauth.getToken;
    verifyIdToken = oauth.verifyIdToken;
  },
}));

const ORIGIN = 'https://soundboard.run.app';

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'test-secret');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'csecret');
  vi.stubEnv('ALLOWLIST_EMAILS', 'nathan@example.com, Ashley@Example.com');
  vi.clearAllMocks();
  oauth.options.length = 0;
});

describe('sign / unsign', () => {
  it('round-trips a payload', () => {
    const token = sign({ email: 'a@b.c', n: 1 });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(unsign(token)).toEqual({ email: 'a@b.c', n: 1 });
  });

  it('rejects a tampered body', () => {
    const [, mac] = sign({ email: 'a@b.c' }).split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'evil@b.c' })).toString('base64url');
    expect(unsign(`${forged}.${mac}`)).toBeNull();
  });

  it('rejects a tampered signature of the same length', () => {
    const token = sign({ x: 1 });
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    expect(unsign(token.slice(0, -1) + last)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const token = sign({ x: 1 });
    vi.stubEnv('SESSION_SECRET', 'other');
    expect(unsign(token)).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['no dot', 'abc'],
    ['empty body', '.abc'],
    ['empty signature', 'abc.'],
    ['short signature', 'abc.def'],
  ])('rejects a %s token', (_label, token) => {
    expect(unsign(token)).toBeNull();
  });

  it('returns null when a validly signed body is not JSON', () => {
    const body = Buffer.from('not json').toString('base64url');
    const mac = createHmac('sha256', 'test-secret').update(body).digest('base64url');
    expect(unsign(`${body}.${mac}`)).toBeNull();
  });

  it('throws without a session secret', () => {
    vi.stubEnv('SESSION_SECRET', '');
    expect(() => sign({})).toThrow('SESSION_SECRET');
  });
});

describe('isAllowlisted', () => {
  it('matches case-insensitively and trims', () => {
    expect(isAllowlisted(NATHAN_EMAIL)).toBe(true);
    expect(isAllowlisted('  ASHLEY@example.COM ')).toBe(true);
  });

  it('rejects anyone else', () => {
    expect(isAllowlisted('visitor@example.com')).toBe(false);
  });

  it('rejects everyone with an empty allowlist', () => {
    vi.stubEnv('ALLOWLIST_EMAILS', '');
    expect(isAllowlisted(NATHAN_EMAIL)).toBe(false);
  });
});

describe('isDemo', () => {
  it('matches demo accounts case-insensitively, and allowlisting wins', () => {
    vi.stubEnv('DEMO_EMAILS', 'Demo@Example.com, nathan@example.com');
    expect(isDemo(' demo@example.COM ')).toBe(true);
    expect(isDemo(NATHAN_EMAIL)).toBe(false);
    expect(isDemo('stranger@example.com')).toBe(false);
  });

  it('has no demo accounts when DEMO_EMAILS is unset', () => {
    vi.stubEnv('DEMO_EMAILS', '');
    expect(isDemo(DEMO_EMAIL)).toBe(false);
  });
});

describe('readSession', () => {
  const NOW = 1_800_000_000_000;

  it('reads a demo session as demo, not allowlisted', () => {
    vi.stubEnv('DEMO_EMAILS', DEMO_EMAIL);
    expect(readSession(sessionCookie(DEMO_EMAIL, NOW), NOW)).toEqual({
      email: DEMO_EMAIL,
      allowlisted: false,
      demo: true,
    });
  });

  it('reads a fresh allowlisted session', () => {
    const cookie = sessionCookie('Nathan@Example.com', NOW);
    expect(readSession(cookie, NOW + 1000)).toEqual({
      email: 'Nathan@Example.com',
      allowlisted: true,
      demo: false,
    });
  });

  it('reads a signed-in visitor as not allowlisted', () => {
    expect(readSession(sessionCookie('v@example.com', NOW), NOW)).toEqual({
      email: 'v@example.com',
      allowlisted: false,
      demo: false,
    });
  });

  it('expires after the session TTL', () => {
    const cookie = sessionCookie(NATHAN_EMAIL, NOW);
    expect(readSession(cookie, NOW + SESSION_TTL_SEC * 1000)).not.toBeNull();
    expect(readSession(cookie, NOW + SESSION_TTL_SEC * 1000 + 1)).toBeNull();
  });

  it('re-checks the allowlist on every read', () => {
    const cookie = sessionCookie(NATHAN_EMAIL, NOW);
    expect(readSession(cookie, NOW)?.allowlisted).toBe(true);
    vi.stubEnv('ALLOWLIST_EMAILS', 'ashley@example.com');
    expect(readSession(cookie, NOW)?.allowlisted).toBe(false);
  });

  it('rejects missing, garbage, and malformed cookies', () => {
    expect(readSession(undefined)).toBeNull();
    expect(readSession('garbage')).toBeNull();
    expect(readSession(sign({ email: 42, exp: NOW + 1000 }), NOW)).toBeNull();
    expect(readSession(sign(null), NOW)).toBeNull();
  });

  it('uses the current time by default', () => {
    expect(readSession(sessionCookie(NATHAN_EMAIL))).not.toBeNull();
    expect(readSession(sign({ email: NATHAN_EMAIL, exp: 1 }))).toBeNull();
  });
});

describe('newOAuthState', () => {
  it('carries a random nonce, purpose, and channel', () => {
    const a = newOAuthState('connect', 'nathan');
    const b = newOAuthState('sign-in', null);
    expect(a).toMatchObject({ purpose: 'connect', channel: 'nathan' });
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b.nonce).not.toBe(a.nonce);
  });
});

describe('oauthClient / authUrl', () => {
  it('builds the client with the callback redirect', () => {
    oauthClient(ORIGIN);
    expect(oauth.options).toEqual([
      { clientId: 'cid', clientSecret: 'csecret', redirectUri: `${ORIGIN}/auth/callback` },
    ]);
  });

  it('asks sign-in for identity only, online', () => {
    const state = newOAuthState('sign-in', null);
    const url = authUrl(ORIGIN, state);
    expect(url).toContain('accounts.google.com');
    expect(oauth.generateAuthUrl).toHaveBeenCalledWith({
      scope: SIGN_IN_SCOPES,
      state: state.nonce,
      access_type: 'online',
      prompt: 'select_account',
      include_granted_scopes: false,
    });
    expect(SIGN_IN_SCOPES).not.toContain('https://www.googleapis.com/auth/youtube.upload');
  });

  it('asks connect for upload scope offline with the chooser and forced consent', () => {
    const state = newOAuthState('connect', 'nathan');
    authUrl(ORIGIN, state);
    expect(oauth.generateAuthUrl).toHaveBeenCalledWith({
      scope: CHANNEL_SCOPES,
      state: state.nonce,
      access_type: 'offline',
      prompt: 'select_account consent',
      include_granted_scopes: false,
    });
    expect(CHANNEL_SCOPES).toContain('https://www.googleapis.com/auth/youtube.upload');
    expect(CHANNEL_SCOPES).toEqual(expect.arrayContaining(SIGN_IN_SCOPES));
  });

  it('requires the client secret', () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '');
    expect(() => authUrl(ORIGIN, newOAuthState('sign-in', null))).toThrow(
      'GOOGLE_OAUTH_CLIENT_SECRET',
    );
  });
});

describe('exchangeCode', () => {
  const ticket = (payload: unknown) => ({ getPayload: () => payload });

  it('returns the lowercased verified email and the refresh token', async () => {
    oauth.getToken.mockResolvedValueOnce({ tokens: { id_token: 'idt', refresh_token: 'rt' } });
    oauth.verifyIdToken.mockResolvedValueOnce(
      ticket({ email: 'Nathan@Example.COM', email_verified: true }),
    );
    expect(await exchangeCode(ORIGIN, 'code-1')).toEqual({
      email: NATHAN_EMAIL,
      refreshToken: 'rt',
    });
    expect(oauth.getToken).toHaveBeenCalledWith('code-1');
    expect(oauth.verifyIdToken).toHaveBeenCalledWith({ idToken: 'idt', audience: 'cid' });
  });

  it('returns a null refresh token for sign-in', async () => {
    oauth.getToken.mockResolvedValueOnce({ tokens: { id_token: 'idt' } });
    oauth.verifyIdToken.mockResolvedValueOnce(ticket({ email: 'a@b.c', email_verified: true }));
    expect((await exchangeCode(ORIGIN, 'c')).refreshToken).toBeNull();
  });

  it('throws when Google returns no ID token', async () => {
    oauth.getToken.mockResolvedValueOnce({ tokens: { refresh_token: 'rt' } });
    await expect(exchangeCode(ORIGIN, 'c')).rejects.toThrow('Google returned no ID token');
    expect(oauth.verifyIdToken).not.toHaveBeenCalled();
  });

  it('throws when the email is not verified', async () => {
    oauth.getToken.mockResolvedValueOnce({ tokens: { id_token: 'idt' } });
    oauth.verifyIdToken.mockResolvedValueOnce(ticket({ email: 'a@b.c', email_verified: false }));
    await expect(exchangeCode(ORIGIN, 'c')).rejects.toThrow('not verified');
  });

  it('throws when the payload has no email', async () => {
    oauth.getToken.mockResolvedValueOnce({ tokens: { id_token: 'idt' } });
    oauth.verifyIdToken.mockResolvedValueOnce(ticket(undefined));
    await expect(exchangeCode(ORIGIN, 'c')).rejects.toThrow('not verified');
  });

  it('propagates an invalid ID token', async () => {
    oauth.getToken.mockResolvedValueOnce({ tokens: { id_token: 'idt' } });
    oauth.verifyIdToken.mockRejectedValueOnce(new Error('Wrong recipient'));
    await expect(exchangeCode(ORIGIN, 'c')).rejects.toThrow('Wrong recipient');
  });
});
