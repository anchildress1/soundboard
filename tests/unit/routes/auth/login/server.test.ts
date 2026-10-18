// @vitest-environment node
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OAUTH_COOKIE,
  readOAuthState,
  readSession,
  SESSION_COOKIE,
  sessionCookie,
} from '$lib/server/auth/auth';
import { GET } from '$routes/auth/login/+server';
import { USER_A } from '../../../../helpers/pipeline';

type Event = Parameters<typeof GET>[0];
type User = Event['locals']['user'];

const SCOPES =
  'openid email https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

function call(query: string, opts: { origin?: string; user?: User; session?: string } = {}) {
  const cookies = {
    get: vi.fn((name: string) => (name === SESSION_COOKIE ? opts.session : undefined)),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const event = {
    cookies,
    url: new URL(`${opts.origin ?? 'http://localhost:5173'}/auth/login${query}`),
    locals: { user: opts.user ?? null },
  } as unknown as Event;
  let thrown: unknown;
  try {
    GET(event);
  } catch (error) {
    thrown = error;
  }
  return { thrown, cookies };
}

const location = (thrown: unknown) => {
  if (!isRedirect(thrown)) throw new Error('expected a redirect');
  expect(thrown.status).toBe(303);
  return new URL(thrown.location);
};

const status = (thrown: unknown) => isHttpError(thrown) && thrown.status;

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'secret');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-1');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'shh');
});

describe('GET /auth/login: sign-in', () => {
  it('asks for all four scopes offline with the chooser and a signed, expiring state', () => {
    const { thrown, cookies } = call('');
    const url = location(thrown);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe(SCOPES);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('login_hint')).toBeNull();
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/callback');

    expect(cookies.set).toHaveBeenCalledTimes(1);
    const [name, value, options] = cookies.set.mock.calls[0]!;
    expect(name).toBe(OAUTH_COOKIE);
    expect(options).toEqual({
      path: '/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 600,
    });
    const state = readOAuthState(value as string)!;
    expect(state).toMatchObject({ purpose: 'sign-in', uid: null, sid: null });
    expect(url.searchParams.get('state')).toBe(state.nonce);
  });

  it('marks the cookie secure over https', () => {
    const { cookies } = call('', { origin: 'https://soundboard.run.app' });
    expect(cookies.set.mock.calls[0]![2]).toMatchObject({ secure: true });
  });

  it('starts a plain sign-in even when already signed in', () => {
    const session = sessionCookie(USER_A.uid, 1);
    const { thrown, cookies } = call('', { user: USER_A, session });
    const url = location(thrown);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('login_hint')).toBeNull();
    expect(readOAuthState(cookies.set.mock.calls[0]![1] as string)).toMatchObject({
      purpose: 'sign-in',
      uid: null,
    });
  });
});

describe('GET /auth/login: connect', () => {
  it("forces consent, hints at the user's email and binds the state to the session", () => {
    const session = sessionCookie(USER_A.uid, 1);
    const { thrown, cookies } = call('?connect=youtube', { user: USER_A, session });
    const url = location(thrown);
    expect(url.searchParams.get('scope')).toBe(SCOPES);
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(url.searchParams.get('login_hint')).toBe(USER_A.email);
    const state = readOAuthState(cookies.set.mock.calls[0]![1] as string)!;
    expect(state).toMatchObject({
      purpose: 'connect',
      uid: USER_A.uid,
      sid: readSession(session)!.sid,
    });
  });

  it.each([
    ['without a session', null, undefined],
    ['with a user but no readable session cookie', USER_A, 'garbage'],
  ])('401s %s', (_label, user, session) => {
    const { thrown, cookies } = call('?connect=youtube', { user, session });
    expect(status(thrown)).toBe(401);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it.each(['nathan', 'sandbox', '', 'YouTube'])('400s connect=%s', (value) => {
    const session = sessionCookie(USER_A.uid, 1);
    const { thrown, cookies } = call(`?connect=${value}`, { user: USER_A, session });
    expect(status(thrown)).toBe(400);
    expect(cookies.set).not.toHaveBeenCalled();
  });
});
