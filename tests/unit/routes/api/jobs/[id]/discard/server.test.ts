// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { artistFeedback, jobFeedback } from '$lib/server/core/schema';
import { getJob } from '$lib/server/jobs/jobs';
import { POST } from '$routes/api/jobs/[id]/discard/+server';
import type { JobState, JobView } from '$lib/types';
import { seed, truncate, vanishOnUpdate } from '../../../../../../helpers/db';
import { seedJob, USER_A, USER_B, USERS } from '../../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];

const discard = async (id: string, user: typeof USER_A | typeof USER_B = USER_B) =>
  POST({ params: { id }, locals: { user } } as unknown as Event);

const state = async (id: string) => (await getJob(id))!.state;

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
});

describe('POST /api/jobs/[id]/discard', () => {
  it.each<JobState>(['REVIEW', 'ANALYZE', 'FAILED', 'PUBLISHING', 'CLAIMED_COMPLETE'])(
    'ends a %s job',
    async (from) => {
      await seedJob({ state: from });
      const response = await discard('j1');
      expect(response.status).toBe(200);
      expect(((await response.json()) as JobView).job.state).toBe('DISCARDED');
    },
  );

  it('learns nothing from a discard', async () => {
    await seedJob({ state: 'REVIEW' });
    await discard('j1');
    expect(await db().select().from(jobFeedback)).toEqual([]);
    expect(await db().select().from(artistFeedback)).toEqual([]);
  });

  it('409s once the upload is verified', async () => {
    await seedJob({ state: 'VERIFIED' });
    const response = await discard('j1');
    expect(response.status).toBe(409);
    expect(await state('j1')).toBe('VERIFIED');
  });

  it("404s another user's job and changes nothing", async () => {
    await seedJob({ state: 'REVIEW' });
    const error = await discard('j1', USER_A).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(await state('j1')).toBe('REVIEW');
  });

  it('answers with the loaded job if it disappears mid-request', async () => {
    await seedJob({ state: 'REVIEW' });
    await vanishOnUpdate();
    const response = await discard('j1');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('REVIEW');
  });
});
