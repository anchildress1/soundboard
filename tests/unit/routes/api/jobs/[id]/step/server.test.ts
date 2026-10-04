// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/jobs/[id]/step/+server';
import type { JobView } from '$lib/types';

const h = vi.hoisted(() => ({ objects: new Set<string>() }));

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        file: (object: string) => ({
          exists: async () => [h.objects.has(object)],
          getMetadata: async () => [{ size: '10', contentType: 'video/mp4' }],
        }),
      };
    }
  },
}));

type Event = Parameters<typeof POST>[0];

const step = async (id: string, allowlisted = false) =>
  POST({
    params: { id },
    locals: { session: allowlisted ? { email: 'nathan@example.com', allowlisted } : null },
  } as unknown as Event);

function seed(id: string, patch: Record<string, unknown> = {}) {
  store.set(`jobs/${id}`, {
    id,
    owner: 'visitor',
    state: 'REVIEW',
    object: `uploads/${id}`,
    chunkCount: 2,
    chunkIndex: 0,
    consecutiveFailures: 0,
    claim: null,
    ...patch,
  });
}

const fetchMock = vi.fn<typeof fetch>();

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
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetStore();
  resetClients();
  vi.restoreAllMocks();
  h.objects.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/jobs/[id]/step', () => {
  it('returns the view unchanged for a job awaiting review', async () => {
    seed('j', { state: 'REVIEW' });
    const response = await step('j');
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job.state).toBe('REVIEW');
    expect(view).not.toHaveProperty('wait');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the fresh job after the step moves it', async () => {
    seed('j', { state: 'AWAITING_UPLOAD' });
    h.objects.add('uploads/j');
    const view = (await (await step('j')).json()) as JobView;
    expect(view.job.state).toBe('PREP');
  });

  it('names the wait while the model loads', async () => {
    seed('j', { state: 'ANALYZE' });
    fetchMock.mockResolvedValue(new Response('loading', { status: 503 }));
    const view = (await (await step('j')).json()) as JobView;
    expect(view.wait).toBe('waking model');
    expect(view.job.state).toBe('ANALYZE');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://127.0.0.1:8081/health');
  });

  it("404s Nathan's job from a non-allowlisted session without running it", async () => {
    seed('n', { owner: 'nathan', state: 'AWAITING_UPLOAD' });
    h.objects.add('uploads/n');
    const error = await step('n').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect((store.get('jobs/n') as { state: string }).state).toBe('AWAITING_UPLOAD');
  });

  it("runs Nathan's job for an allowlisted session", async () => {
    seed('n', { owner: 'nathan', state: 'AWAITING_UPLOAD' });
    h.objects.add('uploads/n');
    const view = (await (await step('n', true)).json()) as JobView;
    expect(view.job.state).toBe('PREP');
  });
  it('answers with the loaded job if it disappears mid-request', async () => {
    seed('j');
    vanishAfter('jobs/j', 1);
    const response = await step('j');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('REVIEW');
  });
});
