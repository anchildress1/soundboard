// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_SCOPE,
  budgetSignal,
  ChannelMismatch,
  channelsByIds,
  quotaSpent,
  searchVideos,
  uploadsOf,
  channelsMine,
  channelStats,
  clearStatsCache,
  DeadlineSpent,
  finalChunk,
  identityFailure,
  outOfTime,
  ownUploads,
  readBack,
  searchMusicVideos,
  sourceRange,
  startResumableUpload,
  thumbnailImage,
  UPLOAD_CHUNK_BYTES,
  uploadChunk,
  uploadFailure,
  uploadOffset,
  videoChannel,
  videoIdFromUrl,
  videosByIds,
  isoSeconds,
  YouTubeError,
} from '#lib/server/platforms/youtube/youtube.js';
import type { PickFields } from '#lib/types.js';

const SESSION_URL = 'https://session';
/** A step deadline with time to spare. */
const later = () => Date.now() + 60_000;

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

// YouTube's answer for the uploads playlist of a channel with no videos.
const missingPlaylist = (reason = 'playlistNotFound') =>
  json({ error: { code: 404, errors: [{ reason }] } }, { status: 404 });

const urlOf = (call: number) => new URL(String(fetchMock.mock.calls[call]![0]));
const initOf = (call: number) => fetchMock.mock.calls[call]![1] as RequestInit;
const headersOf = (call: number) => initOf(call).headers as Record<string, string>;

const channel = {
  items: [
    {
      snippet: { customUrl: '@flieslikerobots', title: 'Flies Like Robots' },
      statistics: { videoCount: '42', subscriberCount: '1200' },
      contentDetails: { relatedPlaylists: { uploads: 'UU123' } },
    },
  ],
};

const playlist = (...ids: (string | undefined)[]) => ({
  items: ids.map((videoId, i) => ({
    contentDetails: { videoId, videoPublishedAt: `2026-0${i + 1}-01T00:00:00Z` },
  })),
});

const video = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  snippet: {
    title: `Title ${id}`,
    description: `About ${id}`,
    tags: ['synthwave'],
    publishedAt: '2026-01-01T00:00:00Z',
    thumbnails: { medium: { url: `https://i.ytimg.com/${id}/m.jpg` } },
    ...extra,
  },
});

beforeEach(() => {
  vi.stubEnv('YOUTUBE_API_KEY', 'key-123');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  clearStatsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('catalog reads', () => {
  it('sends the API key on every read', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [video('a')] }));
    await videosByIds(['a'], later());
    const url = urlOf(0);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/youtube/v3/videos');
    expect(url.searchParams.get('key')).toBe('key-123');
    expect(url.searchParams.get('id')).toBe('a');
    expect(initOf(0).headers).toBeUndefined();
  });

  it('throws when the API key is missing', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    await expect(videosByIds(['a'], later())).rejects.toThrow('YOUTUBE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes no catalog or search request once the deadline has passed', async () => {
    await expect(videosByIds(['a'], Date.now() - 1)).rejects.toBeInstanceOf(DeadlineSpent);
    await expect(searchMusicVideos('q', 5, 'short', Date.now() - 1)).rejects.toBeInstanceOf(
      DeadlineSpent,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the call for an empty id list', async () => {
    expect(await videosByIds([], later())).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps the id list at 50 and maps missing snippet fields to defaults', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          { id: 'bare' },
          { id: 'hi', snippet: { thumbnails: { high: { url: 'h.jpg' } } } },
          { id: 'def', snippet: { thumbnails: { default: { url: 'd.jpg' } } } },
        ],
      }),
    );
    const ids = Array.from({ length: 60 }, (_, i) => `v${i}`);
    const videos = await videosByIds(ids, later());
    expect(urlOf(0).searchParams.get('id')!.split(',')).toHaveLength(50);
    expect(videos[0]).toEqual({
      videoId: 'bare',
      title: '',
      description: '',
      tags: [],
      publishedAt: '',
      thumbnailUrl: null,
      views: 0,
      durationSec: 0,
    });
    expect(videos[1]!.thumbnailUrl).toBe('h.jpg');
    expect(videos[2]!.thumbnailUrl).toBe('d.jpg');
  });

  it('returns an empty list when items is absent', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await videosByIds(['a'], later())).toEqual([]);
  });

  it('wraps non-ok responses in YouTubeError with the status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('quota exceeded', { status: 403 }));
    const error = await videosByIds(['a'], later()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YouTubeError);
    expect((error as YouTubeError).status).toBe(403);
    expect((error as YouTubeError).message).toContain('quota exceeded');
  });
});

describe('channelStats', () => {
  it('reads the channel and its latest upload', async () => {
    fetchMock.mockResolvedValueOnce(json(channel)).mockResolvedValueOnce(json(playlist('v1')));
    const stats = await channelStats('UCflr', 1_000);
    expect(stats).toEqual({
      handle: '@flieslikerobots',
      videoCount: 42,
      subscriberCount: 1200,
      uploadsPlaylist: 'UU123',
      lastUploadAt: '2026-01-01T00:00:00Z',
    });
    expect(urlOf(0).searchParams.get('id')).toBe('UCflr');
    expect(urlOf(0).searchParams.get('key')).toBe('key-123');
    expect(urlOf(1).searchParams.get('playlistId')).toBe('UU123');
    expect(urlOf(1).searchParams.get('maxResults')).toBe('1');
  });

  it('serves the cached value inside 10 minutes and refreshes after', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/channels') ? json(channel) : json(playlist('v1')),
    );
    await channelStats('UCflr', 0);
    await channelStats('UCflr', 10 * 60 * 1000 - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await channelStats('UCflr', 10 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reads a channel with no videos as no latest upload, and caches it', async () => {
    fetchMock.mockResolvedValueOnce(json(channel)).mockResolvedValueOnce(missingPlaylist());
    expect((await channelStats('UCflr', 0)).lastUploadAt).toBeNull();
    await channelStats('UCflr', 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches each channel on its own, never serving one channel for another', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/channels')) return json(playlist('v1'));
      const id = url.searchParams.get('id');
      return json({ items: [{ snippet: { customUrl: `@${id}` } }] });
    });
    expect((await channelStats('UCa', 0)).handle).toBe('@UCa');
    expect((await channelStats('UCb', 0)).handle).toBe('@UCb');
    expect((await channelStats('UCa', 1)).handle).toBe('@UCa');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clearStatsCache forces a fresh read', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/channels') ? json(channel) : json(playlist('v1')),
    );
    await channelStats('UCflr', 0);
    clearStatsCache();
    await channelStats('UCflr', 1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('throws a 404 YouTubeError when the channel is missing', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    const error = await channelStats('UCflr').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YouTubeError);
    expect((error as YouTubeError).status).toBe(404);
  });

  it('falls back to the title and zeros, and skips the playlist read without uploads', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ snippet: { title: 'FLR' } }] }));
    expect(await channelStats('UCflr')).toEqual({
      handle: 'FLR',
      videoCount: 0,
      subscriberCount: 0,
      uploadsPlaylist: '',
      lastUploadAt: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses an empty handle and null lastUploadAt when nothing is known', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] }),
      )
      .mockResolvedValueOnce(json({}));
    const stats = await channelStats('UCflr');
    expect(stats.handle).toBe('');
    expect(stats.lastUploadAt).toBeNull();
  });
});

describe('ownUploads', () => {
  const TOKEN = 'owner-token';
  const mine = (...ids: string[]) => ({
    items: ids.map((id) => ({ id, contentDetails: { relatedPlaylists: { uploads: `UU${id}` } } })),
  });
  const route = (videos: unknown[], ids: (string | undefined)[], channels = mine('UCx')) =>
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/channels')) return json(channels);
      if (url.includes('/playlistItems')) return json(playlist(...ids));
      return json({ items: videos });
    });
  const calls = () => fetchMock.mock.calls.map((_, i) => urlOf(i));

  it("reads the grant's own channel with its bearer token, never the API key or statistics", async () => {
    route([video('a')], ['a']);
    await ownUploads(TOKEN, 'UCx', 3, later());
    expect(calls().map((url) => url.pathname)).toEqual([
      '/youtube/v3/channels',
      '/youtube/v3/playlistItems',
      '/youtube/v3/videos',
    ]);
    for (const [i, url] of calls().entries()) {
      expect(headersOf(i)).toEqual({ authorization: `Bearer ${TOKEN}` });
      expect(url.searchParams.has('key')).toBe(false);
      expect(url.searchParams.get('part')).not.toContain('statistics');
      expect(initOf(i).signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls()[0]!.searchParams.get('mine')).toBe('true');
    expect(calls()[1]!.searchParams.get('playlistId')).toBe('UUUCx');
  });

  it('reads a channel with no videos as no uploads, without a videos read', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/channels') ? json(mine('UCx')) : missingPlaylist(),
    );
    expect(await ownUploads(TOKEN, 'UCx', 3, later())).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads each upload with its privacy status', async () => {
    route(
      [
        { ...video('a'), status: { privacyStatus: 'public' } },
        { ...video('b'), status: { privacyStatus: 'private' } },
        video('c'),
      ],
      ['a', 'b', 'c'],
    );
    const videos = await ownUploads(TOKEN, 'UCx', 3, later());
    expect(calls()[2]!.searchParams.get('part')).toBe('snippet,status');
    expect(videos.map((v) => v.privacy)).toEqual(['public', 'private', null]);
  });

  it('keeps playlist order, limits to count, and asks for a few spare items', async () => {
    route([video('c'), video('a'), video('d'), video('b')], ['a', 'b', 'c', 'd']);
    const videos = await ownUploads(TOKEN, 'UCx', 3, later());
    expect(videos.map((v) => v.videoId)).toEqual(['a', 'b', 'c']);
    expect(videos[0]!.views).toBe(0);
    expect(calls()[1]!.searchParams.get('maxResults')).toBe('8');
    expect(calls()[2]!.searchParams.get('id')).toBe('a,b,c,d');
  });

  it('caps the playlist page at 50', async () => {
    route([], []);
    await ownUploads(TOKEN, 'UCx', 48, later());
    expect(calls()[1]!.searchParams.get('maxResults')).toBe('50');
  });

  it('picks the connected channel out of several on the grant', async () => {
    route([video('a')], ['a'], mine('UCother', 'UCx'));
    await ownUploads(TOKEN, 'UCx', 3, later());
    expect(calls()[1]!.searchParams.get('playlistId')).toBe('UUUCx');
  });

  it("reads a grant that doesn't own the channel as lost access", async () => {
    route([], [], mine('UCother'));
    const error = await ownUploads(TOKEN, 'UCx', 3, later()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YouTubeError);
    expect(identityFailure(error)).toBe('access-lost');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('skips playlist items without a video id', async () => {
    route([video('b'), video('a')], ['a', undefined, 'b']);
    expect((await ownUploads(TOKEN, 'UCx', 5, later())).map((v) => v.videoId)).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty playlist, or a channel with none', async () => {
    route([], []);
    expect(await ownUploads(TOKEN, 'UCx', 5, later())).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    route([], [], { items: [{ id: 'UCx' }] } as never);
    expect(await ownUploads(TOKEN, 'UCx', 5, later())).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('makes no request once the deadline has passed', async () => {
    route([], []);
    const error = await ownUploads(TOKEN, 'UCx', 3, Date.now() - 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeadlineSpent);
    expect(identityFailure(error)).toBe('busy');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a read that stalls past the deadline', async () => {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
        }),
    );
    const started = Date.now();
    const error = await ownUploads(TOKEN, 'UCx', 3, started + 50).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(outOfTime(error)).toBe(true);
    expect(identityFailure(error)).toBe('busy');
  });
});

describe('budgetSignal', () => {
  it('throws DeadlineSpent with no time left, never a RangeError', () => {
    expect(() => budgetSignal(Date.now())).toThrow(DeadlineSpent);
    expect(() => budgetSignal(Date.now() - 1000)).toThrow(DeadlineSpent);
  });

  it('aborts at the deadline', async () => {
    const signal = budgetSignal(Date.now() + 20);
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => signal.addEventListener('abort', resolve));
    expect(outOfTime(signal.reason)).toBe(true);
  });
});

describe('identityFailure', () => {
  const youtube = (status: number, reason?: string) =>
    new YouTubeError(status, `read ${status}`, reason ?? null);
  const gaxios = (status: number, grant?: string) =>
    Object.assign(new Error('gaxios'), {
      config: {},
      status,
      response: { status, data: grant ? { error: grant } : {} },
    });

  it.each([
    ['401', youtube(401)],
    ['403 forbidden', youtube(403, 'forbidden')],
    ['403 insufficientPermissions', youtube(403, 'insufficientPermissions')],
    ['403 channelForbidden', youtube(403, 'channelForbidden')],
    ['403 playlistItemsNotAccessible', youtube(403, 'playlistItemsNotAccessible')],
    ['an unlisted 403 reason', youtube(403, 'somethingNew')],
    ['a 403 with no reason', youtube(403)],
    ['404 playlistNotFound', youtube(404, 'playlistNotFound')],
  ])('reads %s as lost access', (_label, error) => {
    expect(identityFailure(error)).toBe('access-lost');
  });

  it.each([
    ['403 quotaExceeded', youtube(403, 'quotaExceeded')],
    ['403 dailyLimitExceeded', youtube(403, 'dailyLimitExceeded')],
    ['403 rateLimitExceeded', youtube(403, 'rateLimitExceeded')],
    ['403 userRateLimitExceeded', youtube(403, 'userRateLimitExceeded')],
    ['429', youtube(429)],
    ['503', youtube(503)],
    ['a refresh 503', gaxios(503)],
    ['a network error', new TypeError('fetch failed')],
    ['a refresh with no answer', Object.assign(new Error('socket hang up'), { config: {} })],
    ['an AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['a TimeoutError', new DOMException('timed out', 'TimeoutError')],
    ['DeadlineSpent', new DeadlineSpent()],
    ['the channel-mismatch throw', new ChannelMismatch()],
    [
      'a wrapped refresh timeout',
      new Error("Couldn't refresh the YouTube grant.", {
        cause: Object.assign(new Error('aborted'), { code: 'AbortError' }),
      }),
    ],
  ])('reads %s as busy', (_label, error) => {
    expect(identityFailure(error)).toBe('busy');
  });

  it.each([
    ['invalid_client', gaxios(401, 'invalid_client')],
    ['unauthorized_client', gaxios(400, 'unauthorized_client')],
    ['403 accessNotConfigured', youtube(403, 'accessNotConfigured')],
    ['400 keyInvalid', youtube(400, 'keyInvalid')],
    ['a plain 400', youtube(400)],
    ['a wrapped invalid_client', new Error('refresh', { cause: gaxios(401, 'invalid_client') })],
    ['an unrecognized error', new Error('KMS unavailable')],
    ['a thrown string', 'boom'],
  ])('reads %s as the app rejected', (_label, error) => {
    expect(identityFailure(error)).toBe('app-rejected');
  });
});

describe('outOfTime', () => {
  it('is false for any other error', () => {
    expect(outOfTime(new Error('nope'))).toBe(false);
    expect(outOfTime(null)).toBe(false);
  });
});

describe('searchMusicVideos', () => {
  it('asks for music-category videos, top 25 by default', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [{ id: { videoId: 's1' } }, { id: {} }, {}, { id: { videoId: 's2' } }] }),
    );
    expect(await searchMusicVideos('synthwave music video', 25, undefined, later())).toEqual([
      's1',
      's2',
    ]);
    const params = urlOf(0).searchParams;
    expect(urlOf(0).pathname).toBe('/youtube/v3/search');
    expect(params.get('q')).toBe('synthwave music video');
    expect(params.get('type')).toBe('video');
    expect(params.get('videoCategoryId')).toBe('10');
    expect(params.get('order')).toBe('viewCount');
    expect(params.get('maxResults')).toBe('25');
    expect(params.get('part')).toBe('id');
    expect(params.get('key')).toBe('key-123');
  });

  it('honours a custom maxResults and tolerates no items', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await searchMusicVideos('q', 5, undefined, later())).toEqual([]);
    expect(urlOf(0).searchParams.get('maxResults')).toBe('5');
  });

  it('throws on a failed search', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    await expect(searchMusicVideos('q', 25, undefined, later())).rejects.toBeInstanceOf(
      YouTubeError,
    );
  });
});

describe('thumbnailImage', () => {
  it('returns the base64 bytes with the response type', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    );
    expect(await thumbnailImage('https://i.ytimg.com/x.png', later())).toEqual({
      data: 'AQID',
      mime_type: 'image/png',
    });
  });

  it('defaults the type to image/jpeg', async () => {
    const response = new Response(new Uint8Array([255]));
    response.headers.delete('content-type');
    fetchMock.mockResolvedValueOnce(response);
    expect(await thumbnailImage('u', later())).toEqual({ data: '/w==', mime_type: 'image/jpeg' });
  });

  it('returns null for a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    expect(await thumbnailImage('u', later())).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect(await thumbnailImage('u', later())).toBeNull();
  });

  it('returns null without a request once the deadline has passed', async () => {
    expect(await thumbnailImage('u', Date.now() - 1)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds the read by the deadline', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1])));
    await thumbnailImage('u', later());
    expect(initOf(0).signal).toBeInstanceOf(AbortSignal);
  });
});

const fields: PickFields = {
  title: 'PeekaBoo',
  description: 'New one.\n\n#synthwave',
  hashtags: ['#synthwave'],
  tags: ['synthwave', 'PeekaBoo'],
};

describe('startResumableUpload', () => {
  it('opens a private, not-for-kids, music-category session and returns its Location', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { location: 'https://upload/session/1' } }),
    );
    expect(await startResumableUpload('tok', fields, 1234, 'video/mp4')).toBe(
      'https://upload/session/1',
    );
    const url = urlOf(0);
    expect(url.pathname).toBe('/upload/youtube/v3/videos');
    expect(url.searchParams.get('uploadType')).toBe('resumable');
    expect(url.searchParams.get('key')).toBeNull();
    const init = initOf(0);
    expect(init.method).toBe('POST');
    expect(headersOf(0)).toMatchObject({
      authorization: 'Bearer tok',
      'x-upload-content-length': '1234',
      'x-upload-content-type': 'video/mp4',
    });
    const body = JSON.parse(String(init.body)) as {
      snippet: Record<string, unknown>;
      status: Record<string, unknown>;
    };
    expect(body.snippet).toEqual({
      title: 'PeekaBoo',
      description: fields.description,
      tags: fields.tags,
      categoryId: '10',
    });
    expect(body.status).toEqual({ privacyStatus: 'private', selfDeclaredMadeForKids: false });
  });

  it('throws YouTubeError when Location is missing on a 200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const error = await startResumableUpload('tok', fields, 1, 'video/mp4').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(YouTubeError);
    expect((error as YouTubeError).status).toBe(200);
  });

  it('throws YouTubeError on a failed init even with a Location', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('forbidden', { status: 403, headers: { location: 'x' } }),
    );
    await expect(startResumableUpload('tok', fields, 1, 'video/mp4')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('uploadOffset', () => {
  it('resumes after the Range end on a 308', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 308, headers: { range: 'bytes=0-524287' } }),
    );
    expect(await uploadOffset(SESSION_URL, 1_000_000)).toEqual({ done: false, next: 524288 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(SESSION_URL);
    expect(initOf(0).method).toBe('PUT');
    expect(headersOf(0)).toEqual({ 'content-range': 'bytes */1000000', 'content-length': '0' });
  });

  it('starts at 0 when a 308 has no Range header', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 308 }));
    expect(await uploadOffset('s', 10)).toEqual({ done: false, next: 0 });
  });

  it('starts at 0 when the Range header is malformed', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 308, headers: { range: 'garbage' } }),
    );
    expect(await uploadOffset('s', 10)).toEqual({ done: false, next: 0 });
  });

  it('reports done with the video id when the upload already finished', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'vid9' }));
    expect(await uploadOffset('s', 10)).toEqual({ done: true, videoId: 'vid9' });
  });

  it('throws on an expired session', async () => {
    fetchMock.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    await expect(uploadOffset('s', 10)).rejects.toMatchObject({ status: 404 });
  });
});

describe('sourceRange', () => {
  it("reads the chunk's range from GCS", async () => {
    const total = UPLOAD_CHUNK_BYTES * 2 + 10;
    fetchMock.mockResolvedValueOnce(new Response('bytes', { status: 206 }));
    const source = await sourceRange('https://gcs/signed', 0, total);
    expect(source?.status).toBe(206);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://gcs/signed');
    expect(headersOf(0)).toEqual({ range: `bytes=0-${UPLOAD_CHUNK_BYTES - 1}` });
  });

  it('stops the last range at the file end', async () => {
    const offset = UPLOAD_CHUNK_BYTES;
    fetchMock.mockResolvedValueOnce(new Response('tail', { status: 200 }));
    await sourceRange('g', offset, offset + 100);
    expect(headersOf(0)).toEqual({ range: `bytes=${offset}-${offset + 99}` });
  });

  it('returns null once the object is gone', async () => {
    fetchMock.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    expect(await sourceRange('g', 0, 10)).toBeNull();
  });

  it.each([403, 503])('throws a plain error on a GCS %i', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response('denied', { status }));
    const error = await sourceRange('g', 0, 10).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(YouTubeError);
    expect(uploadFailure(error)).toBe('other');
    expect((error as Error).message).toBe(`GCS range read ${status}`);
  });
});

describe('uploadChunk', () => {
  it('streams the open range into the session with Content-Range', async () => {
    const total = UPLOAD_CHUNK_BYTES * 2 + 10;
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 308,
        headers: { range: `bytes=0-${UPLOAD_CHUNK_BYTES - 1}` },
      }),
    );
    const source = new Response('bytes', { status: 206 });
    const result = await uploadChunk(SESSION_URL, source, 0, total);
    expect(result).toEqual({ done: false, next: UPLOAD_CHUNK_BYTES });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(SESSION_URL);
    expect(initOf(0).method).toBe('PUT');
    expect(headersOf(0)).toEqual({
      'content-length': String(UPLOAD_CHUNK_BYTES),
      'content-range': `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${total}`,
    });
    expect(initOf(0).body).toBeInstanceOf(ReadableStream);
  });

  it('sends the last short chunk and returns the video id on 200', async () => {
    const offset = UPLOAD_CHUNK_BYTES;
    const total = offset + 100;
    fetchMock.mockResolvedValueOnce(json({ id: 'newVid' }));
    expect(await uploadChunk('s', new Response('tail'), offset, total)).toEqual({
      done: true,
      videoId: 'newVid',
    });
    expect(headersOf(0)).toEqual({
      'content-length': '100',
      'content-range': `bytes ${offset}-${total - 1}/${total}`,
    });
  });

  it('throws when YouTube rejects the chunk', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 500 }));
    await expect(uploadChunk('s', new Response('x'), 0, 10)).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('channelsMine', () => {
  it("returns the token account's channel, read with the bearer token", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 'UCa', snippet: { title: 'A' } }] }));
    expect(await channelsMine('tok')).toEqual({ id: 'UCa', title: 'A' });
    expect(urlOf(0).searchParams.get('mine')).toBe('true');
    expect(urlOf(0).searchParams.get('part')).toBe('snippet');
    expect(urlOf(0).searchParams.get('key')).toBeNull();
    expect(headersOf(0)).toEqual({ authorization: 'Bearer tok' });
  });

  it('returns an empty title when the channel has none', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 'UCa' }] }));
    expect(await channelsMine('tok')).toEqual({ id: 'UCa', title: '' });
  });

  it.each([{ items: [] }, {}])(
    'returns null for an account without a channel (%j)',
    async (body) => {
      fetchMock.mockResolvedValueOnce(json(body));
      expect(await channelsMine('tok')).toBeNull();
    },
  );

  it('throws on a non-ok read', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    await expect(channelsMine('tok')).rejects.toMatchObject({ status: 403 });
  });
});

describe('readBack', () => {
  it('returns the live metadata with the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [video('pub1')] }));
    const live = await readBack('tok', 'pub1');
    expect(live).toMatchObject({ videoId: 'pub1', title: 'Title pub1', tags: ['synthwave'] });
    expect(urlOf(0).searchParams.get('id')).toBe('pub1');
    expect(urlOf(0).searchParams.get('key')).toBeNull();
    expect(headersOf(0)).toEqual({ authorization: 'Bearer tok' });
  });

  it.each([
    ['uploaded', { status: 'accepted' }],
    ['processed', { status: 'accepted' }],
    ['rejected', { status: 'rejected', uploadStatus: 'rejected' }],
    ['failed', { status: 'rejected', uploadStatus: 'failed' }],
    ['deleted', { status: 'rejected', uploadStatus: 'deleted' }],
    [undefined, { status: 'pending', uploadStatus: null }],
    ['', { status: 'pending', uploadStatus: null }],
    ['someNewStatus', { status: 'pending', uploadStatus: 'someNewStatus' }],
  ])('reads uploadStatus %s as %o', async (uploadStatus, expected) => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [{ ...video('pub1'), status: { uploadStatus } }] }),
    );
    const live = await readBack('tok', 'pub1');
    expect(live).toMatchObject({ videoId: 'pub1', ...expected });
    expect(live && 'uploadStatus' in live).toBe('uploadStatus' in expected);
  });

  it('reads a video with no status part as pending', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [video('pub1')] }));
    expect(await readBack('tok', 'pub1')).toMatchObject({ status: 'pending', uploadStatus: null });
  });

  it('returns null when the video is not listed yet', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect(await readBack('tok', 'pub1')).toBeNull();
  });

  it('returns null when items is absent', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await readBack('tok', 'pub1')).toBeNull();
  });

  it('throws on a non-ok read', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    await expect(readBack('tok', 'pub1')).rejects.toMatchObject({ status: 401 });
  });
});

describe('isoSeconds', () => {
  it.each([
    ['PT1M18S', 78],
    ['PT1H2M3S', 3723],
    ['PT45S', 45],
    ['PT4M', 240],
    ['P1DT1S', 86401],
    ['P0D', 0],
    ['', 0],
    [undefined, 0],
    ['not a duration', 0],
  ])('reads %s as %i seconds', (duration, seconds) => {
    expect(isoSeconds(duration)).toBe(seconds);
  });
});

describe('uploadFailure', () => {
  it.each([
    [404, 'gone'],
    [410, 'expired'],
  ])('reads a %i as a lost upload session', (status, message) => {
    expect(uploadFailure(new YouTubeError(status, message))).toBe('session-lost');
  });

  it('reads a 403 naming the quota as a spent quota, in any case', () => {
    expect(uploadFailure(new YouTubeError(403, 'videos 403: quotaExceeded'))).toBe('quota-spent');
    expect(uploadFailure(new YouTubeError(403, 'QUOTA'))).toBe('quota-spent');
  });

  it.each([400, 403])(
    "reads the channel's uploadLimitExceeded on a %i as a spent limit",
    (status) => {
      const error = new YouTubeError(
        status,
        `upload init ${status}: {"reason":"uploadLimitExceeded"}`,
      );
      expect(uploadFailure(error)).toBe('quota-spent');
    },
  );

  it('reads a 401 as lost access, never a lost session', () => {
    expect(uploadFailure(new YouTubeError(401, 'upload init 401: invalid credentials'))).toBe(
      'access-lost',
    );
  });

  it.each([
    ['a 403 without quota', new YouTubeError(403, 'forbidden')],
    ['a 400 naming another reason', new YouTubeError(400, 'invalidTitle')],
    ['a 499 at the edge of the range', new YouTubeError(499, 'closed')],
  ])('reads %s as denied', (_label, error) => {
    expect(uploadFailure(error)).toBe('denied');
  });

  it.each([
    ['a 429 rate limit', new YouTubeError(429, 'videos.list 429: rateLimitExceeded')],
    ['a 403 rate limit', new YouTubeError(403, 'videos.list 403: rateLimitExceeded')],
    ["a 403 on the user's rate limit", new YouTubeError(403, 'userRateLimitExceeded')],
    ['a status below the 4xx range', new YouTubeError(399, 'odd')],
    ['the upload limit on a 500', new YouTubeError(500, 'uploadLimitExceeded')],
    ['a quota message on another status', new YouTubeError(500, 'quota backend')],
    ['a plain Error with a session status', Object.assign(new Error('x'), { status: 404 })],
    ['a non-error value', 'quota'],
    ['undefined', undefined],
  ])('reads %s as other', (_label, error) => {
    expect(uploadFailure(error)).toBe('other');
  });
});

describe('finalChunk', () => {
  it.each([
    [0, 10, true],
    [0, UPLOAD_CHUNK_BYTES, true],
    [0, UPLOAD_CHUNK_BYTES + 1, false],
    [UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES + 1, true],
  ])('from %i of %i is final: %s', (offset, total, final) => {
    expect(finalChunk(offset, total)).toBe(final);
  });
});

describe('videoChannel', () => {
  it("reads the video's channel through the caller's grant", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          {
            id: 'dQw4w9WgXcQ',
            snippet: { channelId: 'UCflr', publishedAt: '2026-10-18T12:00:00Z' },
          },
        ],
      }),
    );
    expect(await videoChannel('tok', 'dQw4w9WgXcQ')).toEqual({
      channelId: 'UCflr',
      publishedAt: Date.parse('2026-10-18T12:00:00Z'),
    });
    expect(urlOf(0).pathname).toBe('/youtube/v3/videos');
    expect(urlOf(0).searchParams.get('part')).toBe('snippet');
    expect(urlOf(0).searchParams.get('id')).toBe('dQw4w9WgXcQ');
    expect(urlOf(0).searchParams.get('key')).toBeNull();
    expect(headersOf(0)).toEqual({ authorization: 'Bearer tok' });
  });

  it.each([
    ['no items', {}],
    ['an empty list', { items: [] }],
    ['no snippet', { items: [{ id: 'x' }] }],
    ['no publish time', { items: [{ id: 'x', snippet: { channelId: 'UCflr' } }] }],
    ['no channel', { items: [{ id: 'x', snippet: { publishedAt: '2026-10-18T12:00:00Z' } }] }],
  ])('returns null for %s', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(json(body));
    expect(await videoChannel('tok', 'x')).toBeNull();
  });

  it('throws YouTubeError on an error status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await expect(videoChannel('tok', 'x')).rejects.toMatchObject({ status: 401 });
  });
});

describe('videoIdFromUrl', () => {
  const ID = 'dQw4w9WgXcQ';
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=10s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://studio.youtube.com/video/${ID}/edit`,
    `  https://youtu.be/${ID}  `,
  ])('reads the ID from %s', (url) => {
    expect(videoIdFromUrl(url)).toBe(ID);
  });

  it.each([
    '',
    ID,
    'not a url',
    `ftp://youtu.be/${ID}`,
    `https://example.com/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    `https://www.youtube.com/channel/${ID}`,
    `https://studio.youtube.com/channel/${ID}`,
    'https://youtu.be/',
    `https://www.youtube.com/shorts/${ID}x`,
  ])('rejects %j', (url) => {
    expect(videoIdFromUrl(url)).toBeNull();
  });
});

describe('peer reads', () => {
  const quota = () =>
    json(
      { error: { errors: [{ reason: 'quotaExceeded' }] } },
      { status: 403, statusText: 'Forbidden' },
    );

  it('searches by relevance in the music category with the snippet, never by view count', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          { id: { videoId: 'v1' }, snippet: { channelId: 'UC1' } },
          { id: {}, snippet: { channelId: 'UC2' } },
          { id: { videoId: 'v3' }, snippet: {} },
          { id: { videoId: 'v4' }, snippet: { channelId: 'UC1' } },
        ],
      }),
    );
    const hits = await searchVideos(
      'synthwave retrowave music',
      { order: 'relevance', maxResults: 50, categoryId: '10' },
      later(),
    );
    expect(hits).toEqual([
      { videoId: 'v1', channelId: 'UC1' },
      { videoId: 'v4', channelId: 'UC1' },
    ]);
    const url = urlOf(0);
    expect(url.pathname).toBe('/youtube/v3/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      part: 'snippet',
      q: 'synthwave retrowave music',
      type: 'video',
      videoCategoryId: '10',
      order: 'relevance',
      maxResults: '50',
      key: 'key-123',
    });
  });

  it('reads channels with statistics as reported, a hidden count as null and hidden', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          {
            id: 'UC1',
            snippet: { title: 'Peer One', description: 'Synths.' },
            statistics: { subscriberCount: '1200', videoCount: '30', viewCount: '99000' },
            contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
          },
          {
            id: 'UC2',
            snippet: { title: 'Peer Two' },
            statistics: { subscriberCount: '0', hiddenSubscriberCount: true, videoCount: '4' },
          },
          { snippet: { title: 'no id' } },
        ],
      }),
    );
    expect(await channelsByIds(['UC1', 'UC2'], later())).toEqual([
      {
        channelId: 'UC1',
        title: 'Peer One',
        description: 'Synths.',
        uploadsPlaylist: 'UU1',
        stats: { subscribers: 1200, hidden: false, videos: 30, views: 99000 },
      },
      {
        channelId: 'UC2',
        title: 'Peer Two',
        description: '',
        uploadsPlaylist: null,
        stats: { subscribers: null, hidden: true, videos: 4, views: null },
      },
    ]);
    expect(urlOf(0).searchParams.get('part')).toBe('snippet,statistics,contentDetails');
    expect(urlOf(0).searchParams.get('id')).toBe('UC1,UC2');
  });

  it('reads no channels without IDs', async () => {
    expect(await channelsByIds([], later())).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the newest uploads of a playlist in order, statistics as reported or null', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/playlistItems')
        ? json(playlist('a', 'b', undefined))
        : json({
            items: [
              {
                ...video('b'),
                statistics: { viewCount: '10' },
                contentDetails: { duration: 'PT3M1S' },
              },
              {
                ...video('a'),
                statistics: { viewCount: '500', likeCount: '20', commentCount: 'x' },
                contentDetails: { duration: 'PT2M' },
              },
            ],
          }),
    );
    const uploads = await uploadsOf('UU1', 10, later());
    expect(uploads.map((u) => [u.videoId, u.durationSec, u.stats])).toEqual([
      ['a', 120, { views: 500, likes: 20, comments: null }],
      ['b', 181, { views: 10, likes: null, comments: null }],
    ]);
    expect(uploads[0]).not.toHaveProperty('views');
    expect(urlOf(0).searchParams.get('maxResults')).toBe('10');
    expect(urlOf(1).searchParams.get('part')).toBe('snippet,statistics,contentDetails');
  });

  it('reads nothing more for an empty playlist', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await uploadsOf('UU1', 1, later())).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reads a channel with no videos as no uploads, and any other 404 as an error', async () => {
    fetchMock.mockResolvedValueOnce(missingPlaylist());
    expect(await uploadsOf('UU1', 1, later())).toEqual([]);
    fetchMock.mockResolvedValueOnce(missingPlaylist('videoNotFound'));
    await expect(uploadsOf('UU1', 1, later())).rejects.toMatchObject({
      status: 404,
      reason: 'videoNotFound',
    });
  });

  it('reads a spent daily quota as quota, and a rate limit as not', async () => {
    fetchMock.mockResolvedValueOnce(quota());
    const error = await channelsByIds(['UC1'], later()).catch((e: unknown) => e);
    expect(quotaSpent(error)).toBe(true);
    expect(identityFailure(error)).toBe('busy');
    expect(quotaSpent(new YouTubeError(403, 'x', 'rateLimitExceeded'))).toBe(false);
    expect(quotaSpent(new YouTubeError(500, 'x', 'quotaExceeded'))).toBe(false);
    expect(quotaSpent(new Error('quotaExceeded'))).toBe(false);
  });

  it('starts no read once the deadline is spent', async () => {
    await expect(
      searchVideos('q', { order: 'relevance', maxResults: 50, categoryId: '10' }, Date.now() - 1),
    ).rejects.toBeInstanceOf(DeadlineSpent);
    await expect(uploadsOf('UU1', 1, Date.now() - 1)).rejects.toBeInstanceOf(DeadlineSpent);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the analytics scope', () => {
    expect(ANALYTICS_SCOPE).toBe('https://www.googleapis.com/auth/yt-analytics.readonly');
  });
});
