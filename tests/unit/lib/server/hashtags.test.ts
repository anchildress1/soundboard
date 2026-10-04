// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_LIMIT,
  genreTerms,
  hashtagCandidates,
  rankHashtags,
  searchQuery,
} from '$lib/server/hashtags';
import type { Chunk } from '$lib/types';

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
    expect(ranked).toEqual(['#synthwave', '#newmusic', '#indie', '#lofi']);
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

describe('hashtagCandidates', () => {
  it('merges recent description tags with top search results', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ items: [{ id: { videoId: 'v1' } }, { id: {} }, { id: { videoId: 'v2' } }] }),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            { id: 'v1', snippet: { description: '#synthwave #retro' } },
            { id: 'v2', snippet: { description: '#Synthwave #80s' } },
          ],
        }),
      );

    const candidates = await hashtagCandidates(
      ['New from Flies Like Robots #fliesLikeRobots #synthwave'],
      [chunk(['synthwave'])],
    );

    expect(candidates).toEqual(['#synthwave', '#flieslikerobots', '#retro', '#80s']);
    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.pathname).toBe('/youtube/v3/search');
    expect(searchUrl.searchParams.get('q')).toBe('synthwave music video');
    expect(searchUrl.searchParams.get('videoCategoryId')).toBe('10');
    expect(searchUrl.searchParams.get('key')).toBe('test-key');
    const videosUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(videosUrl.pathname).toBe('/youtube/v3/videos');
    expect(videosUrl.searchParams.get('id')).toBe('v1,v2');
  });

  it('skips the videos lookup when the search finds nothing', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await hashtagCandidates(['#indie'], [])).toEqual(['#indie']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when nothing carries a hashtag', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect(await hashtagCandidates([], [])).toEqual([]);
  });

  it('rejects when the YouTube search fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('quotaExceeded', { status: 403 }));
    await expect(hashtagCandidates([], [])).rejects.toThrow('search 403: quotaExceeded');
  });

  it('rejects without an API key and makes no request', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    await expect(hashtagCandidates([], [])).rejects.toThrow('YOUTUBE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
