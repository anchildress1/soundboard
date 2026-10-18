// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { artistFeedback, jobFeedback } from '$lib/server/core/schema';
import { listPicks } from '$lib/server/jobs/jobs';
import { POST } from '$routes/api/jobs/[id]/rerun/+server';
import type { JobView } from '$lib/types';
import { seed, truncate, vanishOnUpdate } from '../../../../../../helpers/db';
import { A_JOB, seedJob, USER_A, USER_B, USERS } from '../../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];

const rerun = async (id: string, user: typeof USER_A | typeof USER_B = USER_B) =>
  POST({ params: { id }, locals: { user } } as unknown as Event);

async function put(patch: Parameters<typeof seedJob>[0] = {}, withPick = true) {
  await seedJob({ state: 'REVIEW', consecutiveFailures: 1, error: 'old', ...patch });
  if (withPick) {
    await seed({
      jobPicks: [{ jobId: 'j1', version: 1, data: { version: 1, title: 'First', skipped: false } }],
    });
  }
}

const jobRows = () => db().select().from(jobFeedback);
const artistRows = () => db().select().from(artistFeedback);

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
});

describe('POST /api/jobs/[id]/rerun', () => {
  it('skips the current pick and queues a new smart pick', async () => {
    await put();
    const response = await rerun('j1');
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job).toMatchObject({ state: 'PICK', error: null });
    expect((await listPicks('j1'))[0]).toMatchObject({ skipped: true });
    expect(await jobRows()).toHaveLength(1);
    expect(await artistRows()).toHaveLength(0);
  });

  it('queues a pick even with no stored recommendation', async () => {
    await put({}, false);
    const view = (await (await rerun('j1')).json()) as JobView;
    expect(view.job.state).toBe('PICK');
    expect(await jobRows()).toHaveLength(0);
  });

  it('409s outside review', async () => {
    await put({ state: 'PUBLISHING' });
    const response = await rerun('j1');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Not allowed while the job is PUBLISHING.',
      fields: null,
    });
  });

  it("404s another user's job and skips nothing", async () => {
    await put();
    const error = await rerun('j1', USER_A).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect((await listPicks('j1'))[0]).toMatchObject({ skipped: false });
  });

  it("stores the skip on Nathan's job in his artist memory", async () => {
    await put(A_JOB);
    await rerun('j1', USER_A);
    expect(await artistRows()).toHaveLength(1);
    expect(await jobRows()).toHaveLength(0);
  });

  it('answers with the loaded job if it disappears mid-request', async () => {
    await put({}, false);
    await vanishOnUpdate();
    const response = await rerun('j1');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('REVIEW');
  });
});
