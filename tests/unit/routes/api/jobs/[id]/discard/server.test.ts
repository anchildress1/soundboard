// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/jobs/[id]/discard/+server';
import type { JobView } from '$lib/types';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof POST>[0];

const discard = async (id: string, allowlisted = false) =>
  POST({
    params: { id },
    locals: { session: allowlisted ? { email: 'nathan@example.com', allowlisted } : null },
  } as unknown as Event);

const seed = (id: string, patch: Record<string, unknown> = {}) =>
  store.set(`jobs/${id}`, { id, owner: 'visitor', state: 'REVIEW', ...patch });

/** The bucket's lifecycle rule can delete a job mid-request; the route falls back to what it loaded. */
function vanishAfter(path: string, reads: number) {
  const real = store.get.bind(store);
  let n = 0;
  vi.spyOn(store, 'get').mockImplementation((key: string) =>
    key === path && ++n > reads ? undefined : real(key),
  );
}

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
  vi.restoreAllMocks();
});

describe('POST /api/jobs/[id]/discard', () => {
  it.each(['REVIEW', 'ANALYZE', 'FAILED', 'PAYLOAD'])('ends a %s job', async (state) => {
    seed('j', { state });
    const response = await discard('j');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('DISCARDED');
  });

  it('learns nothing from a discard', async () => {
    seed('j');
    await discard('j');
    expect([...store.keys()].some((k) => k.includes('feedback'))).toBe(false);
  });

  it('409s once the upload has started', async () => {
    seed('j', { state: 'VERIFIED' });
    const response = await discard('j');
    expect(response.status).toBe(409);
    expect((store.get('jobs/j') as { state: string }).state).toBe('VERIFIED');
  });

  it("404s Nathan's job from a non-allowlisted session", async () => {
    seed('n', { owner: 'nathan' });
    const error = await discard('n').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect((store.get('jobs/n') as { state: string }).state).toBe('REVIEW');
  });

  it("discards Nathan's job for an allowlisted session", async () => {
    seed('n', { owner: 'nathan' });
    expect(((await (await discard('n', true)).json()) as JobView).job.state).toBe('DISCARDED');
  });
  it('answers with the loaded job if it disappears mid-request', async () => {
    seed('j');
    vanishAfter('jobs/j', 2);
    const response = await discard('j');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('REVIEW');
  });
});
