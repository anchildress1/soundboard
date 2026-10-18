// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearStatsCache } from '$lib/server/platforms/youtube/youtube';
import { load } from '$routes/+layout.server';
import { USER_A, USER_B } from '../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
type Data = { channel: unknown; user: unknown };

const run = async (user: Event['locals']['user']) =>
  (await load({ locals: { user } } as unknown as Event)) as Data;

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const STATS = {
  items: [
    {
      snippet: { customUrl: '@flieslikerobots' },
      statistics: { videoCount: '12', subscriberCount: '340' },
      contentDetails: { relatedPlaylists: { uploads: 'UUflr' } },
    },
  ],
};

beforeEach(() => {
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  vi.stubEnv('FLR_CHANNEL_ID', 'UCflr');
  clearStatsCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('layout load', () => {
  it("returns FLR channel stats to the artist's user", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/channels?')
        ? json(STATS)
        : json({ items: [{ contentDetails: { videoPublishedAt: '2026-09-20T00:00:00Z' } }] }),
    );
    const data = await run(USER_A);
    expect(data.channel).toEqual({
      handle: '@flieslikerobots',
      videoCount: 12,
      subscriberCount: 340,
      uploadsPlaylist: 'UUflr',
      lastUploadAt: '2026-09-20T00:00:00Z',
    });
    expect(data.user).toEqual({ email: USER_A.email, artistId: 'flr' });
  });

  it.each([
    ['signed out', null],
    ['an unlinked user', USER_B],
  ])('reads no channel stats when %s', async (_label, user) => {
    const data = await run(user);
    expect(data.channel).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders without stats when the read key is missing', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    expect((await run(USER_A)).channel).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders without stats when YouTube errors', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    expect((await run(USER_A)).channel).toBeNull();
  });

  it('passes only the email and artist link of the user', async () => {
    expect((await run(USER_B)).user).toEqual({ email: USER_B.email, artistId: null });
    expect((await run(null)).user).toBeNull();
  });
});
