import { parseHashtags } from '$lib/metadata';
import type { Chunk } from '$lib/types';
import { toolSpan } from './tracing';
import { searchMusicVideos, videosByIds, type CatalogVideo, type VideoDuration } from './youtube';

export const CANDIDATE_LIMIT = 30;
export const SEARCH_RESULTS = 50;
/** Evidence counts only from videos this close to the upload's length, which drops hour-long mixes. */
export const LENGTH_TOLERANCE_SEC = 60;
export const TAG_CANDIDATE_LIMIT = 40;
export const TOP_VIDEO_COUNT = 5;
const TOP_DESCRIPTION_CHARS = 700;

/** One of the most-viewed genre search results, as the model sees it. */
export type AudienceVideo = { title: string; description: string; tags: string[]; views: number };

/** A tag from the genre search and how many of its results use it. */
export type TagCandidate = { tag: string; usedBy: number };

/**
 * What the genre's audience responds to, from the genre search: the deterministic hashtag and tag
 * candidates, and the most-viewed results as examples. Stored on the job so re-runs reuse it.
 */
export type AudienceEvidence = {
  query: string;
  hashtags: string[];
  tags: TagCandidate[];
  top: AudienceVideo[];
};

const asWords = (term: string) => ` ${term} `;

/**
 * The chunk analyst's most frequent genre terms, which seed the genre search. A term that sits
 * inside a longer heard term ("electronic" in "industrial electronic") folds its count into the
 * longer one, so umbrella genres can't crowd out the specific genre of the track.
 */
export function genreTerms(chunks: Chunk[], limit = 2): string[] {
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    for (const genre of chunk.analysis?.music.genre ?? []) {
      const term = genre.trim().toLowerCase().replaceAll(/\s+/g, ' ');
      if (term) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  // Shortest first, so a chain like "electronic" → "industrial electronic" → longer folds all the way.
  for (const term of [...counts.keys()].sort((a, b) => a.length - b.length)) {
    const wider = [...counts.keys()]
      .filter((other) => other !== term && asWords(other).includes(asWords(term)))
      .sort((a, b) => counts.get(b)! - counts.get(a)!)[0];
    if (wider === undefined) continue;
    counts.set(wider, counts.get(wider)! + counts.get(term)!);
    counts.delete(term);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

/** Hashtags across descriptions ranked by how many descriptions use them; ties keep first-seen order. */
export function rankHashtags(descriptions: string[], limit = CANDIDATE_LIMIT): string[] {
  const counts = new Map<string, number>();
  for (const description of descriptions) {
    for (const tag of parseHashtags(description)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

/**
 * Tags and hashtag terms across videos, ranked by how many videos use them, then by those videos'
 * total views.
 * Case-folded for counting; the first spelling seen is kept.
 */
export function rankTags(videos: CatalogVideo[], limit = TAG_CANDIDATE_LIMIT): TagCandidate[] {
  const stats = new Map<string, { tag: string; videos: number; views: number }>();
  for (const video of videos) {
    const seen = new Set<string>();
    // A result's own hashtags are tags too: the same evidence, often more specific than its tags.
    const hashtagTerms = parseHashtags(video.description).map((h) => h.slice(1));
    for (const raw of [...video.tags, ...hashtagTerms]) {
      const tag = raw.trim();
      const key = tag.toLowerCase();
      if (!tag || tag.startsWith('#') || seen.has(key)) continue;
      seen.add(key);
      const entry = stats.get(key) ?? { tag, videos: 0, views: 0 };
      entry.videos += 1;
      entry.views += video.views;
      stats.set(key, entry);
    }
  }
  return [...stats.values()]
    .sort((a, b) => b.videos - a.videos || b.views - a.views)
    .slice(0, limit)
    .map((entry) => ({ tag: entry.tag, usedBy: entry.videos }));
}

export function topVideos(videos: CatalogVideo[], count = TOP_VIDEO_COUNT): AudienceVideo[] {
  return [...videos]
    .sort((a, b) => b.views - a.views)
    .slice(0, count)
    .map((v) => ({
      title: v.title,
      description: v.description.slice(0, TOP_DESCRIPTION_CHARS),
      tags: v.tags,
      views: v.views,
    }));
}

export function searchQuery(chunks: Chunk[]): string {
  return [...genreTerms(chunks), 'music video'].join(' ');
}

const bucketOf = (seconds: number): VideoDuration =>
  seconds < 240 ? 'short' : seconds <= 1200 ? 'medium' : 'long';

/**
 * YouTube's search length bucket (short under 4 minutes, long over 20) holding the whole
 * comparable window, or undefined when the window crosses a bucket edge.
 */
export function durationBucket(seconds: number): VideoDuration | undefined {
  const low = bucketOf(seconds - LENGTH_TOLERANCE_SEC);
  return low === bucketOf(seconds + LENGTH_TOLERANCE_SEC) ? low : undefined;
}

/** Results within a minute of the upload's length; unknown lengths (0) never count. */
export function similarLength(videos: CatalogVideo[], seconds: number): CatalogVideo[] {
  return videos.filter(
    (v) => v.durationSec > 0 && Math.abs(v.durationSec - seconds) <= LENGTH_TOLERANCE_SEC,
  );
}

/**
 * Runs the genre search once and derives every candidate list from it. With the upload's length,
 * only results within a minute of it count.
 */
export async function audienceEvidence(
  chunks: Chunk[],
  durationSec: number | null,
  /** A sample's own live video, kept out so the pick can't copy what it's compared against (R4). */
  excludeId: string | null = null,
): Promise<AudienceEvidence> {
  const query = searchQuery(chunks);
  return toolSpan('smart-pick', 'hashtag_search', { query }, async (span) => {
    const ids = await searchMusicVideos(
      query,
      SEARCH_RESULTS,
      durationSec === null ? undefined : durationBucket(durationSec),
    );
    const results = await videosByIds(ids.filter((id) => id !== excludeId));
    const found = durationSec === null ? results : similarLength(results, durationSec);
    const evidence: AudienceEvidence = {
      query,
      hashtags: rankHashtags(found.map((v) => v.description)),
      tags: rankTags(found),
      top: topVideos(found),
    };
    span.setAttributes({
      'search.query': query,
      'search.result_count': results.length,
      'search.evidence_count': found.length,
      'hashtag.candidate_count': evidence.hashtags.length,
      'tag.candidate_count': evidence.tags.length,
    });
    span.setAttribute(
      'gen_ai.tool.call.result',
      JSON.stringify({ hashtags: evidence.hashtags, tags: evidence.tags.map((t) => t.tag) }),
    );
    return evidence;
  });
}
