// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore } from '../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/brand/propose/+server';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof POST>[0];
const propose = (allowlisted: boolean | null) =>
  POST({
    locals: { session: allowlisted === null ? null : { email: 'a@example.com', allowlisted } },
  } as unknown as Event);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/brand/propose', () => {
  it.each([null, false])(
    '404s for session allowlisted=%s without touching the model',
    async (allowlisted) => {
      const error = await Promise.resolve()
        .then(() => propose(allowlisted))
        .catch((e: unknown) => e);
      expect(isHttpError(error) && error.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('answers a wait while the model loads', async () => {
    fetchMock.mockResolvedValue(new Response('loading', { status: 503 }));
    const response = await propose(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wait: 'waking model' });
  });
});
