// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { connections, jobs } from '$lib/server/core/schema';
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
import { captureException } from '../../../../../../mocks/sentry';

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
const AFTER_START = '2026-10-18T12:00:00Z';
const PAUSED: Partial<JobDoc> = {
  ...A_JOB,
  state: 'PUBLISHING',
  destination: { channelId: CHANNEL_A, channelTitle: 'Flies Like Robots' },
  finalFields: { title: 't', description: 'd', hashtags: [], tags: [] },
  finalChunkAt: Date.parse(AFTER_START) + 60_000,
  uploadStartedAt: Date.parse(AFTER_START),
};

const fetchMock = vi.fn<typeof fetch>();
/** videos.list answers with the video on `channelId`, or with no video when null. */
const videoOn = (channelId: string | null, publishedAt = AFTER_START) =>
  fetchMock.mockImplementation(async () =>
    json({ items: channelId ? [{ id: ID, snippet: { channelId, publishedAt } }] : [] }),
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
      uploadStartedAt: PAUSED.uploadStartedAt,
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

  it.each<[string, () => void, string]>([
    ['a missing video', () => videoOn(null), "Couldn't find that video."],
    [
      'a video with no publish time',
      () =>
        fetchMock.mockImplementation(async () =>
          json({ items: [{ id: ID, snippet: { channelId: CHANNEL_A } }] }),
        ),
      "Couldn't find that video.",
    ],
    [
      'a video on another channel',
      () => videoOn('UCother'),
      "That video isn't on Flies Like Robots.",
    ],
    [
      'a video published before the upload started',
      () => videoOn(CHANNEL_A, '2026-10-18T11:59:59Z'),
      'That video was published before this upload started.',
    ],
  ])('422s %s, with no job change', async (_label, answer, message) => {
    await seedJob(PAUSED);
    answer();
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toBe(message);
    expect(await getJob('j1')).toMatchObject({ state: 'PUBLISHING', videoId: null });
  });

  it('accepts a video YouTube stamped in the second the upload started', async () => {
    await seedJob({ ...PAUSED, uploadStartedAt: Date.parse(AFTER_START) + 700 });
    expect((await confirm({ url: `https://youtu.be/${ID}` })).status).toBe(200);
  });

  it('names the channel generically when its title is unknown', async () => {
    await seedJob({ ...PAUSED, destination: { channelId: CHANNEL_A, channelTitle: null } });
    videoOn('UCother');
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(await errorOf(response)).toBe("That video isn't on this channel.");
  });

  it('409s without a YouTube call when the grant is gone', async () => {
    await seedJob({ ...PAUSED, ownerUid: USER_B.uid, artistId: null });
    const response = await confirm({ url: `https://youtu.be/${ID}` }, USER_B);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('Reconnect YouTube to confirm.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409s and revokes the grant when YouTube refuses its token', async () => {
    await seedJob(PAUSED);
    fetchMock.mockImplementation(async () => new Response('unauthorized', { status: 401 }));
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('Reconnect YouTube to confirm.');
    const [row] = await db().select().from(connections).where(eq(connections.uid, USER_A.uid));
    expect(row).toMatchObject({ status: 'revoked', tokenCiphertext: null });
    expect(await getJob('j1')).toMatchObject({ state: 'PUBLISHING', videoId: null });
  });

  it('429s when the daily YouTube limit is spent', async () => {
    await seedJob(PAUSED);
    fetchMock.mockImplementation(async () => new Response('quotaExceeded', { status: 403 }));
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(response.status).toBe(429);
    expect(await errorOf(response)).toBe('Daily YouTube limit reached. Try tomorrow.');
    expect(captureException).not.toHaveBeenCalled();
  });

  const DIDNT_ANSWER = "YouTube didn't answer. Try again.";
  const WOULDNT_READ =
    "YouTube wouldn't read that video. Try again, or reconnect if it keeps failing.";

  it.each<[string, () => Promise<unknown>, string]>([
    [
      'YouTube errors',
      async () => {
        fetchMock.mockImplementation(async () => new Response('oops', { status: 500 }));
      },
      DIDNT_ANSWER,
    ],
    [
      'YouTube refuses the read for a reason other than quota',
      async () => {
        fetchMock.mockImplementation(
          async () => new Response('insufficientPermissions', { status: 403 }),
        );
      },
      WOULDNT_READ,
    ],
    [
      'the network fails',
      async () => {
        fetchMock.mockImplementation(async () => {
          throw new TypeError('fetch failed');
        });
      },
      DIDNT_ANSWER,
    ],
  ])('502s and reports it when %s, with no job change', async (_label, arrange, message) => {
    await seedJob(PAUSED);
    await arrange();
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe(message);
    expect(captureException).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      tags: { action: 'confirm-upload', 'job.id': 'j1', phase: 'read' },
    });
    expect(await getJob('j1')).toMatchObject({ state: 'PUBLISHING', videoId: null });
  });

  it.each<[string, Partial<typeof connections.$inferInsert>]>([
    ['the grant is on another channel', { channelId: 'UCother' }],
    ['the grant will not decrypt', { tokenCiphertext: 'unsealed' }],
  ])('502s and reports it when %s, without a YouTube call', async (_label, connection) => {
    await seedJob(PAUSED);
    await db().update(connections).set(connection).where(eq(connections.uid, USER_A.uid));
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe(
      "Couldn't use your YouTube connection. Try again, or reconnect if it keeps failing.",
    );
    expect(captureException).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      tags: { action: 'confirm-upload', 'job.id': 'j1', phase: 'grant' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getJob('j1')).toMatchObject({ state: 'PUBLISHING', videoId: null });
  });

  it('skips the publish-time check when the upload start was never recorded', async () => {
    await seedJob({ ...PAUSED, uploadStartedAt: null });
    videoOn(CHANNEL_A, '1969-12-31T23:59:59Z');
    expect((await confirm({ url: `https://youtu.be/${ID}` })).status).toBe(200);
    expect(await getJob('j1')).toMatchObject({ state: 'CLAIMED_COMPLETE', videoId: ID });
  });

  it('409s when the job left the paused state while the video was read', async () => {
    await seedJob(PAUSED);
    fetchMock.mockImplementation(async () => {
      await db().update(jobs).set({ state: 'DISCARDED' }).where(eq(jobs.id, 'j1'));
      return json({
        items: [{ id: ID, snippet: { channelId: CHANNEL_A, publishedAt: AFTER_START } }],
      });
    });
    const response = await confirm({ url: `https://youtu.be/${ID}` });
    expect(response.status).toBe(409);
    expect(await getJob('j1')).toMatchObject({ state: 'DISCARDED', videoId: null });
  });
});
