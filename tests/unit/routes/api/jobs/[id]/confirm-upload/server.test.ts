// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { jobs } from '$lib/server/core/schema';
import { getJob, type JobDoc } from '$lib/server/jobs/jobs';
import { POST } from '$routes/api/jobs/[id]/confirm-upload/+server';
import type { JobView } from '$lib/types';
import { seed, truncate } from '../../../../../../helpers/db';
import {
  A_JOB,
  CHANNEL_A,
  json,
  REFRESH_A,
  seedJob,
  USER_A,
  USER_B,
  USERS,
} from '../../../../../../helpers/pipeline';

vi.mock('@google-cloud/kms', () => import('../../../../../../e2e/fakes/kms'));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    refresh = '';
    setCredentials(credentials: { refresh_token: string }) {
      this.refresh = credentials.refresh_token;
    }
    async getAccessToken() {
      return { token: `access:${this.refresh}` };
    }
  },
}));

type Event = Parameters<typeof POST>[0];

const ID = 'dQw4w9WgXcQ';
const PAUSED: Partial<JobDoc> = {
  ...A_JOB,
  state: 'PUBLISHING',
  destination: { channelId: CHANNEL_A, channelTitle: 'Flies Like Robots' },
  finalFields: { title: 't', description: 'd', hashtags: [], tags: [] },
  finalChunkAt: 5,
  uploadStartedAt: 4,
};

const fetchMock = vi.fn<typeof fetch>();
/** videos.list answers with the video on `channelId`, or with no video when null. */
const videoOn = (channelId: string | null) =>
  fetchMock.mockImplementation(async () =>
    json({ items: channelId ? [{ id: ID, snippet: { channelId } }] : [] }),
  );

const confirm = async (body: unknown, user: typeof USER_A | typeof USER_B = USER_A) =>
  POST({
    params: { id: 'j1' },
    locals: { user },
    request: new Request('http://localhost/api', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  } as unknown as Event);

const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

beforeEach(async () => {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  resetClients();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  videoOn(CHANNEL_A);
  await truncate();
  await seed(USERS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/jobs/[id]/confirm-upload', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://studio.youtube.com/video/${ID}/edit`,
  ])('records %s and moves to CLAIMED_COMPLETE, with no new upload', async (url) => {
    await seedJob(PAUSED);
    const response = await confirm({ url });
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job).toMatchObject({ state: 'CLAIMED_COMPLETE', videoId: ID });
    expect(await getJob('j1')).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      videoId: ID,
      destination: PAUSED.destination,
      uploadStartedAt: 4,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toContain(`/youtube/v3/videos?part=snippet&id=${ID}`);
    expect((init!.headers as Record<string, string>).authorization).toBe(
      `Bearer access:${REFRESH_A}`,
    );
  });

  it.each([
    ['a non-YouTube URL', { url: `https://example.com/watch?v=${ID}` }],
    ['a channel URL', { url: `https://www.youtube.com/channel/${CHANNEL_A}` }],
    ['a bare ID', { url: ID }],
    ['no url', {}],
    ['a non-string url', { url: 42 }],
  ])('400s %s without a YouTube call or a job change', async (_label, body) => {
    const before = await seedJob(PAUSED);
    const response = await confirm(body);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('Paste a YouTube video URL.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getJob('j1')).toMatchObject({ state: before.state, videoId: null });
  });

  it('400s a body that is not a JSON object', async () => {
    await seedJob(PAUSED);
    expect((await confirm('nope')).status).toBe(400);
  });

  it("404s another user's job and changes nothing", async () => {
    await seedJob(PAUSED);
    const error = await confirm({ url: `https://youtu.be/${ID}` }, USER_B).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getJob('j1'))!.state).toBe('PUBLISHING');
  });

  it.each<[string, Partial<JobDoc>]>([
    ['no final chunk sent', { finalChunkAt: null }],
    ['a live session', { upload: { sessionUri: 'https://upload.example/s1', total: 10 } }],
    ['a video ID', { videoId: 'vid1' }],
    ['another state', { state: 'CLAIMED_COMPLETE', videoId: 'vid1' }],
    ['a discarded job', { state: 'DISCARDED' }],
  ])('409s a job with %s, without a YouTube call', async (_label, patch) => {
    const before = await seedJob({ ...PAUSED, ...patch });
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getJob('j1')).toMatchObject({ state: before.state, videoId: before.videoId });
  });

  it.each([
    ['missing', null],
    ['on another channel', 'UCother'],
  ])('422s a video %s, with no job change', async (_label, channel) => {
    await seedJob(PAUSED);
    videoOn(channel);
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toBe("That video isn't on Flies Like Robots.");
    expect(await getJob('j1')).toMatchObject({ state: 'PUBLISHING', videoId: null });
  });

  it('409s without a YouTube call when the grant is gone', async () => {
    await seedJob({ ...PAUSED, ownerUid: USER_B.uid, artistId: null });
    const response = await confirm({ url: `https://youtu.be/${ID}` }, USER_B);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('Reconnect YouTube to confirm.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409s when the job left the paused state while the video was read', async () => {
    await seedJob(PAUSED);
    fetchMock.mockImplementation(async () => {
      await db().update(jobs).set({ state: 'DISCARDED' }).where(eq(jobs.id, 'j1'));
      return json({ items: [{ id: ID, snippet: { channelId: CHANNEL_A } }] });
    });
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(response.status).toBe(409);
    expect(await getJob('j1')).toMatchObject({ state: 'DISCARDED', videoId: null });
  });
});
