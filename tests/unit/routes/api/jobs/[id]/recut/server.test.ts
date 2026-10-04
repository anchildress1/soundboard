// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/jobs/[id]/recut/+server';
import type { JobView, Short } from '$lib/types';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (object: string) => ({
          getSignedUrl: async () => [`https://storage.googleapis.com/${name}/${object}?sig=read`],
        }),
      };
    }
  },
}));

type Event = Parameters<typeof POST>[0];

const recut = async (id: string, body: unknown, allowlisted = false) =>
  POST({
    params: { id },
    request: new Request('https://x', { method: 'POST', body: JSON.stringify(body) }),
    locals: { session: allowlisted ? { email: 'nathan@example.com', allowlisted } : null },
  } as unknown as Event);

const SHORT: Short = {
  parentId: 'p',
  sourceDurationSec: 180,
  reframe: 'blur',
  hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'Chorus.' },
  skipped: [],
  renders: 1,
  modelMs: 1,
};

function seed(id: string, patch: Record<string, unknown> = {}) {
  store.set(`jobs/${id}`, {
    id,
    owner: 'visitor',
    state: 'REVIEW',
    object: `uploads/${id}`,
    short: SHORT,
    ...patch,
  });
}

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetStore();
  resetClients();
});

describe('POST /api/jobs/[id]/recut', () => {
  it('queues a re-render with the new cut', async () => {
    seed('s');
    const response = await recut('s', { startSec: 75, lengthSec: 20, reframe: 'crop' });
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job.state).toBe('RENDER');
    expect(view.job.short).toMatchObject({
      reframe: 'crop',
      hook: { startSec: 75, lengthSec: 20, reason: '' },
    });
  });

  it('400s a cut that runs past the end', async () => {
    seed('s');
    const response = await recut('s', { startSec: 175, lengthSec: 20, reframe: 'blur' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Start must be 0 to 160 seconds for that length.',
      fields: null,
    });
  });

  it('400s missing fields', async () => {
    seed('s');
    expect((await recut('s', {})).status).toBe(400);
    expect((await recut('s', { startSec: 70, lengthSec: 30 })).status).toBe(400);
  });

  it.each([
    ['a null start', { startSec: null, lengthSec: 30 }],
    ['a string start', { startSec: '70', lengthSec: 30 }],
    ['an array length', { startSec: 70, lengthSec: [30] }],
    ['a false length', { startSec: 70, lengthSec: false }],
  ])('400s %s instead of reading it as a number', async (_label, cut) => {
    seed('s');
    expect((await recut('s', { ...cut, reframe: 'blur' })).status).toBe(400);
    expect((store.get('jobs/s') as { state: string }).state).toBe('REVIEW');
  });

  it('400s a framing that is not a string', async () => {
    seed('s');
    expect((await recut('s', { startSec: 70, lengthSec: 30, reframe: ['crop'] })).status).toBe(400);
    expect((store.get('jobs/s') as { state: string }).state).toBe('REVIEW');
  });

  it('400s a body that is not a JSON object', async () => {
    seed('s');
    expect((await recut('s', [1, 2])).status).toBe(400);
  });

  it('409s a video job', async () => {
    seed('v', { short: null });
    expect((await recut('v', { startSec: 0, lengthSec: 30, reframe: 'blur' })).status).toBe(409);
  });

  it("404s Nathan's Short for a non-allowlisted session", async () => {
    seed('n', { owner: 'nathan' });
    const error = await recut('n', { startSec: 70, lengthSec: 30, reframe: 'crop' }).catch(
      (e: unknown) => e,
    );
    expect(isHttpError(error) && error.status).toBe(404);
    expect((store.get('jobs/n') as { state: string }).state).toBe('REVIEW');
  });

  it('answers with the loaded job if it disappears mid-request', async () => {
    seed('s');
    const real = store.get.bind(store);
    let reads = 0;
    vi.spyOn(store, 'get').mockImplementation((key: string) => {
      if (key === 'jobs/s') reads += 1;
      return key === 'jobs/s' && reads > 2 ? undefined : real(key);
    });
    const response = await recut('s', { startSec: 70, lengthSec: 30, reframe: 'crop' });
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job.state).toBe('REVIEW');
    expect(view.playbackUrl).toBe('https://storage.googleapis.com/bkt/uploads/s?sig=read');
    vi.restoreAllMocks();
  });
});
