// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/brand/discard/+server';

const PROPOSAL_DOC = 'artists/flr/brand/proposal';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof POST>[0];
const discard = (allowlisted: boolean) =>
  POST({ locals: { session: { email: 'a@example.com', allowlisted } } } as unknown as Event);

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
  store.set(PROPOSAL_DOC, { statement: 's' });
});

describe('POST /api/brand/discard', () => {
  it('404s for a non-allowlisted session and keeps the proposal', async () => {
    const error = await Promise.resolve()
      .then(() => discard(false))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(store.has(PROPOSAL_DOC)).toBe(true);
  });

  it('drops the proposal', async () => {
    const response = await discard(true);
    expect(await response.json()).toEqual({ proposal: null });
    expect(store.has(PROPOSAL_DOC)).toBe(false);
  });

  it('succeeds when there is nothing to discard', async () => {
    store.clear();
    expect((await discard(true)).status).toBe(200);
  });
});
