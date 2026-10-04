// @vitest-environment node
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_COOKIE, unsign, type OAuthState } from '$lib/server/auth';
import { GET } from '$routes/auth/login/+server';

type Event = Parameters<typeof GET>[0];

function call(query: string, allowlisted: boolean | null, origin = 'http://localhost:5173') {
  const cookies = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
  const event = {
    cookies,
    url: new URL(`${origin}/auth/login${query}`),
    locals: {
      session: allowlisted === null ? null : { allowlisted, email: 'nathan@example.com' },
    },
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
  it('signs in with identity scopes only and stores a signed state cookie', () => {
    const { thrown, cookies } = call('', null);
    const url = location(thrown);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/callback');
    expect(url.searchParams.get('access_type')).toBe('online');

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
    const state = unsign<OAuthState>(value as string)!;
    expect(state).toMatchObject({ purpose: 'sign-in', channel: null });
    expect(url.searchParams.get('state')).toBe(state.nonce);
  });

  it('marks the cookie secure over https', () => {
    const { cookies } = call('', null, 'https://soundboard.run.app');
    expect(cookies.set.mock.calls[0]![2]).toMatchObject({ secure: true });
  });

  it.each(['nathan', 'sandbox'] as const)(
    'lets an allowlisted session connect the %s channel offline',
    (channel) => {
      const { thrown, cookies } = call(`?connect=${channel}`, true);
      const url = location(thrown);
      expect(url.searchParams.get('scope')).toContain('youtube.upload');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('select_account consent');
      const state = unsign<OAuthState>(cookies.set.mock.calls[0]![1] as string);
      expect(state).toMatchObject({ purpose: 'connect', channel });
    },
  );

  it('400s an unknown channel', () => {
    const { thrown, cookies } = call('?connect=elsewhere', true);
    expect(isHttpError(thrown) && thrown.status).toBe(400);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('403s a connect from a non-allowlisted session', () => {
    const stranger = call('?connect=nathan', false);
    expect(isHttpError(stranger.thrown) && stranger.thrown.status).toBe(403);
    const signedOut = call('?connect=nathan', null);
    expect(isHttpError(signedOut.thrown) && signedOut.thrown.status).toBe(403);
    expect(signedOut.cookies.set).not.toHaveBeenCalled();
  });
});
