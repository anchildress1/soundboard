// @vitest-environment node
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_COOKIE, readOAuthState } from '$lib/server/auth/auth';
import { GET } from '$routes/auth/login/+server';

type Event = Parameters<typeof GET>[0];

function call(query: string, origin = 'http://localhost:5173') {
  const cookies = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
  const event = {
    cookies,
    url: new URL(`${origin}/auth/login${query}`),
    locals: { user: null },
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

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'secret');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-1');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'shh');
});

describe('GET /auth/login', () => {
  it('signs in with identity scopes and stores a signed, expiring state cookie', () => {
    const { thrown, cookies } = call('');
    const url = location(thrown);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    );
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
    const { cookies } = call('', 'https://soundboard.run.app');
    expect(cookies.set.mock.calls[0]![2]).toMatchObject({ secure: true });
  });

  it.each(['nathan', 'sandbox', 'youtube'])('400s connect=%s for now', (value) => {
    const { thrown, cookies } = call(`?connect=${value}`);
    expect(isHttpError(thrown) && thrown.status).toBe(400);
    expect(cookies.set).not.toHaveBeenCalled();
  });
});
