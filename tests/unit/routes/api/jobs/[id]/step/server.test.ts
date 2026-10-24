// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { getJob } from '$lib/server/jobs/jobs';
import { POST } from '$routes/api/jobs/[id]/step/+server';
import type { JobState, JobView } from '$lib/types';
import { seed, truncate, vanishOnUpdate } from '../../../../../../helpers/db';
import { busy429 } from '../../../../../../helpers/gemini';
import { seedJob, USER_A, USER_B, USERS } from '../../../../../../helpers/pipeline';

const h = vi.hoisted(() => ({ objects: new Set<string>() }));

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

const step = async (id: string, user: typeof USER_A | typeof USER_B = USER_B) =>
  POST({ params: { id }, locals: { user } } as unknown as Event);

const put = (state: JobState) => seedJob({ state, chunkCount: 2 });

const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  resetClients();
  await truncate();
  await seed(USERS);
  h.objects.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/jobs/[id]/step', () => {
  it('returns the view unchanged for a job awaiting review', async () => {
    await put('REVIEW');
    const response = await step('j1');
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job.state).toBe('REVIEW');
    expect(view).not.toHaveProperty('wait');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the fresh job after the step moves it', async () => {
    await put('AWAITING_UPLOAD');
    h.objects.add('uploads/j1');
    const view = (await (await step('j1')).json()) as JobView;
    expect(view.job.state).toBe('PREP');
  });

  it('names the wait while the model is busy', async () => {
    const audience = { retrievedAt: Date.now(), query: 'q', candidateLists: [], top: [] };
    await seedJob({ state: 'PICK', chunkCount: 2, audience });
    fetchMock.mockImplementation(async () => busy429());
    const view = (await (await step('j1')).json()) as JobView;
    expect(view.wait).toBe('model busy');
    expect(view.job).toMatchObject({ state: 'PICK', error: null });
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/v1beta\/interactions$/);
  });

  it('names the wait while the per-day model quota is spent, calling nothing', async () => {
    await seedJob({ state: 'PICK', chunkCount: 2, limitUntil: Date.now() + 60_000 });
    const view = (await (await step('j1')).json()) as JobView;
    expect(view.wait).toBe('model quota spent');
    expect(view.job.state).toBe('PICK');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s another user's job without running it", async () => {
    await put('AWAITING_UPLOAD');
    h.objects.add('uploads/j1');
    const error = await step('j1', USER_A).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect((await getJob('j1'))!.state).toBe('AWAITING_UPLOAD');
  });

  it('answers with the loaded job if it disappears mid-request', async () => {
    await put('AWAITING_UPLOAD');
    h.objects.add('uploads/j1');
    await vanishOnUpdate();
    const response = await step('j1');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('AWAITING_UPLOAD');
  });
});
