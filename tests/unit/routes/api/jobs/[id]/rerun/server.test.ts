// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/jobs/[id]/rerun/+server';
import type { JobView } from '$lib/types';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof POST>[0];

const rerun = async (id: string, allowlisted = false) =>
  POST({
    params: { id },
    locals: { session: allowlisted ? { email: 'nathan@example.com', allowlisted } : null },
  } as unknown as Event);

function seed(id: string, patch: Record<string, unknown> = {}, withPick = true) {
  store.set(`jobs/${id}`, {
    id,
    owner: 'visitor',
    state: 'REVIEW',
    songTitle: 'PeekaBoo',
    consecutiveFailures: 1,
    error: 'old',
    ...patch,
  });
  if (withPick) store.set(`jobs/${id}/pick/0001`, { version: 1, title: 'First', skipped: false });
}

const keys = (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix));

/** The bucket's lifecycle rule can delete a job mid-request; the route falls back to what it loaded. */
function vanishAfter(path: string, reads: number) {
  const real = store.get.bind(store);
  let n = 0;
  vi.spyOn(store, 'get').mockImplementation((key: string) => {
    if (key === path) n += 1;
    return key === path && n > reads ? undefined : real(key);
  });
}

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
  vi.restoreAllMocks();
});

describe('POST /api/jobs/[id]/rerun', () => {
  it('skips the current pick and queues a new smart pick', async () => {
    seed('j');
    const response = await rerun('j');
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job).toMatchObject({ state: 'PICK', error: null });
    expect(store.get('jobs/j/pick/0001')).toMatchObject({ skipped: true });
    expect(keys('jobs/j/feedback/')).toHaveLength(1);
    expect(keys('artists/')).toHaveLength(0);
  });

  it('queues a pick even with no stored recommendation', async () => {
    seed('j', {}, false);
    const view = (await (await rerun('j')).json()) as JobView;
    expect(view.job.state).toBe('PICK');
    expect(keys('jobs/j/feedback/')).toHaveLength(0);
  });

  it('409s outside review', async () => {
    seed('j', { state: 'PUBLISHING' });
    const response = await rerun('j');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Not allowed while the job is PUBLISHING.',
      fields: null,
    });
  });

  it("404s Nathan's job from a non-allowlisted session", async () => {
    seed('n', { owner: 'nathan' });
    const error = await rerun('n').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(store.get('jobs/n/pick/0001')).toMatchObject({ skipped: false });
  });

  it("stores Nathan's skip on the artist", async () => {
    seed('n', { owner: 'nathan' });
    await rerun('n', true);
    expect(keys('artists/flr/feedback/')).toHaveLength(1);
  });
  it('answers with the loaded job if it disappears mid-request', async () => {
    seed('j');
    vanishAfter('jobs/j', 2);
    const response = await rerun('j');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('REVIEW');
  });
});
