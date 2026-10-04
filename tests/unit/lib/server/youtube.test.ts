// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  channelStats,
  clearStatsCache,
  readBack,
  recentVideos,
  searchMusicVideos,
  startResumableUpload,
  thumbnailDataUrl,
  UPLOAD_CHUNK_BYTES,
  uploadChunk,
  uploadOffset,
  videosByIds,
  isoSeconds,
  YouTubeError,
} from '$lib/server/youtube';
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
    const stats = await channelStats(1_000);
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
    await channelStats(0);
    await channelStats(10 * 60 * 1000 - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await channelStats(10 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('clearStatsCache forces a fresh read', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/channels') ? json(channel) : json(playlist('v1')),
    );
    await channelStats(0);
    clearStatsCache();
    await channelStats(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('throws a 404 YouTubeError when the channel is missing', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    const error = await channelStats().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YouTubeError);
    expect((error as YouTubeError).status).toBe(404);
  });

  it('falls back to the title and zeros, and skips the playlist read without uploads', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ snippet: { title: 'FLR' } }] }));
    expect(await channelStats()).toEqual({
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
    const stats = await channelStats();
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

  it('keeps playlist order, drops the excluded id, and limits to count', async () => {
    route([video('c'), video('a'), video('d'), video('b')], ['a', 'b', 'x', 'c', 'd']);
    const videos = await recentVideos(3, 'x');
    expect(videos.map((v) => v.videoId)).toEqual(['a', 'b', 'c']);
    const listCall = fetchMock.mock.calls.findIndex(([u]) => String(u).includes('/videos?'));
    expect(urlOf(listCall).searchParams.get('id')).toBe('a,b,c,d');
    const pageCall = fetchMock.mock.calls.findIndex(
      ([u]) => String(u).includes('/playlistItems') && String(u).includes('maxResults=8'),
    );
    expect(pageCall).toBeGreaterThan(-1);
  });

  it('keeps every id when nothing is excluded and skips items without a video id', async () => {
    route([video('b'), video('a')], ['a', undefined, 'b']);
    const videos = await recentVideos(5, null);
    expect(videos.map((v) => v.videoId)).toEqual(['a', 'b']);
  });

  it('returns nothing when the playlist is empty', async () => {
    route([], []);
    expect(await recentVideos(5, null)).toEqual([]);
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

describe('uploadChunk', () => {
  it('reads a range from GCS and forwards it with Content-Range', async () => {
    const total = UPLOAD_CHUNK_BYTES * 2 + 10;
    fetchMock.mockResolvedValueOnce(new Response('bytes', { status: 206 })).mockResolvedValueOnce(
      new Response(null, {
        status: 308,
        headers: { range: `bytes=0-${UPLOAD_CHUNK_BYTES - 1}` },
      }),
    );
    const result = await uploadChunk(SESSION_URL, 'https://gcs/signed', 0, total);
    expect(result).toEqual({ done: false, next: UPLOAD_CHUNK_BYTES });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://gcs/signed');
    expect(headersOf(0)).toEqual({ range: `bytes=0-${UPLOAD_CHUNK_BYTES - 1}` });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(SESSION_URL);
    expect(initOf(1).method).toBe('PUT');
    expect(headersOf(1)).toEqual({
      'content-length': String(UPLOAD_CHUNK_BYTES),
      'content-range': `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${total}`,
    });
    expect(initOf(1).body).toBeInstanceOf(ReadableStream);
  });

  it('sends the last short chunk and returns the video id on 200', async () => {
    const offset = UPLOAD_CHUNK_BYTES;
    const total = offset + 100;
    fetchMock
      .mockResolvedValueOnce(new Response('tail', { status: 200 }))
      .mockResolvedValueOnce(json({ id: 'newVid' }));
    expect(await uploadChunk('s', 'g', offset, total)).toEqual({ done: true, videoId: 'newVid' });
    expect(headersOf(0)).toEqual({ range: `bytes=${offset}-${total - 1}` });
    expect(headersOf(1)).toEqual({
      'content-length': '100',
      'content-range': `bytes ${offset}-${total - 1}/${total}`,
    });
  });

  it('throws YouTubeError on a bad GCS status without touching the session', async () => {
    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    const error = await uploadChunk('s', 'g', 0, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YouTubeError);
    expect((error as YouTubeError).message).toBe('GCS range read 403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when YouTube rejects the chunk', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('x', { status: 206 }))
      .mockResolvedValueOnce(new Response('bad', { status: 500 }));
    await expect(uploadChunk('s', 'g', 0, 10)).rejects.toMatchObject({ status: 500 });
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
