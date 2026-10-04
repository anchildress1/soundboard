// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  audienceEvidence,
  CANDIDATE_LIMIT,
  durationBucket,
  genreTerms,
  LENGTH_TOLERANCE_SEC,
  rankHashtags,
  rankTags,
  searchQuery,
  similarLength,
  TAG_CANDIDATE_LIMIT,
  TOP_VIDEO_COUNT,
  topVideos,
} from '$lib/server/hashtags';
import type { CatalogVideo } from '$lib/server/youtube';
import type { Chunk } from '$lib/types';

const SYNTHWAVE_TAG = '#synthwave';
const INDUSTRIAL = '#industrial';

const chunk = (genre: string[] | null): Chunk => ({
  index: 0,
  startSec: 0,
  durationSec: 29.5,
  measurements: {
    integratedLufs: -14,
    truePeakDbtp: -1,
    peakLevelDb: -1,
    clippedSamples: 0,
    silences: [],
  },
  analysis: genre
    ? {
        visual: '',
        music: { genre, tempoFeel: '', instrumentation: [], vocals: '', mood: [] },
        qualityFlags: [],
      }
    : null,
  raw: genre ? null : 'x',
  modelMs: 1,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('YOUTUBE_API_KEY', 'test-key');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('genreTerms', () => {
  it('returns the most frequent genres, case-folded and trimmed', () => {
    const chunks = [
      chunk(['Synthwave', 'indie']),
      chunk([' synthwave', 'darkwave']),
      chunk(['darkwave', 'synthwave']),
    ];
    expect(genreTerms(chunks)).toEqual(['synthwave', 'darkwave']);
    expect(genreTerms(chunks, 3)).toEqual(['synthwave', 'darkwave', 'indie']);
  });

  it('folds an umbrella genre into the more specific heard genre that contains it', () => {
    const chunks = [
      chunk(['electronic', 'synthwave']),
      chunk(['electronic', 'industrial electronic']),
      chunk(['Electronic', 'lo-fi']),
    ];
    expect(genreTerms(chunks)).toEqual(['industrial electronic', 'synthwave']);
  });

  it('folds through a chain of more specific genres', () => {
    const chunks = [
      chunk(['rock']),
      chunk(['indie rock']),
      chunk(['lo-fi indie rock']),
      chunk(['pop']),
    ];
    expect(genreTerms(chunks, 3)).toEqual(['lo-fi indie rock', 'pop']);
  });

  it('only folds whole words, so "pop" stays apart from "synthpop"', () => {
    expect(genreTerms([chunk(['pop', 'synthpop']), chunk(['pop'])])).toEqual(['pop', 'synthpop']);
  });

  it('skips blank genres and chunks without analysis', () => {
    expect(genreTerms([chunk(null), chunk(['  ', ''])])).toEqual([]);
    expect(genreTerms([])).toEqual([]);
  });
});

describe('rankHashtags', () => {
  it('ranks by how many descriptions use a tag, ties in first-seen order', () => {
    const ranked = rankHashtags([
      '#indie #synthwave',
      '#Synthwave #synthwave #newmusic',
      '#newmusic #synthwave',
      '#lofi',
    ]);
    expect(ranked).toEqual([SYNTHWAVE_TAG, '#newmusic', '#indie', '#lofi']);
  });

  it('caps the list', () => {
    const descriptions = Array.from({ length: 40 }, (_, i) => `#tag${i}`);
    expect(rankHashtags(descriptions)).toHaveLength(CANDIDATE_LIMIT);
    expect(rankHashtags(descriptions, 3)).toEqual(['#tag0', '#tag1', '#tag2']);
  });

  it('returns nothing when no description has hashtags', () => {
    expect(rankHashtags(['plain', ''])).toEqual([]);
  });
});

describe('searchQuery', () => {
  it('seeds the search with the top two genre terms', () => {
    expect(searchQuery([chunk(['synthwave', 'indie', 'pop']), chunk(['indie'])])).toBe(
      'indie synthwave music video',
    );
  });

  it('falls back to a bare music video search', () => {
    expect(searchQuery([])).toBe('music video');
  });
});

const video = (
  id: string,
  views: number,
  tags: string[],
  description = '',
  durationSec = 180,
): CatalogVideo => ({
  videoId: id,
  title: `Title ${id}`,
  publishedAt: '',
  thumbnailUrl: null,
  description,
  tags,
  views,
  durationSec,
});

describe('durationBucket', () => {
  it.each([
    [0, 'short'],
    [179, 'short'],
    [180, undefined],
    [299, undefined],
    [300, 'medium'],
    [1140, 'medium'],
    [1141, undefined],
    [1261, 'long'],
  ])('puts a %is upload in %s', (seconds, bucket) => {
    expect(durationBucket(seconds)).toBe(bucket);
  });
});

describe('similarLength', () => {
  it('keeps videos within a minute either side, inclusive', () => {
    const videos = [
      video('short', 1, [], '', 120 - LENGTH_TOLERANCE_SEC - 1),
      video('lo', 1, [], '', 120 - LENGTH_TOLERANCE_SEC),
      video('same', 1, [], '', 120),
      video('hi', 1, [], '', 120 + LENGTH_TOLERANCE_SEC),
      video('mix', 1, [], '', 3600),
    ];
    expect(similarLength(videos, 120).map((v) => v.videoId)).toEqual(['lo', 'same', 'hi']);
  });

  it('never counts a result whose length is unknown', () => {
    expect(similarLength([video('unknown', 1, [], '', 0)], 30)).toEqual([]);
  });
});

describe('rankTags', () => {
  it('ranks by how many videos use a tag, then by their total views, keeping first spelling', () => {
    const tags = rankTags([
      video('a', 10, ['Synthwave', 'outrun', 'retro']),
      video('b', 500, ['synthwave', 'darkwave']),
      video('c', 20, ['SYNTHWAVE', 'outrun']),
    ]);
    expect(tags).toEqual([
      { tag: 'Synthwave', usedBy: 3 },
      { tag: 'outrun', usedBy: 2 },
      { tag: 'darkwave', usedBy: 1 },
      { tag: 'retro', usedBy: 1 },
    ]);
  });

  it("counts a result's description hashtags as tags, once per video", () => {
    const tags = rankTags([
      video('a', 10, ['glitch'], 'New one #Glitch #industrial'),
      video('b', 5, [], INDUSTRIAL),
    ]);
    expect(tags).toEqual([
      { tag: 'industrial', usedBy: 2 },
      { tag: 'glitch', usedBy: 1 },
    ]);
  });

  it('drops hashtags, blanks, and repeats within one video', () => {
    expect(rankTags([video('a', 1, [SYNTHWAVE_TAG, '  ', 'retro', 'Retro '])])).toEqual([
      { tag: 'retro', usedBy: 1 },
    ]);
  });

  it('honours the limit and returns nothing for untagged videos', () => {
    const many = Array.from({ length: TAG_CANDIDATE_LIMIT + 5 }, (_, i) => `t${i}`);
    expect(rankTags([video('a', 1, many)])).toHaveLength(TAG_CANDIDATE_LIMIT);
    expect(rankTags([video('a', 1, [])])).toEqual([]);
  });
});

describe('topVideos', () => {
  it('keeps the most-viewed results with clipped descriptions', () => {
    const videos = Array.from({ length: 7 }, (_, i) =>
      video(`v${i}`, i * 100, ['x'], 'd'.repeat(900)),
    );
    const top = topVideos(videos);
    expect(top).toHaveLength(TOP_VIDEO_COUNT);
    expect(top.map((v) => v.views)).toEqual([600, 500, 400, 300, 200]);
    expect(top[0]).toEqual({
      title: 'Title v6',
      description: 'd'.repeat(700),
      tags: ['x'],
      views: 600,
    });
  });
});

describe('audienceEvidence', () => {
  it('derives hashtags, tags, and top videos from one genre search', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ items: [{ id: { videoId: 'v1' } }, { id: {} }, { id: { videoId: 'v2' } }] }),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            {
              id: 'v1',
              snippet: { title: 'One', description: '#synthwave #retro', tags: ['synthwave'] },
              statistics: { viewCount: '100' },
            },
            {
              id: 'v2',
              snippet: { title: 'Two', description: '#Synthwave #80s', tags: ['synthwave', '80s'] },
              statistics: { viewCount: '900' },
            },
          ],
        }),
      );

    const evidence = await audienceEvidence([chunk(['synthwave'])], null);

    expect(evidence.query).toBe('synthwave music video');
    expect(evidence.hashtags).toEqual([SYNTHWAVE_TAG, '#retro', '#80s']);
    expect(evidence.tags).toEqual([
      { tag: 'synthwave', usedBy: 2 },
      { tag: '80s', usedBy: 1 },
      { tag: 'retro', usedBy: 1 },
    ]);
    expect(evidence.top.map((v) => v.title)).toEqual(['Two', 'One']);
    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.pathname).toBe('/youtube/v3/search');
    expect(searchUrl.searchParams.get('q')).toBe('synthwave music video');
    expect(searchUrl.searchParams.get('videoCategoryId')).toBe('10');
    expect(searchUrl.searchParams.get('key')).toBe('test-key');
    const videosUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(videosUrl.pathname).toBe('/youtube/v3/videos');
    expect(videosUrl.searchParams.get('id')).toBe('v1,v2');
    expect(videosUrl.searchParams.get('part')).toBe('snippet,statistics,contentDetails');
    expect(searchUrl.searchParams.has('videoDuration')).toBe(false);
  });

  it("searches 50 results in the upload's length bucket and keeps those within a minute", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ items: ['near', 'mix', 'far'].map((videoId) => ({ id: { videoId } })) }),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            {
              id: 'near',
              snippet: { title: 'Near', description: INDUSTRIAL, tags: ['industrial'] },
              statistics: { viewCount: '10' },
              contentDetails: { duration: 'PT1M40S' },
            },
            {
              id: 'mix',
              snippet: { title: 'Mix', description: '#studymusic', tags: ['study music'] },
              statistics: { viewCount: '9000000' },
              contentDetails: { duration: 'PT1H2M' },
            },
            {
              id: 'far',
              snippet: { title: 'Far', description: '#vaporwave', tags: ['vaporwave'] },
              statistics: { viewCount: '500' },
              contentDetails: { duration: 'PT3M30S' },
            },
          ],
        }),
      );

    const evidence = await audienceEvidence([chunk(['industrial'])], 78);

    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.searchParams.get('maxResults')).toBe('50');
    expect(searchUrl.searchParams.get('videoDuration')).toBe('short');
    expect(evidence.top.map((v) => v.title)).toEqual(['Near']);
    expect(evidence.hashtags).toEqual([INDUSTRIAL]);
    expect(evidence.tags).toEqual([{ tag: 'industrial', usedBy: 1 }]);
  });

  it("leaves a sample's own live video out of the evidence", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ items: [{ id: { videoId: 'live' } }, { id: { videoId: 'v1' } }] }),
      )
      .mockResolvedValueOnce(json({ items: [] }));
    await audienceEvidence([chunk(['synthwave'])], null, 'live');
    const videosUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(videosUrl.searchParams.get('id')).toBe('v1');
  });

  it('searches every length when the window crosses a bucket edge', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await audienceEvidence([chunk(['synthwave'])], 230);
    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.searchParams.has('videoDuration')).toBe(false);
  });

  it('returns empty evidence when no result is close to the upload length', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ id: { videoId: 'mix' } }] }))
      .mockResolvedValueOnce(
        json({
          items: [
            { id: 'mix', snippet: { tags: ['study music'] }, contentDetails: { duration: 'PT1H' } },
          ],
        }),
      );
    const evidence = await audienceEvidence([], 200);
    expect(evidence).toMatchObject({ hashtags: [], tags: [], top: [] });
  });

  it('returns empty evidence and skips the videos lookup when the search finds nothing', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await audienceEvidence([], null)).toEqual({
      query: 'music video',
      hashtags: [],
      tags: [],
      top: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the YouTube search fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('quotaExceeded', { status: 403 }));
    await expect(audienceEvidence([], null)).rejects.toThrow('search 403: quotaExceeded');
  });

  it('rejects without an API key and makes no request', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    await expect(audienceEvidence([], null)).rejects.toThrow('YOUTUBE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
