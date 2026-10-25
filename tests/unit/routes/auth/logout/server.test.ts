// @vitest-environment node
import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { OAUTH_COOKIE, SESSION_COOKIE } from '#lib/server/auth/auth.js';
import { POST } from '#src/routes/auth/logout/+server.js';

type Event = Parameters<typeof POST>[0];

function call() {
  const cookies = { delete: vi.fn(), set: vi.fn() };
  let thrown: unknown;
  try {
    POST({ cookies } as unknown as Event);
  } catch (error) {
    thrown = error;
  }
  return { thrown, cookies };
}

describe('POST /auth/logout', () => {
  it('drops the session and any pending OAuth state, then redirects home', () => {
    const { thrown, cookies } = call();
    expect(isRedirect(thrown) && [thrown.status, thrown.location]).toEqual([303, '/']);
    expect(cookies.delete).toHaveBeenCalledWith(SESSION_COOKIE, { path: '/' });
    expect(cookies.delete).toHaveBeenCalledWith(OAUTH_COOKIE, { path: '/auth' });
    expect(cookies.delete).toHaveBeenCalledTimes(2);
    expect(cookies.set).not.toHaveBeenCalled();
  });
});
