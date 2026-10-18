// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  channelsMine,
  channelStats,
  clearStatsCache,
  finalChunk,
  quotaResetAt,
  readBack,
  recentVideos,
  searchMusicVideos,
  sourceRange,
  startResumableUpload,
  thumbnailDataUrl,
  UPLOAD_CHUNK_BYTES,
  uploadChunk,
  uploadFailure,
  uploadOffset,
  videoChannel,
  videoIdFromUrl,
  videosByIds,
  isoSeconds,
  YouTubeError,
  YOUTUBE_SCOPES,
} from '$lib/server/platforms/youtube/youtube';
import type { PickFields } from '$lib/types';

const SESSION_URL = 'https://session';

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

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
  vi.stubEnv('FLR_CHANNEL_ID', 'UCflr');
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
    await videosByIds(['a']);
    const url = urlOf(0);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/youtube/v3/videos');
    expect(url.searchParams.get('key')).toBe('key-123');
    expect(url.searchParams.get('id')).toBe('a');
    expect(initOf(0).headers).toBeUndefined();
  });

  it('throws when the API key is missing', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    await expect(videosByIds(['a'])).rejects.toThrow('YOUTUBE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the call for an empty id list', async () => {
    expect(await videosByIds([])).toEqual([]);
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
    const videos = await videosByIds(ids);
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
    expect(await videosByIds(['a'])).toEqual([]);
  });

  it('wraps non-ok responses in YouTubeError with the status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('quota exceeded', { status: 403 }));
    const error = await videosByIds(['a']).catch((e: unknown) => e);
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

describe('recentVideos', () => {
  const route = (videos: unknown[], ids: (string | undefined)[]) =>
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/channels')) return json(channel);
      if (url.includes('/playlistItems')) {
        return new URL(url).searchParams.get('maxResults') === '1'
          ? json(playlist(ids[0]))
          : json(playlist(...ids));
      }
      return json({ items: videos });
    });

  it('keeps playlist order and limits to count', async () => {
    route([video('c'), video('a'), video('d'), video('b')], ['a', 'b', 'c', 'd']);
    const videos = await recentVideos('UCx', 3);
    expect(videos.map((v) => v.videoId)).toEqual(['a', 'b', 'c']);
    const channelCall = fetchMock.mock.calls.findIndex(([u]) => String(u).includes('/channels'));
    expect(urlOf(channelCall).searchParams.get('id')).toBe('UCx');
    const listCall = fetchMock.mock.calls.findIndex(([u]) => String(u).includes('/videos?'));
    expect(urlOf(listCall).searchParams.get('id')).toBe('a,b,c,d');
    const pageCall = fetchMock.mock.calls.findIndex(
      ([u]) => String(u).includes('/playlistItems') && String(u).includes('maxResults=8'),
    );
    expect(pageCall).toBeGreaterThan(-1);
  });

  it('skips playlist items without a video id', async () => {
    route([video('b'), video('a')], ['a', undefined, 'b']);
    const videos = await recentVideos('UCx', 5);
    expect(videos.map((v) => v.videoId)).toEqual(['a', 'b']);
  });

  it('returns nothing when the playlist is empty', async () => {
    route([], []);
    expect(await recentVideos('UCx', 5)).toEqual([]);
  });
});

describe('searchMusicVideos', () => {
  it('asks for music-category videos, top 25 by default', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [{ id: { videoId: 's1' } }, { id: {} }, {}, { id: { videoId: 's2' } }] }),
    );
    expect(await searchMusicVideos('synthwave music video')).toEqual(['s1', 's2']);
    const params = urlOf(0).searchParams;
    expect(urlOf(0).pathname).toBe('/youtube/v3/search');
    expect(params.get('q')).toBe('synthwave music video');
    expect(params.get('type')).toBe('video');
    expect(params.get('videoCategoryId')).toBe('10');
    expect(params.get('maxResults')).toBe('25');
    expect(params.get('part')).toBe('id');
    expect(params.get('key')).toBe('key-123');
  });

  it('honours a custom maxResults and tolerates no items', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await searchMusicVideos('q', 5)).toEqual([]);
    expect(urlOf(0).searchParams.get('maxResults')).toBe('5');
  });

  it('throws on a failed search', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    await expect(searchMusicVideos('q')).rejects.toBeInstanceOf(YouTubeError);
  });
});

describe('thumbnailDataUrl', () => {
  it('returns a base64 data URL with the response type', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    );
    expect(await thumbnailDataUrl('https://i.ytimg.com/x.png')).toBe('data:image/png;base64,AQID');
  });

  it('defaults the type to image/jpeg', async () => {
    const response = new Response(new Uint8Array([255]));
    response.headers.delete('content-type');
    fetchMock.mockResolvedValueOnce(response);
    expect(await thumbnailDataUrl('u')).toBe('data:image/jpeg;base64,/w==');
  });

  it('returns null for a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    expect(await thumbnailDataUrl('u')).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect(await thumbnailDataUrl('u')).toBeNull();
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

describe('quotaResetAt', () => {
  it.each([
    ['a winter afternoon', '2026-01-15T20:00:00Z', '2026-01-16T08:00:00Z'],
    ['a summer afternoon', '2026-07-15T19:00:00Z', '2026-07-16T07:00:00Z'],
    ['the day clocks spring forward', '2026-03-08T19:00:00Z', '2026-03-09T07:00:00Z'],
    ['the day before they spring forward', '2026-03-07T20:00:00Z', '2026-03-08T08:00:00Z'],
    ['the day clocks fall back', '2026-11-01T20:00:00Z', '2026-11-02T08:00:00Z'],
    ['the day before they fall back', '2026-10-31T19:00:00Z', '2026-11-01T07:00:00Z'],
    ['Pacific midnight itself', '2026-10-18T07:00:00Z', '2026-10-19T07:00:00Z'],
    ['the last second of a Pacific day', '2026-10-19T06:59:59.999Z', '2026-10-19T07:00:00Z'],
    ['a UTC date ahead of the Pacific one', '2026-12-31T23:30:00Z', '2027-01-01T08:00:00Z'],
  ])('resets at the next Pacific midnight on %s', (_label, now, reset) => {
    expect(new Date(quotaResetAt(Date.parse(now))).toISOString()).toBe(
      new Date(reset).toISOString(),
    );
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

describe('YOUTUBE_SCOPES', () => {
  it('asks for upload and read-back only', () => {
    expect(YOUTUBE_SCOPES).toEqual([
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ]);
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
