// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { getJob } from '$lib/server/jobs/jobs';
import { clearStatsCache } from '$lib/server/platforms/youtube/youtube';
import { load as layoutLoad } from '$routes/+layout.server';
import { load as homeLoad } from '$routes/+page.server';
import { load as jobLoad } from '$routes/jobs/[id]/+page.server';
import { GET as getJobApi } from '$routes/api/jobs/[id]/+server';
import { POST as approve } from '$routes/api/jobs/[id]/approve/+server';
import { POST as discard } from '$routes/api/jobs/[id]/discard/+server';
import { POST as recut } from '$routes/api/jobs/[id]/recut/+server';
import { POST as rerun } from '$routes/api/jobs/[id]/rerun/+server';
import { POST as makeShort } from '$routes/api/jobs/[id]/short/+server';
import { POST as step } from '$routes/api/jobs/[id]/step/+server';
import { seed, truncate } from '../../helpers/db';
import { A_JOB, CHANNEL_A, seedJob, USER_A, USER_B, USERS } from '../../helpers/pipeline';

// One process serving A, then B, then A: nothing one user saw may leak into the next request.

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (object: string) => ({
          getSignedUrl: async () => [`https://storage.googleapis.com/${name}/${object}?sig=read`],
          exists: async () => [true],
          getMetadata: async () => [{ size: '10', contentType: 'video/mp4' }],
        }),
      };
    }
  },
}));

type User = typeof USER_A | typeof USER_B;
type Layout = { channel: { handle: string } | null };
type Home = { jobs: { id: string }[] };
type JobPage = { view: { job: { id: string } }; playbackUrl: string | null };

const CHANNEL_B = 'UCb';
const PROBE = { durationSec: 180, width: 1920, height: 1080, hasAudio: true };

const event = (user: User, id?: string, body: unknown = {}) =>
  ({
    locals: { user },
    params: id ? { id } : {},
    request: new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) }),
  }) as never;
const status = (error: unknown) => (isHttpError(error) ? error.status : error);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetClients();
  clearStatsCache();
  // The channel read answers with a handle named after the requested channel ID.
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/channels')) return Response.json({ items: [] });
    return Response.json({
      items: [
        {
          snippet: { customUrl: `@${url.searchParams.get('id')}` },
          statistics: { videoCount: '1', subscriberCount: '1' },
          contentDetails: { relatedPlaylists: { uploads: 'UU' } },
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  await truncate();
  await seed(USERS);
  await seed({
    connections: [
      {
        uid: USER_B.uid,
        platform: 'youtube',
        status: 'connected',
        channelId: CHANNEL_B,
        channelTitle: 'B',
        scopes: [],
        tokenCiphertext: 'c2VhbGVk',
        updatedAt: new Date(0),
      },
    ],
  });
  for (const [id, owner] of [
    ['a', A_JOB],
    ['b', { ownerUid: USER_B.uid, artistId: null }],
  ] as const) {
    await seedJob({
      id,
      ...owner,
      state: 'REVIEW',
      object: `uploads/${id}`,
      probe: PROBE,
      pickVersion: 1,
    });
    await seed({ jobPicks: [{ jobId: id, version: 1, data: { version: 1, title: id } }] });
    // A rendered Short of each user's video, in review, so its playback URL is signed.
    await seedJob({
      id: `${id}s`,
      ...owner,
      state: 'REVIEW',
      parentId: id,
      object: `uploads/${id}s-1`,
      sourceObject: `uploads/${id}`,
      pickVersion: 1,
      short: {
        sourceDurationSec: 180,
        reframe: 'blur',
        hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'x' },
        skipped: [],
        renders: 1,
        modelMs: 1,
      },
    });
  }
});

/** Every job API a user can aim at another user's video or Short. */
const FOREIGN_CALLS: [string, (user: User, video: string, short: string) => unknown][] = [
  ['GET job', (user, video) => getJobApi(event(user, video))],
  ['GET Short', (user, _video, short) => getJobApi(event(user, short))],
  ['step', (user, video) => step(event(user, video))],
  ['rerun', (user, video) => rerun(event(user, video))],
  ['discard', (user, video) => discard(event(user, video))],
  [
    'approve',
    (user, video) =>
      approve(
        event(user, video, {
          title: 'x',
          description: '',
          tags: [],
          pickVersion: 1,
          channelId: CHANNEL_A,
        }),
      ),
  ],
  [
    'recut',
    (user, _video, short) =>
      recut(event(user, short, { startSec: 10, lengthSec: 20, reframe: 'crop' })),
  ],
  ['make Short', (user, video) => makeShort(event(user, video))],
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('one process, A → B → A', () => {
  it('serves each user only their own stats, jobs, media and Shorts', async () => {
    const turns = [
      [USER_A, 'a', 'b', CHANNEL_A],
      [USER_B, 'b', 'a', CHANNEL_B],
      [USER_A, 'a', 'b', CHANNEL_A],
    ] as const;
    const shorts: Record<string, string> = {};
    for (const [user, own, other, channel] of turns) {
      const layout = (await layoutLoad(event(user))) as Layout;
      expect(layout.channel?.handle).toBe(`@${channel}`);

      const home = (await homeLoad(event(user))) as Home;
      expect(home.jobs.map((j) => j.id)).toEqual([own]);

      const page = (await jobLoad(event(user, own))) as JobPage;
      expect(page.view.job.id).toBe(own);
      expect(page.playbackUrl).toContain(`/uploads/${own}?`);
      expect(status(await Promise.resolve(jobLoad(event(user, other))).catch((e) => e))).toBe(404);

      const made = await makeShort(event(user, own));
      expect(made.status).toBe(200);
      const shortId = ((await made.json()) as { job: { id: string } }).job.id;
      // A's second turn gets A's own live Short back, never B's.
      shorts[own] ??= shortId;
      expect(shortId).toBe(shorts[own]);
      expect((await getJob(shortId))!.ownerUid).toBe(user.uid);

      // The API hands back only the caller's own media.
      const api = (await (await getJobApi(event(user, `${own}s`))).json()) as {
        playbackUrl?: string;
      };
      expect(api.playbackUrl).toContain(`/uploads/${own}s-1?`);

      const before = await Promise.all([getJob(other), getJob(`${other}s`)]);
      for (const [name, call] of FOREIGN_CALLS) {
        const outcome = await Promise.resolve(call(user, other, `${other}s`)).catch((e) => e);
        expect([name, status(outcome)]).toEqual([name, 404]);
      }
      expect(await Promise.all([getJob(other), getJob(`${other}s`)])).toEqual(before);
    }
    expect(shorts.a).not.toBe(shorts.b);
  });
});
