// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { getJob } from '$lib/server/jobs/jobs';
import { clearStatsCache } from '$lib/server/platforms/youtube/youtube';
import { load as layoutLoad } from '$routes/+layout.server';
import { load as homeLoad } from '$routes/+page.server';
import { load as jobLoad } from '$routes/jobs/[id]/+page.server';
import { POST as makeShort } from '$routes/api/jobs/[id]/short/+server';
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

const event = (user: User, id?: string) =>
  ({ locals: { user }, params: id ? { id } : {} }) as never;
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
  }
});

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
      const foreign = Promise.resolve(makeShort(event(user, other)));
      expect(status(await foreign.catch((e: unknown) => e))).toBe(404);
    }
    expect(shorts.a).not.toBe(shorts.b);
  });
});
