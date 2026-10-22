// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { artistMemory, jobs } from '$lib/server/core/schema';
import { getJob, type JobDoc } from '$lib/server/jobs/jobs';
import { POST } from '$routes/api/jobs/[id]/approve/+server';
import type { JobView } from '$lib/types';
import { seed, truncate, vanishOnUpdate } from '../../../../../../helpers/db';
import {
  A_JOB,
  CHANNEL_A,
  seedJob,
  USER_A,
  USER_B,
  USERS,
} from '../../../../../../helpers/pipeline';

const SYNTHWAVE = '#synthwave';

type Event = Parameters<typeof POST>[0];

const approve = async (id: string, body: unknown, user: typeof USER_A | typeof USER_B = USER_A) =>
  POST({
    params: { id },
    request: new Request(`http://localhost/api/jobs/${id}/approve`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { user },
  } as unknown as Event);

const CANDIDATES = [SYNTHWAVE, '#RetroWave', '#newmusic'];

/** A's job by default: A has YouTube connected, so approval can pin a destination. */
async function put(id: string, patch: Partial<JobDoc> = {}) {
  await seedJob({
    id,
    ...A_JOB,
    state: 'REVIEW',
    hashtagCandidates: CANDIDATES,
    audience: {
      retrievedAt: Date.now(),
      query: 'synthwave music video',
      hashtags: CANDIDATES,
      tags: ['synthwave', 'outrun', '42'].map((tag) => ({ tag })),
      top: [],
    },
    pickVersion: 1,
    ...patch,
  });
  await db()
    .update(jobs)
    .set({
      picks: [
        {
          version: 1,
          title: 'PeekaBoo',
          description: 'Night drive. #synthwave',
          hashtags: [SYNTHWAVE],
          tags: ['synthwave'],
          flags: [],
          brandCheck: '',
          why: { title: '', description: '', tags: '' },
          bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
          modelMs: 1,
          skipped: false,
        },
      ],
    })
    .where(eq(jobs.id, id));
}

const jobFeedback = async () =>
  (await db().select({ feedback: jobs.feedback }).from(jobs)).flatMap(
    (r) => r.feedback as unknown[],
  );
const artistFeedback = () =>
  db().select().from(artistMemory).where(eq(artistMemory.kind, 'feedback'));

const job = async (id: string) => (await getJob(id))!;
const fields = {
  title: 'PeekaBoo (Official Video)',
  description: 'Night drive. #synthwave #retrowave',
  tags: 'synthwave, outrun',
  pickVersion: 1,
  channelId: CHANNEL_A,
};

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
});

describe('POST /api/jobs/[id]/approve', () => {
  it("pins the owner's channel, starts the upload and records Nathan's feedback", async () => {
    await put('j');
    const response = await approve('j', fields);
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job.state).toBe('PUBLISHING');
    expect(view.job.destination).toEqual({
      channelId: CHANNEL_A,
      channelTitle: 'Flies Like Robots',
    });
    expect(view.job.finalFields).toEqual({
      title: 'PeekaBoo (Official Video)',
      description: 'Night drive. #synthwave #retrowave',
      hashtags: [SYNTHWAVE, '#RetroWave'],
      tags: ['synthwave', 'outrun'],
    });
    expect((await artistFeedback()).length).toBeGreaterThan(0);
    expect(await jobFeedback()).toEqual([]);
  });

  it('409s a user without a YouTube connection and records nothing', async () => {
    await put('b', { ownerUid: USER_B.uid, artistId: null });
    const response = await approve('b', fields, USER_B);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'Reconnect YouTube to approve.' });
    expect((await job('b')).state).toBe('REVIEW');
    expect(await jobFeedback()).toEqual([]);
  });

  it('409s an approval for a channel other than the connected one', async () => {
    await put('j');
    const response = await approve('j', { ...fields, channelId: 'UCstale' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'Your YouTube channel changed. Reload to approve.',
    });
    expect((await job('j')).state).toBe('REVIEW');
  });

  it('accepts tags as an array', async () => {
    await put('j');
    await approve('j', { ...fields, tags: ['synthwave', 42] });
    expect((await job('j')).finalFields!.tags).toEqual(['synthwave', '42']);
  });

  it('drops array tags that are not text', async () => {
    await put('j');
    await approve('j', { ...fields, tags: ['synthwave', { tag: 'outrun' }, null] });
    expect((await job('j')).finalFields!.tags).toEqual(['synthwave']);
  });

  it('reads an object title as empty rather than "[object Object]"', async () => {
    await put('j');
    const response = await approve('j', { ...fields, title: { text: 'PeekaBoo' } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ fields: { title: 'Title is required.' } });
  });

  it('400s a recommendation version sent as a string', async () => {
    await put('j');
    const response = await approve('j', { ...fields, pickVersion: '1' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Name the recommendation version being approved.',
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('400s a %s channel and records nothing', async (_label, channelId) => {
    await put('j');
    const response = await approve('j', { ...fields, channelId });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Name the channel being approved to.' });
    expect(await job('j')).toMatchObject({ state: 'REVIEW', destination: null });
  });

  it('treats missing fields as empty and reports the title', async () => {
    await put('j');
    const response = await approve('j', { pickVersion: 1, channelId: CHANNEL_A });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ fields: { title: 'Title is required.' } });
  });

  it('rejects a hashtag outside the candidate list with field errors', async () => {
    await put('j');
    const response = await approve('j', { ...fields, description: 'x #madeup' });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Fix the highlighted fields.',
      fields: { description: "Not in this job's hashtag list: #madeup" },
    });
    expect((await job('j')).state).toBe('REVIEW');
  });

  it('409s outside review', async () => {
    await put('j', { state: 'ANALYZE' });
    expect((await approve('j', fields)).status).toBe(409);
  });

  it('400s a malformed body', async () => {
    await put('j');
    expect((await approve('j', '{oops')).status).toBe(400);
  });

  it("404s another user's job and changes nothing", async () => {
    await put('j');
    const error = await approve('j', fields, USER_B).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect((await job('j')).state).toBe('REVIEW');
    expect(await artistFeedback()).toEqual([]);
  });

  it('answers with the loaded job if it disappears mid-request', async () => {
    await put('j');
    await vanishOnUpdate();
    const response = await approve('j', fields);
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('REVIEW');
  });
});
