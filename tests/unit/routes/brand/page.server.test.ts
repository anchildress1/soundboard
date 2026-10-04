// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { load } from '$routes/brand/+page.server';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof load>[0];
const run = (session: { email: string; allowlisted: boolean } | null) =>
  load({ locals: { session } } as unknown as Event);

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
});

describe('/brand load', () => {
  it.each([null, { email: 'v@example.com', allowlisted: false }])(
    '404s for %o',
    async (session) => {
      store.set('artists/flr/brand/approved', { statement: 'secret' });
      const error = await Promise.resolve()
        .then(() => run(session))
        .catch((e: unknown) => e);
      expect(isHttpError(error) && error.status).toBe(404);
    },
  );

  it('returns the approved guide and the proposal', async () => {
    store.set('artists/flr/brand/proposal', { statement: 'p' });
    expect(await run({ email: 'n@example.com', allowlisted: true })).toEqual({
      approved: null,
      proposal: { statement: 'p' },
    });
  });
});
