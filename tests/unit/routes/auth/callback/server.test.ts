// @vitest-environment node
import { isRedirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { connections, invites, users } from '$lib/server/core/schema';
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
import { USER_A } from '../../../../helpers/pipeline';

const SUB = 'sub-new';
const EMAIL = 'new@example.com';

const h = vi.hoisted(() => ({ getToken: vi.fn(), verifyIdToken: vi.fn() }));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    getToken = h.getToken;
    verifyIdToken = h.verifyIdToken;
  },
}));

type Event = Parameters<typeof GET>[0];

const state = (patch: Partial<OAuthState> = {}): OAuthState => ({
  ...newOAuthState('sign-in', null),
  nonce: 'nonce-1',
  ...patch,
});

async function call(opts: { cookie?: string; query?: string; origin?: string }) {
  const cookies = {
    get: vi.fn((name: string) => (name === OAUTH_COOKIE ? opts.cookie : undefined)),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const event = {
    cookies,
    url: new URL(
      `${opts.origin ?? 'http://localhost'}/auth/callback${opts.query ?? '?code=c1&state=nonce-1'}`,
    ),
    locals: { user: null },
  } as unknown as Event;
  let thrown: unknown;
  try {
    await GET(event);
  } catch (error) {
    thrown = error;
  }
  return { thrown, cookies };
}

const google = (sub: string, email: string, verified = true) => {
  h.getToken.mockResolvedValue({ tokens: { id_token: 'idt' } });
  h.verifyIdToken.mockResolvedValue({
    getPayload: () => ({ sub, email, email_verified: verified, name: 'New' }),
  });
};

const redirectTo = (thrown: unknown) =>
  isRedirect(thrown) ? [thrown.status, thrown.location] : thrown;
const allUsers = () => db().select().from(users);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', 'secret');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-1');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'shh');
  vi.stubEnv('SIGNUP_MODE', 'invite');
  resetClients();
  await truncate();
  for (const fn of Object.values(h)) fn.mockReset();
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
    ['no state cookie', () => undefined],
    ['a forged state cookie', () => sign(state()).replace(/\.[^.]+$/, '.bad')],
    ['an expired state', () => sign(state({ exp: Date.now() - 1 }))],
    ['a connect state', () => sign(state({ purpose: 'connect', uid: USER_A.uid, sid: 's' }))],
  ])('sends %s back to sign in again', async (_label, cookie) => {
    const { thrown, cookies } = await call({ cookie: cookie() });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=expired']);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(h.getToken).not.toHaveBeenCalled();
  });

  it('sends a callback without a code back to sign in again', async () => {
    const { thrown } = await call({ cookie: sign(state()), query: '?state=nonce-1' });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=expired']);
  });
});

describe('GET /auth/callback: sign-in', () => {
  it('turns an uninvited account away, writing nothing', async () => {
    google(SUB, 'stranger@example.com');
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=denied']);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(await allUsers()).toEqual([]);
  });

  it("redeems the invite and sets a session at the new user's generation", async () => {
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
    expect(await db().select().from(connections)).toEqual([]);
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

  it('refuses an unverified Google email', async () => {
    await seed({ invites: [{ email: EMAIL }] });
    google(SUB, EMAIL, false);
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect((thrown as Error).message).toBe('Google account email is not verified');
    expect(cookies.set).not.toHaveBeenCalled();
    expect(await allUsers()).toEqual([]);
  });
});
