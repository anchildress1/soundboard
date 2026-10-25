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
} from '#lib/server/pipeline/hashtags.js';
import type { CatalogVideo } from '#lib/server/platforms/youtube/youtube.js';
import type { Chunk } from '#lib/types.js';

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
const RETRIEVED_AT = Date.UTC(2026, 9, 22);

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(RETRIEVED_AT);
  vi.stubEnv('YOUTUBE_API_KEY', 'test-key');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
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
  it('deduplicates one description in first-seen order', () => {
    expect(rankHashtags('#indie #Synthwave #synthwave #newmusic #indie')).toEqual([
      '#indie',
      SYNTHWAVE_TAG,
      '#newmusic',
    ]);
  });

  it('caps the list without weighting repeated hashtags', () => {
    const description = Array.from({ length: 40 }, (_, i) => `#tag${i}`).join(' ');
    expect(rankHashtags(description)).toHaveLength(CANDIDATE_LIMIT);
    expect(rankHashtags(description, 3)).toEqual(['#tag0', '#tag1', '#tag2']);
  });

  it('returns nothing when the description has no hashtags', () => {
    expect(rankHashtags('plain')).toEqual([]);
    expect(rankHashtags('')).toEqual([]);
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
  it('keeps first-seen spelling and order within one video', () => {
    expect(rankTags(video('a', 10, ['Synthwave', 'outrun', 'synthwave', 'retro']))).toEqual([
      { tag: 'Synthwave' },
      { tag: 'outrun' },
      { tag: 'retro' },
    ]);
  });

  it("includes the video's description hashtags without counting repetitions", () => {
    expect(rankTags(video('a', 10, ['glitch'], '#Glitch #industrial #industrial'))).toEqual([
      { tag: 'glitch' },
      { tag: 'industrial' },
    ]);
  });

  it('drops hashtags, blanks, and repeats', () => {
    expect(rankTags(video('a', 1, [SYNTHWAVE_TAG, '  ', 'retro', 'Retro ']))).toEqual([
      { tag: 'retro' },
    ]);
  });

  it('honours the limit and returns nothing for untagged videos', () => {
    const many = Array.from({ length: TAG_CANDIDATE_LIMIT + 5 }, (_, i) => `t${i}`);
    expect(rankTags(video('a', 1, many))).toHaveLength(TAG_CANDIDATE_LIMIT);
    expect(rankTags(video('a', 1, many), 2)).toEqual([{ tag: 't0' }, { tag: 't1' }]);
    expect(rankTags(video('a', 1, []))).toEqual([]);
  });
});

describe('topVideos', () => {
  it('preserves the search order regardless of view counts, with clipped descriptions', () => {
    const videos = Array.from({ length: 7 }, (_, i) =>
      video(`v${i}`, i * 100, ['x'], 'd'.repeat(900)),
    );
    const top = topVideos(videos);
    expect(top).toHaveLength(TOP_VIDEO_COUNT);
    expect(top.map((v) => v.views)).toEqual([0, 100, 200, 300, 400]);
    expect(top[0]).toEqual({
      title: 'Title v0',
      description: 'd'.repeat(700),
      tags: ['x'],
      views: 0,
    });
  });
});

describe('audienceEvidence', () => {
  it('keeps the same term independently labeled in every result and does not weight views', async () => {
    const items = [
      {
        id: 'a',
        snippet: { title: 'A', tags: ['glitch', 'GLITCH'], description: '#industrial' },
        statistics: { viewCount: '900' },
      },
      {
        id: 'b',
        snippet: { title: 'B', tags: ['glitch'], description: '#retro' },
        statistics: { viewCount: '100' },
      },
      {
        id: 'empty',
        snippet: { title: 'Empty', tags: ['#invalid'] },
        statistics: { viewCount: '1' },
      },
    ];
    const search = { items: items.map(({ id }) => ({ id: { videoId: id } })) };
    fetchMock.mockResolvedValueOnce(json(search)).mockResolvedValueOnce(json({ items }));
    const first = await audienceEvidence([], null);
    fetchMock.mockResolvedValueOnce(json(search)).mockResolvedValueOnce(
      json({
        items: items.map((item, i) => ({ ...item, statistics: { viewCount: String(i * 1000) } })),
      }),
    );
    const second = await audienceEvidence([], null);

    expect(first.candidateLists).toEqual([
      {
        videoId: 'a',
        title: 'A',
        hashtags: [INDUSTRIAL],
        tags: [{ tag: 'glitch' }, { tag: 'industrial' }],
      },
      {
        videoId: 'b',
        title: 'B',
        hashtags: ['#retro'],
        tags: [{ tag: 'glitch' }, { tag: 'retro' }],
      },
      { videoId: 'empty', title: 'Empty', hashtags: [], tags: [] },
    ]);
    expect(second.candidateLists).toEqual(first.candidateLists);
    expect(first.top.map(({ title }) => title)).toEqual(['A', 'B', 'Empty']);
    expect(second.top.map(({ title }) => title)).toEqual(['A', 'B', 'Empty']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('caps each result independently without a shared candidate limit', async () => {
    const items = ['a', 'b'].map((id) => ({
      id,
      snippet: {
        title: id,
        tags: Array.from({ length: 45 }, (_, i) => `${id}${i}`),
        description: Array.from({ length: 35 }, (_, i) => `#${id}${i}`).join(' '),
      },
    }));
    fetchMock
      .mockResolvedValueOnce(json({ items: items.map(({ id }) => ({ id: { videoId: id } })) }))
      .mockResolvedValueOnce(json({ items }));
    const evidence = await audienceEvidence([], null);
    expect(
      evidence.candidateLists.map(({ videoId, hashtags, tags }) => ({
        videoId,
        hashtags: hashtags.length,
        tags: tags.length,
      })),
    ).toEqual([
      { videoId: 'a', hashtags: CANDIDATE_LIMIT, tags: TAG_CANDIDATE_LIMIT },
      { videoId: 'b', hashtags: CANDIDATE_LIMIT, tags: TAG_CANDIDATE_LIMIT },
    ]);
    expect(evidence.candidateLists[1]!.tags[0]).toEqual({ tag: 'b0' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves the retrieval start time when catalog requests finish later', async () => {
    fetchMock
      .mockImplementationOnce(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(RETRIEVED_AT + 1_000);
        return json({ items: [{ id: { videoId: 'a' } }] });
      })
      .mockImplementationOnce(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(RETRIEVED_AT + 2_000);
        return json({ items: [] });
      });

    expect((await audienceEvidence([], null)).retrievedAt).toBe(RETRIEVED_AT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps catalog results by video ID and preserves independent candidates in search order', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          items: [
            { id: { videoId: 'v2' } },
            { id: {} },
            { id: { videoId: 'missing' } },
            { id: { videoId: 'v1' } },
          ],
        }),
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
    expect(evidence.retrievedAt).toBe(RETRIEVED_AT);
    expect(evidence.candidateLists).toEqual([
      {
        videoId: 'v2',
        title: 'Two',
        hashtags: [SYNTHWAVE_TAG, '#80s'],
        tags: [{ tag: 'synthwave' }, { tag: '80s' }],
      },
      {
        videoId: 'v1',
        title: 'One',
        hashtags: [SYNTHWAVE_TAG, '#retro'],
        tags: [{ tag: 'synthwave' }, { tag: 'retro' }],
      },
    ]);
    expect(evidence.top.map((v) => v.title)).toEqual(['Two', 'One']);
    expect(evidence.top.map((v) => v.description)).toEqual([
      '#Synthwave #80s',
      '#synthwave #retro',
    ]);
    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.pathname).toBe('/youtube/v3/search');
    expect(searchUrl.searchParams.get('q')).toBe('synthwave music video');
    expect(searchUrl.searchParams.get('videoCategoryId')).toBe('10');
    expect(searchUrl.searchParams.get('key')).toBe('test-key');
    const videosUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(videosUrl.pathname).toBe('/youtube/v3/videos');
    expect(videosUrl.searchParams.get('id')).toBe('v2,missing,v1');
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
    expect(evidence.candidateLists).toEqual([
      { videoId: 'near', title: 'Near', hashtags: [INDUSTRIAL], tags: [{ tag: 'industrial' }] },
    ]);
  });

  it('keeps the first 10 of 12 eligible videos from 50 results in search order', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `v${i}`);
    const eligible = ids.filter((_, i) => i % 4 === 2);
    const items = ids.map((id, i) => ({
      id,
      snippet: { title: id, tags: [id], description: `#${id}` },
      statistics: { viewCount: String(i) },
      contentDetails: { duration: i % 4 === 2 ? 'PT3M' : 'PT5M' },
    }));
    fetchMock
      .mockResolvedValueOnce(json({ items: ids.map((videoId) => ({ id: { videoId } })) }))
      .mockResolvedValueOnce(json({ items: items.toReversed() }));

    const evidence = await audienceEvidence([], 180);

    expect(eligible).toHaveLength(12);
    expect(evidence.candidateLists).toEqual(
      eligible.slice(0, 10).map((id) => ({
        videoId: id,
        title: id,
        hashtags: [`#${id}`],
        tags: [{ tag: id }],
      })),
    );
    expect(evidence.top.map(({ title }) => title)).toEqual(eligible.slice(0, 5));
    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.searchParams.get('maxResults')).toBe('50');
    expect(searchUrl.searchParams.get('order')).toBe('viewCount');
    const videosUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(videosUrl.searchParams.get('id')).toBe(ids.join(','));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads every search result back for the evidence', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ id: { videoId: 'a' } }, { id: { videoId: 'b' } }] }))
      .mockResolvedValueOnce(json({ items: [] }));
    await audienceEvidence([chunk(['synthwave'])], null);
    const videosUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(videosUrl.searchParams.get('id')).toBe('a,b');
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
    expect(evidence).toMatchObject({ candidateLists: [], top: [] });
  });

  it('returns empty evidence and skips the videos lookup when the search finds nothing', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await audienceEvidence([], null)).toEqual({
      retrievedAt: RETRIEVED_AT,
      query: 'music video',
      candidateLists: [],
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
