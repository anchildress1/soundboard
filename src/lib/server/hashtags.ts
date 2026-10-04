import { parseHashtags } from '$lib/metadata';
import type { Chunk } from '$lib/types';
import { toolSpan } from './tracing';
import { searchMusicVideos, videosByIds } from './youtube';

export const CANDIDATE_LIMIT = 30;

/** The chunk analyst's most frequent genre terms, which seed the hashtag search. */
export function genreTerms(chunks: Chunk[], limit = 2): string[] {
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    for (const genre of chunk.analysis?.music.genre ?? []) {
      const term = genre.trim().toLowerCase();
      if (term) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
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

export function searchQuery(chunks: Chunk[]): string {
  return [...genreTerms(chunks), 'music video'].join(' ');
}

/**
 * The deterministic candidate list: hashtags from FLR's recent descriptions plus the top music
 * videos for the analysis's genre terms. The model may only pick from this list.
 */
export async function hashtagCandidates(
  recentDescriptions: string[],
  chunks: Chunk[],
): Promise<string[]> {
  const query = searchQuery(chunks);
  return toolSpan('smart-pick', 'hashtag_search', { query }, async (span) => {
    const ids = await searchMusicVideos(query);
    const found = await videosByIds(ids);
    const candidates = rankHashtags([...recentDescriptions, ...found.map((v) => v.description)]);
    span.setAttributes({ 'search.query': query, 'hashtag.candidate_count': candidates.length });
    span.setAttribute('gen_ai.tool.call.result', JSON.stringify(candidates));
    return candidates;
  });
}
