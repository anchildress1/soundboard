// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { getJob } from '$lib/server/jobs/jobs';
import { POST } from '$routes/api/jobs/[id]/retry/+server';
import type { JobView } from '$lib/types';
import { seed, truncate, vanishOnUpdate } from '../../../../../../helpers/db';
import { seedJob, USER_A, USER_B, USERS } from '../../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];

const retry = async (id: string, user: typeof USER_A | typeof USER_B = USER_B) =>
  POST({ params: { id }, locals: { user } } as unknown as Event);

const put = (patch: Parameters<typeof seedJob>[0] = {}) =>
  seedJob({
    state: 'FAILED',
    failedState: 'ANALYZE',
    chunkIndex: 2,
    consecutiveFailures: 2,
    error: 'ffmpeg exited 1',
    ...patch,
  });

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
});

describe('POST /api/jobs/[id]/retry', () => {
  it('resumes at the failed chunk and keeps finished chunks', async () => {
    await put();
    await seed({
      jobChunks: [0, 1].map((index) => ({ jobId: 'j1', index, data: { index } })),
    });
    const response = await retry('j1');
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job).toMatchObject({
      state: 'ANALYZE',
      chunkIndex: 2,
      failedState: null,
      error: null,
    });
    expect(view.chunks).toHaveLength(2);
    expect(await getJob('j1')).toMatchObject({ consecutiveFailures: 0 });
  });

  it('restarts at PREP when the failed step is unknown', async () => {
    await put({ failedState: null });
    expect(((await (await retry('j1')).json()) as JobView).job.state).toBe('PREP');
  });

  it('resets the read-back count when verification failed', async () => {
    await put({ failedState: 'CLAIMED_COMPLETE', verifyAttempts: 10 });
    await retry('j1');
    expect(await getJob('j1')).toMatchObject({ state: 'CLAIMED_COMPLETE', verifyAttempts: 0 });
  });

  it('409s a job that has not failed', async () => {
    await put({ state: 'REVIEW' });
    expect((await retry('j1')).status).toBe(409);
  });

  it("404s another user's job and changes nothing", async () => {
    await put();
    const error = await retry('j1', USER_A).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect((await getJob('j1'))!.state).toBe('FAILED');
  });

  it('answers with the loaded job if it disappears mid-request', async () => {
    await put();
    await vanishOnUpdate();
    const response = await retry('j1');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('FAILED');
  });
});
