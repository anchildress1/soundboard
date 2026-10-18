// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { POST } from '$routes/api/brand/propose/+server';
import { USER_A, USER_B } from '../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];
const propose = (user: typeof USER_A | typeof USER_B | null) =>
  POST({ locals: { user } } as unknown as Event);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  resetClients();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/brand/propose', () => {
  it.each([
    ['signed out', null],
    ['an unlinked user', USER_B],
  ])('404s when %s without touching the model', async (_label, user) => {
    const error = await Promise.resolve()
      .then(() => propose(user))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a wait while the model loads', async () => {
    fetchMock.mockResolvedValue(new Response('loading', { status: 503 }));
    const response = await propose(USER_A);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wait: 'waking model' });
  });
});
