// @vitest-environment node
import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { GET } from '$routes/auth/signed-out/+server';

type Event = Parameters<typeof GET>[0];

describe('GET /auth/signed-out', () => {
  it('redirects home', () => {
    let thrown: unknown;
    try {
      GET({} as Event);
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown) && [thrown.status, thrown.location]).toEqual([303, '/']);
  });
});
