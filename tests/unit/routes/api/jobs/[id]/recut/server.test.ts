// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { getJob } from '$lib/server/jobs/jobs';
import { POST } from '$routes/api/jobs/[id]/recut/+server';
import type { JobView, Short } from '$lib/types';
import { seed, truncate, vanishOnUpdate } from '../../../../../../helpers/db';
import { seedJob, USER_A, USER_B, USERS } from '../../../../../../helpers/pipeline';

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

const recut = async (id: string, body: unknown, user: typeof USER_A | typeof USER_B = USER_B) =>
  POST({
    params: { id },
    request: new Request('https://x', { method: 'POST', body: JSON.stringify(body) }),
    locals: { user },
  } as unknown as Event);

const SHORT: Short = {
  sourceDurationSec: 180,
  reframe: 'blur',
  hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'Chorus.' },
  skipped: [],
  renders: 1,
  modelMs: 1,
};

const put = (id: string, short: Short | null = SHORT) =>
  seedJob({ id, state: 'REVIEW', object: `uploads/${id}`, short });
const state = async (id: string) => (await getJob(id))!.state;

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetClients();
  await truncate();
  await seed(USERS);
});

describe('POST /api/jobs/[id]/recut', () => {
  it('queues a re-render with the new cut', async () => {
    await put('s');
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
    await put('s');
    const response = await recut('s', { startSec: 175, lengthSec: 20, reframe: 'blur' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Start must be 0 to 160 seconds for that length.',
      fields: null,
    });
  });

  it('400s missing fields', async () => {
    await put('s');
    expect((await recut('s', {})).status).toBe(400);
    expect((await recut('s', { startSec: 70, lengthSec: 30 })).status).toBe(400);
  });

  it.each([
    ['a null start', { startSec: null, lengthSec: 30 }],
    ['a string start', { startSec: '70', lengthSec: 30 }],
    ['an array length', { startSec: 70, lengthSec: [30] }],
    ['a false length', { startSec: 70, lengthSec: false }],
  ])('400s %s instead of reading it as a number', async (_label, cut) => {
    await put('s');
    expect((await recut('s', { ...cut, reframe: 'blur' })).status).toBe(400);
    expect(await state('s')).toBe('REVIEW');
  });

  it('400s a framing that is not a string', async () => {
    await put('s');
    expect((await recut('s', { startSec: 70, lengthSec: 30, reframe: ['crop'] })).status).toBe(400);
    expect(await state('s')).toBe('REVIEW');
  });

  it('400s a body that is not a JSON object', async () => {
    await put('s');
    expect((await recut('s', [1, 2])).status).toBe(400);
  });

  it('409s a video job', async () => {
    await put('v', null);
    expect((await recut('v', { startSec: 0, lengthSec: 30, reframe: 'blur' })).status).toBe(409);
  });

  it("404s another user's Short and changes nothing", async () => {
    await put('s');
    const error = await recut('s', { startSec: 70, lengthSec: 30, reframe: 'crop' }, USER_A).catch(
      (e: unknown) => e,
    );
    expect(isHttpError(error) && error.status).toBe(404);
    expect(await state('s')).toBe('REVIEW');
  });

  it('answers with the loaded job if it disappears mid-request', async () => {
    await put('s');
    await vanishOnUpdate();
    const response = await recut('s', { startSec: 70, lengthSec: 30, reframe: 'crop' });
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job.state).toBe('REVIEW');
    expect(view.playbackUrl).toBe('https://storage.googleapis.com/bkt/uploads/s?sig=read');
  });
});
