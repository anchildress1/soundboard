// @vitest-environment node
import { captureException, captureMessage } from '@sentry/sveltekit';
import { isRedirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { connections, invites, jobs, users } from '$lib/server/core/schema';
import {
  newOAuthState,
  OAUTH_COOKIE,
  readSession,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  sign,
  type OAuthState,
} from '$lib/server/auth/auth';
import { GET } from '$routes/auth/callback/+server';
import { seed, truncate } from '../../../../helpers/db';
import { CHANNEL_A, seedJob, USER_A, USER_B, USERS } from '../../../../helpers/pipeline';

const SUB = 'sub-new';
const EMAIL = 'new@example.com';
const UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const READ = 'https://www.googleapis.com/auth/youtube.readonly';
const FULL = ['openid', 'email', UPLOAD, READ];
const CHANNEL = { id: 'UCnew', title: 'New Channel' };
const CONSENT = '/auth/login?connect=youtube';
const MISMATCH = '/connections?connect=mismatch';

const h = vi.hoisted(() => ({ getToken: vi.fn(), verifyIdToken: vi.fn(), encrypt: vi.fn() }));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    getToken = h.getToken;
    verifyIdToken = h.verifyIdToken;
  },
}));

vi.mock('@google-cloud/kms', () => ({
  KeyManagementServiceClient: class {
    encrypt = h.encrypt;
  },
}));

const fetchMock = vi.fn<typeof fetch>();

type Event = Parameters<typeof GET>[0];
type User = Event['locals']['user'];

const state = (patch: Partial<OAuthState> = {}): OAuthState => ({
  ...newOAuthState('sign-in', null),
  nonce: 'nonce-1',
  ...patch,
});

async function call(opts: { cookie?: string; query?: string; origin?: string; user?: User } = {}) {
  const jar: Record<string, string | undefined> = { [OAUTH_COOKIE]: opts.cookie };
  const cookies = { get: vi.fn((name: string) => jar[name]), set: vi.fn(), delete: vi.fn() };
  const event = {
    cookies,
    url: new URL(
      `${opts.origin ?? 'http://localhost'}/auth/callback${opts.query ?? '?code=c1&state=nonce-1'}`,
    ),
    locals: { user: opts.user ?? null },
  } as unknown as Event;
  let thrown: unknown;
  try {
    await GET(event);
  } catch (error) {
    thrown = error;
  }
  return { thrown, cookies };
}

/** Google's answer to the code exchange: the verified identity and what was granted. */
function google(
  sub: string,
  email: string,
  opts: { verified?: boolean; scopes?: string[]; refresh?: string | null } = {},
) {
  h.getToken.mockResolvedValue({
    tokens: {
      id_token: 'idt',
      access_token: 'at',
      scope: (opts.scopes ?? FULL).join(' '),
      ...(opts.refresh === null ? {} : { refresh_token: opts.refresh ?? 'rt-new' }),
    },
  });
  h.verifyIdToken.mockResolvedValue({
    getPayload: () => ({ sub, email, email_verified: opts.verified ?? true, name: 'New' }),
  });
}

/** What `channels.list?mine=true` returns for the granted account. */
const channel = (item: typeof CHANNEL | null) =>
  fetchMock.mockImplementation(async () =>
    Response.json({ items: item ? [{ id: item.id, snippet: { title: item.title } }] : [] }),
  );

const redirectTo = (thrown: unknown) =>
  isRedirect(thrown) ? [thrown.status, thrown.location] : thrown;
const allUsers = () => db().select().from(users);
const allConnections = () => db().select().from(connections);
const connectionOf = async (uid: string) =>
  (await db().select().from(connections).where(eq(connections.uid, uid)))[0];

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', 'secret');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-1');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'shh');
  vi.stubEnv('SIGNUP_MODE', 'invite');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  resetClients();
  await truncate();
  for (const fn of Object.values(h)) fn.mockReset();
  vi.mocked(captureException).mockClear();
  vi.mocked(captureMessage).mockClear();
  h.encrypt.mockImplementation(async ({ plaintext }: { plaintext: Buffer }) => [
    { ciphertext: Buffer.concat([Buffer.from('sealed:'), plaintext]) },
  ]);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  channel(CHANNEL);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /auth/callback: state checks', () => {
  it('sends a mismatched state back to sign in again, without calling Google', async () => {
    const { thrown, cookies } = await call({
      cookie: sign(state()),
      query: '?code=c1&state=other',
    });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=expired']);
    expect(cookies.delete).toHaveBeenCalledWith(OAUTH_COOKIE, { path: '/auth' });
    expect(h.getToken).not.toHaveBeenCalled();
  });

  it.each([
    ['no state cookie (or a replay after its first use)', () => undefined],
    ['a forged state cookie', () => sign(state()).replace(/\.[^.]+$/, '.bad')],
    ['an expired state', () => sign(state({ exp: Date.now() - 1 }))],
  ])('sends %s back to sign in again', async (_label, cookie) => {
    const { thrown, cookies } = await call({ cookie: cookie() });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=expired']);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(h.getToken).not.toHaveBeenCalled();
  });

  it('sends a cancelled consent back to sign in again, writing nothing', async () => {
    await seed({ invites: [{ email: EMAIL }] });
    const { thrown, cookies } = await call({
      cookie: sign(state()),
      query: '?error=access_denied&state=nonce-1',
    });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=expired']);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(h.getToken).not.toHaveBeenCalled();
    expect(await allUsers()).toEqual([]);
    expect(await allConnections()).toEqual([]);
  });

  it('sends a callback without a code back to sign in again', async () => {
    const { thrown } = await call({ cookie: sign(state()), query: '?state=nonce-1' });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=expired']);
    expect(h.getToken).not.toHaveBeenCalled();
  });

  it('consumes the state on first read, so the same callback cannot run twice', async () => {
    await seed({ invites: [{ email: EMAIL }] });
    google(SUB, EMAIL);
    const { cookies } = await call({ cookie: sign(state()) });
    expect(cookies.delete).toHaveBeenCalledWith(OAUTH_COOKIE, { path: '/auth' });
    const replay = await call();
    expect(redirectTo(replay.thrown)).toEqual([303, '/?signin=expired']);
    expect(h.getToken).toHaveBeenCalledTimes(1);
  });
});

describe('GET /auth/callback: sign-in', () => {
  it("redeems the invite, sets a session at the new user's generation, and connects YouTube", async () => {
    await seed({ invites: [{ email: EMAIL, artistId: null }] });
    google(SUB, EMAIL);
    const { thrown, cookies } = await call({
      cookie: sign(state()),
      origin: 'https://soundboard.run.app',
    });
    expect(redirectTo(thrown)).toEqual([303, '/']);
    expect(cookies.set).toHaveBeenCalledTimes(1);
    const [name, value, options] = cookies.set.mock.calls[0]!;
    expect(name).toBe(SESSION_COOKIE);
    expect(options).toEqual({
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_SEC,
    });
    expect(readSession(value as string)).toMatchObject({ uid: SUB, gen: 1 });
    expect(await allUsers()).toEqual([
      expect.objectContaining({ uid: SUB, email: EMAIL, name: 'New', inviteEmail: EMAIL }),
    ]);
    const [invite] = await db().select().from(invites);
    expect(invite!.boundSub).toBe(SUB);

    expect(await connectionOf(SUB)).toMatchObject({
      status: 'connected',
      channelId: CHANNEL.id,
      channelTitle: CHANNEL.title,
      scopes: FULL,
      tokenCiphertext: Buffer.from('sealed:rt-new').toString('base64'),
    });
    expect(h.encrypt).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get('mine')).toBe('true');
    expect(init?.headers).toEqual({ authorization: 'Bearer at' });
  });

  it('gives every sign-in a new session id', async () => {
    await seed(USERS);
    google(USER_A.uid, USER_A.email);
    const first = await call({ cookie: sign(state()) });
    const second = await call({ cookie: sign(state()) });
    const sid = (c: typeof first) => readSession(c.cookies.set.mock.calls[0]![1] as string)!.sid;
    expect(sid(first)).not.toBe(sid(second));
  });

  it("refreshes a returning user's profile and keeps their generation", async () => {
    await seed({
      invites: [{ email: EMAIL, artistId: 'flr', boundSub: SUB }],
      users: [{ uid: SUB, email: EMAIL, inviteEmail: EMAIL, artistId: 'flr', accessGeneration: 4 }],
    });
    google(SUB, 'changed@example.com');
    const { cookies } = await call({ cookie: sign(state()) });
    expect(readSession(cookies.set.mock.calls[0]![1] as string)).toMatchObject({
      uid: SUB,
      gen: 4,
    });
    const [user] = await db().select().from(users).where(eq(users.uid, SUB));
    expect(user).toMatchObject({ email: 'changed@example.com', name: 'New', accessGeneration: 4 });
  });

  it('sends an unverified Google email back to sign in again, writing nothing', async () => {
    await seed({ invites: [{ email: EMAIL }] });
    google(SUB, EMAIL, { verified: false });
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=expired']);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(await allUsers()).toEqual([]);
  });

  it('sends a used or expired code back to sign in again, writing nothing', async () => {
    await seed({ invites: [{ email: EMAIL }] });
    h.getToken.mockRejectedValue(
      Object.assign(new Error('Bad Request'), { response: { data: { error: 'invalid_grant' } } }),
    );
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=expired']);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(await allUsers()).toEqual([]);
    expect(await allConnections()).toEqual([]);
  });

  it('fails loudly when the ID token fails verification, writing nothing', async () => {
    await seed({ invites: [{ email: EMAIL }] });
    google(SUB, EMAIL);
    h.verifyIdToken.mockRejectedValue(new Error('Wrong recipient'));
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect((thrown as Error).message).toBe('Wrong recipient');
    expect(cookies.set).not.toHaveBeenCalled();
    expect(await allUsers()).toEqual([]);
  });

  it('fails loudly when the code exchange fails for another reason', async () => {
    await seed({ invites: [{ email: EMAIL }] });
    h.getToken.mockRejectedValue(new Error('ECONNRESET'));
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect((thrown as Error).message).toBe('ECONNRESET');
    expect(cookies.set).not.toHaveBeenCalled();
  });
});

describe('GET /auth/callback: evaluating YouTube on sign-in', () => {
  beforeEach(async () => {
    await seed(USERS);
  });

  it.each([
    ['read-only', ['openid', 'email', READ]],
    ['upload-only', ['openid', 'email', UPLOAD]],
    ['neither-scope', ['openid', 'email']],
  ])('records a %s grant as missing_scopes, without a token', async (_label, scopes) => {
    google(USER_B.uid, USER_B.email, { scopes });
    const { thrown } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/']);
    expect(await connectionOf(USER_B.uid)).toMatchObject({
      status: 'missing_scopes',
      channelId: null,
      scopes,
      tokenCiphertext: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.encrypt).not.toHaveBeenCalled();
  });

  it('records an account without a channel as no_channel', async () => {
    channel(null);
    google(USER_B.uid, USER_B.email);
    await call({ cookie: sign(state()) });
    expect(await connectionOf(USER_B.uid)).toMatchObject({
      status: 'no_channel',
      channelId: null,
      tokenCiphertext: null,
    });
    expect(h.encrypt).not.toHaveBeenCalled();
  });

  it.each([
    ['missing scopes', () => google(USER_A.uid, USER_A.email, { scopes: ['openid', 'email'] })],
    ['no channel', () => (channel(null), google(USER_A.uid, USER_A.email))],
    [
      'no refresh token and another channel',
      () => (channel(CHANNEL), google(USER_A.uid, USER_A.email, { refresh: null })),
    ],
  ])('never erases a connected grant on %s', async (_label, grant) => {
    const before = await connectionOf(USER_A.uid);
    grant();
    const { thrown } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/']);
    expect(await connectionOf(USER_A.uid)).toEqual(before);
  });

  it('keeps the stored grant when no refresh token came back for the same channel', async () => {
    const before = await connectionOf(USER_A.uid);
    channel({ id: CHANNEL_A, title: 'Flies Like Robots' });
    google(USER_A.uid, USER_A.email, { refresh: null });
    const { thrown } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/']);
    expect(await connectionOf(USER_A.uid)).toEqual(before);
    expect(h.encrypt).not.toHaveBeenCalled();
  });

  it('replaces the grant when a refresh token came back', async () => {
    channel({ id: CHANNEL_A, title: 'Flies Like Robots' });
    google(USER_A.uid, USER_A.email, { refresh: 'rt-2' });
    await call({ cookie: sign(state()) });
    expect(await connectionOf(USER_A.uid)).toMatchObject({
      status: 'connected',
      channelId: CHANNEL_A,
      tokenCiphertext: Buffer.from('sealed:rt-2').toString('base64'),
    });
  });

  it('sends a signed-in user with no refresh token and no grant on to forced consent', async () => {
    google(USER_B.uid, USER_B.email, { refresh: null });
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, CONSENT]);
    expect(readSession(cookies.set.mock.calls[0]![1] as string)).toMatchObject({
      uid: USER_B.uid,
    });
    expect(await connectionOf(USER_B.uid)).toBeUndefined();
  });

  it('never revives a revoked connection on sign-in without a new refresh token', async () => {
    await db()
      .update(connections)
      .set({ status: 'revoked', tokenCiphertext: null })
      .where(eq(connections.uid, USER_A.uid));
    const before = await connectionOf(USER_A.uid);
    channel({ id: CHANNEL_A, title: 'Flies Like Robots' });
    google(USER_A.uid, USER_A.email, { refresh: null });
    const { thrown } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, CONSENT]);
    expect(await connectionOf(USER_A.uid)).toEqual(before);
  });

  it('signs the user in unconnected when YouTube fails, reporting it', async () => {
    const before = await allConnections();
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    google(USER_B.uid, USER_B.email);
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/']);
    expect(readSession(cookies.set.mock.calls[0]![1] as string)).toMatchObject({
      uid: USER_B.uid,
    });
    expect(await allConnections()).toEqual(before);
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('channels.list 500') }),
      { tags: { component: 'sign-in-connect' } },
    );
  });

  it('signs the user in unconnected when KMS fails, reporting it', async () => {
    h.encrypt.mockRejectedValue(new Error('PERMISSION_DENIED'));
    google(USER_B.uid, USER_B.email);
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/']);
    expect(cookies.set).toHaveBeenCalledTimes(1);
    expect(await connectionOf(USER_B.uid)).toBeUndefined();
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'PERMISSION_DENIED' }),
      { tags: { component: 'sign-in-connect' } },
    );
  });
});

describe('GET /auth/callback: denied sign-in', () => {
  it('turns an uninvited account away, writing nothing', async () => {
    google(SUB, 'stranger@example.com');
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=denied']);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(await allUsers()).toEqual([]);
    expect(await allConnections()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.encrypt).not.toHaveBeenCalled();
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith('Sign-in denied', { level: 'info' });
    expect(JSON.stringify(vi.mocked(captureMessage).mock.calls)).not.toContain('stranger');
  });

  it('denies an invite already bound to another account', async () => {
    await seed({ invites: [{ email: EMAIL, boundSub: 'sub-other' }] });
    google(SUB, EMAIL);
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=denied']);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(await allUsers()).toEqual([]);
    expect(await allConnections()).toEqual([]);
    const [invite] = await db().select().from(invites);
    expect(invite!.boundSub).toBe('sub-other');
  });

  it('denies a revoked invite', async () => {
    await seed({ invites: [{ email: EMAIL, active: false }] });
    google(SUB, EMAIL);
    const { thrown } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=denied']);
    expect(await allUsers()).toEqual([]);
  });

  it('keeps jobs and artist link when a bound user signs in with a changed email', async () => {
    await seed(USERS);
    await seedJob({ id: 'job-a', ownerUid: USER_A.uid, artistId: 'flr' });
    google(USER_A.uid, 'renamed@example.com', { refresh: null });
    channel({ id: CHANNEL_A, title: 'Flies Like Robots' });
    const { thrown } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/']);
    const [user] = await db().select().from(users).where(eq(users.uid, USER_A.uid));
    expect(user).toMatchObject({ email: 'renamed@example.com', artistId: 'flr' });
    const [job] = await db().select().from(jobs).where(eq(jobs.id, 'job-a'));
    expect(job).toMatchObject({ ownerUid: USER_A.uid, artistId: 'flr' });
  });
});

describe('GET /auth/callback: connect', () => {
  const connectState = (user: { uid: string; sid: string } = USER_A) =>
    sign(state({ purpose: 'connect', uid: user.uid, sid: user.sid }));

  beforeEach(async () => {
    await seed(USERS);
  });

  it('re-grants the channel for the session that started it', async () => {
    channel({ id: 'UCother', title: 'Other' });
    google(USER_A.uid, USER_A.email, { refresh: 'rt-2' });
    const { thrown, cookies } = await call({ cookie: connectState(), user: USER_A });
    expect(redirectTo(thrown)).toEqual([303, '/connections']);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(await connectionOf(USER_A.uid)).toMatchObject({
      status: 'connected',
      channelId: 'UCother',
      channelTitle: 'Other',
      tokenCiphertext: Buffer.from('sealed:rt-2').toString('base64'),
    });
  });

  it.each<[string, User]>([
    ['signed out', null],
    ['a session for another user', USER_B],
    ['a stale callback after sign-out and back in', { ...USER_A, sid: 'sid-later' }],
  ])('rejects %s as a mismatch, changing nothing', async (_label, user) => {
    const before = await allConnections();
    google(USER_A.uid, USER_A.email);
    const { thrown } = await call({ cookie: connectState(), user });
    expect(redirectTo(thrown)).toEqual([303, MISMATCH]);
    expect(h.getToken).not.toHaveBeenCalled();
    expect(await allConnections()).toEqual(before);
  });

  it("rejects a grant from another Google account, keeping the user's connection", async () => {
    const before = await allConnections();
    google(USER_B.uid, USER_B.email);
    const { thrown } = await call({ cookie: connectState(), user: USER_A });
    expect(redirectTo(thrown)).toEqual([303, '/connections?connect=wrong-account']);
    expect(await allConnections()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the stored connection when the reconnect fails, reporting why', async () => {
    const before = await connectionOf(USER_A.uid);
    google(USER_A.uid, USER_A.email, { scopes: ['openid', 'email', READ] });
    const { thrown } = await call({ cookie: connectState(), user: USER_A });
    expect(redirectTo(thrown)).toEqual([303, '/connections?connect=missing_scopes']);
    expect(await connectionOf(USER_A.uid)).toEqual(before);
  });

  it('reports a reconnect to an account without a channel', async () => {
    channel(null);
    google(USER_B.uid, USER_B.email);
    const { thrown } = await call({ cookie: connectState(USER_B), user: USER_B });
    expect(redirectTo(thrown)).toEqual([303, '/connections?connect=no_channel']);
    expect(await connectionOf(USER_B.uid)).toMatchObject({ status: 'no_channel' });
  });

  it('lands on Connections when a reconnect without a refresh token keeps the same channel', async () => {
    channel({ id: CHANNEL_A, title: 'Flies Like Robots' });
    google(USER_A.uid, USER_A.email, { refresh: null });
    const { thrown } = await call({ cookie: connectState(), user: USER_A });
    expect(redirectTo(thrown)).toEqual([303, '/connections']);
  });

  it('records missing_scopes rather than looping when a connect brings no refresh token', async () => {
    google(USER_B.uid, USER_B.email, { refresh: null });
    const { thrown } = await call({ cookie: connectState(USER_B), user: USER_B });
    expect(redirectTo(thrown)).toEqual([303, '/connections?connect=missing_scopes']);
    expect(await connectionOf(USER_B.uid)).toMatchObject({
      status: 'missing_scopes',
      tokenCiphertext: null,
    });
  });

  it('sends an unverified grant back to sign in again', async () => {
    google(USER_A.uid, USER_A.email, { verified: false });
    const { thrown } = await call({ cookie: connectState(), user: USER_A });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=expired']);
  });
});
