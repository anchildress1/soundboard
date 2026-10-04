// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/jobs/[id]/retry/+server';
import type { JobView } from '$lib/types';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof POST>[0];

const retry = async (id: string, allowlisted = false) =>
  POST({
    params: { id },
    locals: { session: allowlisted ? { email: 'nathan@example.com', allowlisted } : null },
  } as unknown as Event);

const seed = (id: string, patch: Record<string, unknown> = {}) =>
  store.set(`jobs/${id}`, {
    id,
    owner: 'visitor',
    state: 'FAILED',
    failedState: 'ANALYZE',
    chunkIndex: 2,
    consecutiveFailures: 2,
    verifyAttempts: 0,
    error: 'ffmpeg exited 1',
    ...patch,
  });

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

describe('POST /api/jobs/[id]/retry', () => {
  it('resumes at the failed chunk and keeps finished chunks', async () => {
    seed('j');
    store.set('jobs/j/chunks/0000', { index: 0 });
    store.set('jobs/j/chunks/0001', { index: 1 });
    const response = await retry('j');
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job).toMatchObject({
      state: 'ANALYZE',
      chunkIndex: 2,
      failedState: null,
      error: null,
    });
    expect(view.chunks).toHaveLength(2);
    expect(store.get('jobs/j')).toMatchObject({ consecutiveFailures: 0 });
  });

  it('restarts at PREP when the failed step is unknown', async () => {
    seed('j', { failedState: null });
    expect(((await (await retry('j')).json()) as JobView).job.state).toBe('PREP');
  });

  it('409s a job that has not failed', async () => {
    seed('j', { state: 'REVIEW' });
    expect((await retry('j')).status).toBe(409);
  });

  it("404s Nathan's job from a non-allowlisted session", async () => {
    seed('n', { owner: 'nathan' });
    const error = await retry('n').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect((store.get('jobs/n') as { state: string }).state).toBe('FAILED');
  });

  it("retries Nathan's job for an allowlisted session", async () => {
    seed('n', { owner: 'nathan', failedState: 'CLAIMED_COMPLETE', verifyAttempts: 10 });
    await retry('n', true);
    expect(store.get('jobs/n')).toMatchObject({ state: 'CLAIMED_COMPLETE', verifyAttempts: 0 });
  });
  it('answers with the loaded job if it disappears mid-request', async () => {
    seed('j');
    vanishAfter('jobs/j', 2);
    const response = await retry('j');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('FAILED');
  });
});
