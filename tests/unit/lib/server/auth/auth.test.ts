// @vitest-environment node
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authUrl,
  exchangeCode,
  newOAuthState,
  OAUTH_TTL_SEC,
  oauthClient,
  readOAuthState,
  readSession,
  SCOPES,
  SESSION_TTL_SEC,
  sessionCookie,
  sign,
  unsign,
} from '$lib/server/auth/auth';

const NATHAN_EMAIL = 'nathan@example.com';
const UID = 'sub-nathan';
const NOW = 1_800_000_000_000;

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

describe('sessionCookie / readSession', () => {
  it('round-trips the uid with a fixed 30-day expiry', () => {
    const session = readSession(sessionCookie(UID, NOW), NOW + 1000);
    expect(session).toEqual({
      uid: UID,
      sid: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      exp: NOW + SESSION_TTL_SEC * 1000,
    });
  });

  it('gives every sign-in its own sid', () => {
    const a = readSession(sessionCookie(UID, NOW), NOW);
    const b = readSession(sessionCookie(UID, NOW), NOW);
    expect(a!.sid).not.toBe(b!.sid);
  });

  it('rejects a tampered session', () => {
    const [, mac] = sessionCookie(UID, NOW).split('.');
    const forged = Buffer.from(
      JSON.stringify({ uid: 'someone-else', sid: 's', exp: NOW + 1000 }),
    ).toString('base64url');
    expect(readSession(`${forged}.${mac}`, NOW)).toBeNull();
  });

  it('expires at exp, never sliding', () => {
    const cookie = sessionCookie(UID, NOW);
    expect(readSession(cookie, NOW + SESSION_TTL_SEC * 1000 - 1)).not.toBeNull();
    expect(readSession(cookie, NOW + SESSION_TTL_SEC * 1000)).toBeNull();
  });

  it.each([
    ['no uid', { sid: 's', exp: NOW + 1000 }],
    ['an empty uid', { uid: '', sid: 's', exp: NOW + 1000 }],
    ['a numeric uid', { uid: 42, sid: 's', exp: NOW + 1000 }],
    ['the old email-only shape', { email: NATHAN_EMAIL, exp: NOW + 1000 }],
    ['no sid', { uid: UID, exp: NOW + 1000 }],
    ['no expiry', { uid: UID, sid: 's' }],
    ['null', null],
  ])('rejects a payload with %s', (_label, payload) => {
    expect(readSession(sign(payload), NOW)).toBeNull();
  });

  it('ignores an extra field such as a legacy generation', () => {
    expect(readSession(sign({ uid: UID, sid: 's', gen: 1, exp: NOW + 1000 }), NOW)).toEqual({
      uid: UID,
      sid: 's',
      exp: NOW + 1000,
    });
  });

  it('rejects missing and garbage cookies', () => {
    expect(readSession(undefined)).toBeNull();
    expect(readSession('garbage')).toBeNull();
  });

  it('uses the current time by default', () => {
    expect(readSession(sessionCookie(UID))).not.toBeNull();
    expect(readSession(sign({ uid: UID, sid: 's', exp: 1 }))).toBeNull();
  });
});

describe('newOAuthState / readOAuthState', () => {
  it('carries a random nonce, purpose, and the starting session, for 10 minutes', () => {
    const a = newOAuthState('connect', { uid: UID, sid: 'sid-1' }, NOW);
    const b = newOAuthState('sign-in', null, NOW);
    expect(a).toEqual({
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      purpose: 'connect',
      uid: UID,
      sid: 'sid-1',
      exp: NOW + OAUTH_TTL_SEC * 1000,
    });
    expect(b).toMatchObject({ purpose: 'sign-in', uid: null, sid: null });
    expect(b.nonce).not.toBe(a.nonce);
    expect(OAUTH_TTL_SEC).toBe(600);
  });

  it('reads a fresh state back', () => {
    const state = newOAuthState('sign-in', null, NOW);
    expect(readOAuthState(sign(state), NOW + 1000)).toEqual(state);
  });

  it('expires after 10 minutes', () => {
    const cookie = sign(newOAuthState('sign-in', null, NOW));
    expect(readOAuthState(cookie, NOW + OAUTH_TTL_SEC * 1000 - 1)).not.toBeNull();
    expect(readOAuthState(cookie, NOW + OAUTH_TTL_SEC * 1000)).toBeNull();
  });

  it('rejects missing, tampered and malformed states', () => {
    expect(readOAuthState(undefined, NOW)).toBeNull();
    const [body] = sign(newOAuthState('sign-in', null, NOW)).split('.');
    expect(readOAuthState(`${body}.forged`, NOW)).toBeNull();
    expect(readOAuthState(sign({ purpose: 'sign-in', exp: NOW + 1000 }), NOW)).toBeNull();
    expect(readOAuthState(sign({ nonce: 'n', purpose: 'sign-in' }), NOW)).toBeNull();
  });

  it('uses the current time by default', () => {
    expect(readOAuthState(sign(newOAuthState('sign-in', null)))).not.toBeNull();
  });
});

describe('oauthClient / authUrl', () => {
  it('builds the client with the callback redirect', () => {
    oauthClient(ORIGIN);
    expect(oauth.options).toEqual([
      { clientId: 'cid', clientSecret: 'csecret', redirectUri: `${ORIGIN}/auth/callback` },
    ]);
  });

  it('asks sign-in for identity and YouTube offline in one consent, with the chooser', () => {
    const state = newOAuthState('sign-in', null);
    const url = authUrl(ORIGIN, state, NATHAN_EMAIL);
    expect(url).toContain('accounts.google.com');
    expect(oauth.generateAuthUrl).toHaveBeenCalledWith({
      scope: SCOPES,
      state: state.nonce,
      access_type: 'offline',
      include_granted_scopes: true,
      prompt: 'select_account',
    });
    expect(SCOPES).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ]);
  });

  it('forces consent on connect and hints at the user account', () => {
    const state = newOAuthState('connect', { uid: UID, sid: 'sid-1' });
    authUrl(ORIGIN, state, NATHAN_EMAIL);
    expect(oauth.generateAuthUrl).toHaveBeenCalledWith({
      scope: SCOPES,
      state: state.nonce,
      access_type: 'offline',
      include_granted_scopes: true,
      prompt: 'select_account consent',
      login_hint: NATHAN_EMAIL,
    });
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
  const VERIFIED = { sub: UID, email: 'a@b.c', email_verified: true };

  it('returns the verified identity, granted scopes and both tokens', async () => {
    oauth.getToken.mockResolvedValueOnce({
      tokens: {
        id_token: 'idt',
        access_token: 'at',
        refresh_token: 'rt',
        scope: 'openid email  https://www.googleapis.com/auth/youtube.upload',
      },
    });
    oauth.verifyIdToken.mockResolvedValueOnce(
      ticket({ sub: UID, email: 'Nathan@Example.COM', email_verified: true, name: 'Nathan' }),
    );
    expect(await exchangeCode(ORIGIN, 'code-1')).toEqual({
      sub: UID,
      email: NATHAN_EMAIL,
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/youtube.upload'],
      refreshToken: 'rt',
      accessToken: 'at',
    });
    expect(oauth.getToken).toHaveBeenCalledWith('code-1');
    expect(oauth.verifyIdToken).toHaveBeenCalledWith({ idToken: 'idt', audience: 'cid' });
  });

  it('returns no refresh token or scopes when Google sends none', async () => {
    oauth.getToken.mockResolvedValueOnce({ tokens: { id_token: 'idt', access_token: 'at' } });
    oauth.verifyIdToken.mockResolvedValueOnce(ticket(VERIFIED));
    expect(await exchangeCode(ORIGIN, 'c')).toMatchObject({
      refreshToken: null,
      scopes: [],
    });
  });

  it.each([
    ['no ID token', { access_token: 'at' }],
    ['no access token', { id_token: 'idt' }],
  ])('throws when Google returns %s', async (_label, tokens) => {
    oauth.getToken.mockResolvedValueOnce({ tokens });
    await expect(exchangeCode(ORIGIN, 'c')).rejects.toThrow('Google returned no tokens');
    expect(oauth.verifyIdToken).not.toHaveBeenCalled();
  });

  it('returns null for a used or expired code', async () => {
    oauth.getToken.mockRejectedValueOnce(
      Object.assign(new Error('Bad Request'), { response: { data: { error: 'invalid_grant' } } }),
    );
    expect(await exchangeCode(ORIGIN, 'c')).toBeNull();
    expect(oauth.verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    ['a network failure', new Error('ECONNRESET')],
    [
      'another token error',
      Object.assign(new Error('Unauthorized'), { response: { data: { error: 'invalid_client' } } }),
    ],
  ])('propagates %s in the code exchange', async (_label, error) => {
    oauth.getToken.mockRejectedValueOnce(error);
    await expect(exchangeCode(ORIGIN, 'c')).rejects.toBe(error);
  });

  it.each([
    ['an unverified email', ticket({ ...VERIFIED, email_verified: false })],
    ['no email', ticket({ sub: UID, email_verified: true })],
    ['no payload', ticket(undefined)],
  ])('returns null for %s', async (_label, result) => {
    oauth.getToken.mockResolvedValueOnce({ tokens: { id_token: 'idt', access_token: 'at' } });
    oauth.verifyIdToken.mockResolvedValueOnce(result);
    expect(await exchangeCode(ORIGIN, 'c')).toBeNull();
  });

  it('propagates an ID token that fails verification', async () => {
    oauth.getToken.mockResolvedValueOnce({ tokens: { id_token: 'idt', access_token: 'at' } });
    oauth.verifyIdToken.mockRejectedValueOnce(new Error('Wrong recipient'));
    await expect(exchangeCode(ORIGIN, 'c')).rejects.toThrow('Wrong recipient');
  });
});
