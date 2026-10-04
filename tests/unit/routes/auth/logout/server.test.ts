// @vitest-environment node
import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '$lib/server/auth';
import { POST } from '$routes/auth/logout/+server';

type Event = Parameters<typeof POST>[0];

describe('POST /auth/logout', () => {
  it('drops the session cookie and redirects home', () => {
    const cookies = { delete: vi.fn(), set: vi.fn() };
    let thrown: unknown;
    try {
      POST({ cookies } as unknown as Event);
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown) && [thrown.status, thrown.location]).toEqual([303, '/']);
    expect(cookies.delete).toHaveBeenCalledWith(SESSION_COOKIE, { path: '/' });
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('is harmless when already signed out', () => {
    const cookies = { delete: vi.fn() };
    expect(() => POST({ cookies } as unknown as Event)).toThrow();
    expect(cookies.delete).toHaveBeenCalledTimes(1);
  });
});
