// @vitest-environment node
import { eq } from 'drizzle-orm';
import { captureException } from '@sentry/sveltekit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '$lib/server/core/db';
import { connections } from '$lib/server/core/schema';
import { clearStatsCache } from '$lib/server/platforms/youtube/youtube';
import { load } from '$routes/+layout.server';
import { seed, truncate } from '../../helpers/db';
import { CHANNEL_A, USER_A, USER_B, USERS } from '../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
type Data = { channel: unknown; user: unknown };

const run = async (user: Event['locals']['user']) =>
  (await load({ locals: { user } } as unknown as Event)) as Data;

const fetchMock = vi.fn<typeof fetch>();

/** Answers the channel read with a handle named after the requested channel ID. */
function youtube() {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/channels'))
      return Response.json({
        items: [{ contentDetails: { videoPublishedAt: '2026-09-20T00:00:00Z' } }],
      });
    return Response.json({
      items: [
        {
          snippet: { customUrl: `@${url.searchParams.get('id')}` },
          statistics: { videoCount: '12', subscriberCount: '340' },
          contentDetails: { relatedPlaylists: { uploads: 'UUflr' } },
        },
      ],
    });
  });
}

const connectB = (status: 'connected' | 'revoked' = 'connected') =>
  seed({
    connections: [
      {
        uid: USER_B.uid,
        status,
        channelId: 'UCb',
        channelTitle: 'B',
        scopes: [],
        tokenCiphertext: status === 'connected' ? 'c2VhbGVk' : null,
        updatedAt: new Date(0),
      },
    ],
  });

beforeEach(async () => {
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  clearStatsCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  await truncate();
  await seed(USERS);
  youtube();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('layout load', () => {
  it("returns the signed-in user's own connected channel stats", async () => {
    const data = await run(USER_A);
    expect(data.channel).toEqual({
      handle: `@${CHANNEL_A}`,
      videoCount: 12,
      subscriberCount: 340,
      uploadsPlaylist: 'UUflr',
      lastUploadAt: '2026-09-20T00:00:00Z',
    });
    expect(data.user).toEqual({ email: USER_A.email, artistId: 'flr' });
  });

  it("shows an unlinked user their own channel, never another user's", async () => {
    await connectB();
    expect(((await run(USER_A)).channel as { handle: string }).handle).toBe(`@${CHANNEL_A}`);
    expect(((await run(USER_B)).channel as { handle: string }).handle).toBe('@UCb');
  });

  it.each([
    ['signed out', null],
    ['a user without a connection', USER_B],
  ])('reads no channel stats when %s', async (_label, user) => {
    const data = await run(user);
    expect(data.channel).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads no stats for a connection that is not connected', async () => {
    await connectB('revoked');
    expect((await run(USER_B)).channel).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders without stats when the read key is missing', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    expect((await run(USER_A)).channel).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders without stats when YouTube errors, reporting it', async () => {
    vi.mocked(captureException).mockClear();
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const data = await run(USER_A);
    expect(data.channel).toBeNull();
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(expect.any(Error), {
      tags: { component: 'header-stats' },
    });
  });

  it('passes only the email and artist link of the user', async () => {
    expect((await run(USER_B)).user).toEqual({ email: USER_B.email, artistId: null });
    expect((await run(null)).user).toBeNull();
  });

  it('reads the connection fresh, so a disconnect hides the stats at once', async () => {
    await run(USER_A);
    await db().delete(connections).where(eq(connections.uid, USER_A.uid));
    expect((await run(USER_A)).channel).toBeNull();
  });
});
