// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/brand/approve/+server';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof POST>[0];
const GUIDE = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: [] };

const approve = (body: string, allowlisted = true) =>
  POST({
    locals: { session: { email: 'a@example.com', allowlisted } },
    request: new Request('https://soundboard.test/api/brand/approve', { method: 'POST', body }),
  } as unknown as Event);

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
  store.set('artists/flr/brand/proposal', {
    ...GUIDE,
    status: 'PROPOSED',
    basedOn: ['v1'],
    createdAt: 1,
    approvedAt: null,
  });
});

describe('POST /api/brand/approve', () => {
  it('404s for a non-allowlisted session and leaves the proposal', async () => {
    const error = await Promise.resolve()
      .then(() => approve(JSON.stringify({ ...GUIDE, proposedAt: 1 }), false))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(store.has('artists/flr/brand/proposal')).toBe(true);
  });

  it('approves the posted guide', async () => {
    const response = await approve(JSON.stringify({ ...GUIDE, proposedAt: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ approved: { ...GUIDE, status: 'APPROVED' } });
    expect(store.has('artists/flr/brand/approved')).toBe(true);
  });

  it('400s on a body that is not JSON', async () => {
    expect((await approve('not json')).status).toBe(400);
  });

  it('422s with the validation message', async () => {
    const response = await approve(JSON.stringify({ ...GUIDE, statement: '', proposedAt: 1 }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(/statement/);
  });
});
