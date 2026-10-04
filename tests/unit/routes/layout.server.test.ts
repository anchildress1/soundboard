// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearStatsCache } from '$lib/server/youtube';
import { load } from '$routes/+layout.server';

type Event = Parameters<typeof load>[0];
type Data = { channel: unknown; session: unknown };

const run = async (session: Event['locals']['session']) =>
  (await load({ locals: { session } } as unknown as Event)) as Data;

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

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
  it('returns FLR channel stats and no session when signed out', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/channels?')
        ? json({
            items: [
              {
                snippet: { customUrl: '@flieslikerobots' },
                statistics: { videoCount: '12', subscriberCount: '340' },
                contentDetails: { relatedPlaylists: { uploads: 'UUflr' } },
              },
            ],
          })
        : json({ items: [{ contentDetails: { videoPublishedAt: '2026-09-20T00:00:00Z' } }] }),
    );
    const data = await run(null);
    expect(data.channel).toEqual({
      handle: '@flieslikerobots',
      videoCount: 12,
      subscriberCount: 340,
      uploadsPlaylist: 'UUflr',
      lastUploadAt: '2026-09-20T00:00:00Z',
    });
    expect(data.session).toBeNull();
  });

  it('renders without stats when the read key is missing', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    const data = await run(null);
    expect(data.channel).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders without stats when YouTube errors', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    expect((await run(null)).channel).toBeNull();
  });

  it('passes only the email, allowlist, and demo flags of the session', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const session = { email: 'nathan@example.com', allowlisted: true, demo: false, extra: 'x' };
    expect((await run(session as Event['locals']['session'])).session).toEqual({
      email: 'nathan@example.com',
      allowlisted: true,
      demo: false,
    });
  });
});
