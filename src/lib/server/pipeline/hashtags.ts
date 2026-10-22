import { parseHashtags } from '$lib/metadata';
import type { Chunk } from '$lib/types';
import { toolSpan } from '$lib/server/core/tracing';
import {
  searchMusicVideos,
  videosByIds,
  type CatalogVideo,
  type VideoDuration,
} from '$lib/server/platforms/youtube';

export const CANDIDATE_LIMIT = 30;
export const SEARCH_RESULTS = 5;
/** Evidence counts only from videos this close to the upload's length, which drops hour-long mixes. */
export const LENGTH_TOLERANCE_SEC = 60;
export const TAG_CANDIDATE_LIMIT = 40;
export const TOP_VIDEO_COUNT = 5;
const TOP_DESCRIPTION_CHARS = 700;

/** A genre search example with its original view count. */
export type AudienceVideo = { title: string; description: string; tags: string[]; views: number };

/** A tag observed in a genre search result. */
export type TagCandidate = { tag: string };

export type CandidateList = {
  videoId: string;
  title: string;
  hashtags: string[];
  tags: TagCandidate[];
};

/** Genre search candidates and examples, stored with their original retrieval time. */
export type AudienceEvidence = {
  retrievedAt: number;
  query: string;
  candidateLists: CandidateList[];
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

/** Unique observed hashtags in first-seen order, without cross-channel counts. */
export function rankHashtags(description: string, limit = CANDIDATE_LIMIT): string[] {
  const found = new Set<string>();
  for (const tag of parseHashtags(description)) found.add(tag);
  return [...found].slice(0, limit);
}

/** Unique observed tags and hashtag terms, retaining first-seen spelling and order. */
export function rankTags(video: CatalogVideo, limit = TAG_CANDIDATE_LIMIT): TagCandidate[] {
  const found = new Map<string, TagCandidate>();
  // A result's own hashtags are tags too: the same evidence, often more specific than its tags.
  const hashtagTerms = parseHashtags(video.description).map((h) => h.slice(1));
  for (const raw of [...video.tags, ...hashtagTerms]) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (!tag || tag.startsWith('#') || found.has(key)) continue;
    found.set(key, { tag });
  }
  return [...found.values()].slice(0, limit);
}

export function topVideos(videos: CatalogVideo[], count = TOP_VIDEO_COUNT): AudienceVideo[] {
  return videos.slice(0, count).map((v) => ({
    title: v.title,
    description: v.description.slice(0, TOP_DESCRIPTION_CHARS),
    tags: v.tags,
    views: v.views,
  }));
}

export function searchQuery(chunks: Chunk[]): string {
  return [...genreTerms(chunks), 'music video'].join(' ');
}

function bucketOf(seconds: number): VideoDuration {
  if (seconds < 240) return 'short';
  return seconds <= 1200 ? 'medium' : 'long';
}

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
 * Keeps each genre result's candidates separate, without pooling different owners' metadata.
 * With the upload's length, only results within a minute of it count.
 */
export function audienceEvidence(
  chunks: Chunk[],
  durationSec: number | null,
): Promise<AudienceEvidence> {
  const retrievedAt = Date.now();
  const query = searchQuery(chunks);
  return toolSpan('smart-pick', 'hashtag_search', { query }, async (span) => {
    const ids = await searchMusicVideos(
      query,
      SEARCH_RESULTS,
      durationSec === null ? undefined : durationBucket(durationSec),
    );
    const catalog = new Map((await videosByIds(ids)).map((video) => [video.videoId, video]));
    const results = ids.flatMap((id) => {
      const video = catalog.get(id);
      return video ? [video] : [];
    });
    const found = durationSec === null ? results : similarLength(results, durationSec);
    const evidence: AudienceEvidence = {
      retrievedAt,
      query,
      candidateLists: found.map((video) => ({
        videoId: video.videoId,
        title: video.title,
        hashtags: rankHashtags(video.description),
        tags: rankTags(video),
      })),
      top: topVideos(found),
    };
    span.setAttributes({
      'search.query': query,
      'search.result_count': results.length,
      'search.evidence_count': found.length,
    });
    span.setAttribute(
      'gen_ai.tool.call.result',
      JSON.stringify({ candidateLists: evidence.candidateLists }),
    );
    return evidence;
  });
}
