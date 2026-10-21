// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { jobs } from '$lib/server/core/schema';
import { getJob } from '$lib/server/jobs/jobs';
import { POST } from '$routes/api/jobs/[id]/short/+server';
import type { JobView } from '$lib/types';
import { afterJobUpdate, seed, truncate } from '../../../../../../helpers/db';
import { A_JOB, seedJob, USER_A, USER_B, USERS } from '../../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];

const make = async (id: string, user: typeof USER_A | typeof USER_B = USER_B) =>
  POST({ params: { id }, locals: { user } } as unknown as Event);

const PROBE = { durationSec: 180, width: 1920, height: 1080, hasAudio: true };

async function put(id: string, patch: Parameters<typeof seedJob>[0] = {}) {
  await seedJob({
    id,
    state: 'REVIEW',
    object: `uploads/${id}`,
    probe: PROBE,
    hashtagCandidates: ['#synthwave'],
    pickVersion: 1,
    trace: { sentryTrace: 't', baggage: 'b' },
    ...patch,
  });
  await db()
    .update(jobs)
    .set({ picks: [{ version: 1, title: 'First', skipped: false }] })
    .where(eq(jobs.id, id));
}

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
});

describe('POST /api/jobs/[id]/short', () => {
  it("starts the video's Short and answers with the Short's view", async () => {
    await put('j');
    const response = await make('j');
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job).toMatchObject({ state: 'HOOK', parentId: 'j' });
    expect(view.job.short).toMatchObject({ reframe: 'blur', hook: null });
    expect(view.pick).toMatchObject({ version: 1, title: 'First' });
    expect(view).not.toHaveProperty('playbackUrl');
    expect((await getJob('j'))!.shortId).toBe(view.job.id);
  });

  it('answers with the same Short on a second press', async () => {
    await put('j');
    const first = (await (await make('j')).json()) as JobView;
    const second = (await (await make('j')).json()) as JobView;
    expect(second.job.id).toBe(first.job.id);
  });

  it('409s while the video is still being analyzed', async () => {
    await put('j', { state: 'ANALYZE' });
    const response = await make('j');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Not allowed while the job is ANALYZE.',
      fields: null,
    });
  });

  it("404s another user's video and starts nothing", async () => {
    await put('j');
    const error = await make('j', USER_A).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect((await db().select({ id: jobs.id }).from(jobs)).map((r) => r.id)).toEqual(['j']);
  });

  it("starts Nathan's Short owned like the video", async () => {
    await put('n', A_JOB);
    const view = (await (await make('n', USER_A)).json()) as JobView;
    expect(await getJob(view.job.id)).toMatchObject(A_JOB);
  });

  it('404s an unknown job', async () => {
    const error = await make('ghost').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
  });

  it('fails loudly if the Short vanishes right after it is created', async () => {
    await put('j');
    await afterJobUpdate(`delete from jobs where id = new.data->>'shortId'`);
    await expect(make('j')).rejects.toThrow(/vanished after it was created/);
  });
});
