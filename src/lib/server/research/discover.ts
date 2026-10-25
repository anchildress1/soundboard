// Discover (research R4): the genre search finds candidate channels; later batches read each one's
// newest upload as the sample to hear. Cursor 0 is the search; cursor k samples candidate k - 1.
import { sql } from 'drizzle-orm';
import { toolSpan } from '#lib/server/core/tracing.js';
import { listChunks } from '#lib/server/jobs/jobs.js';
import { genreTerms } from '#lib/server/pipeline/hashtags.js';
import {
  channelsByIds,
  getConnection,
  searchVideos,
  uploadsOf,
  type PublicChannel,
} from '#lib/server/platforms/youtube/index.js';
import { eachItem, type Batch, type StageContext } from './batch';
import { bracketOf, relation, type Bracket, type Relation } from './brackets';
import {
  readEvidence,
  rejectedChannels,
  saveEvidence,
  type Candidate,
  type PeerEvidence,
} from './evidence';
import type { ResearchLimit } from './runs';

/** Candidates kept for matching, after brackets are applied (#18). */
export const PEER_CANDIDATES = 12;
const SEARCH_RESULTS = 50;
const MUSIC_CATEGORY = '10';
/** About two YouTube reads per sample. */
const SAMPLE_MS = 5_000;
/** One `channels.list` call reads at most 50 IDs. */
const MAX_IDS = 50;
const ORDER: Relation[] = ['next', 'same', 'two-up'];

export async function discover({ run, deadline }: StageContext): Promise<Batch> {
  if (run.cursor === 0) return await search(run, deadline);
  const stored = await readEvidence(run.id);
  // Expired or deleted under a long run: nothing left to sample from.
  if (!stored) return { done: 1, stage: 'done', cursor: 0, limits: ['no-peers'] };
  return await sample(run.id, run.cursor, stored.evidence, deadline);
}

async function search(run: StageContext['run'], deadline: number): Promise<Batch> {
  const [chunks, connection, rejected] = await Promise.all([
    listChunks(run.jobId),
    getConnection(run.ownerUid),
    rejectedChannels(),
  ]);
  const terms = [...genreTerms(chunks), 'music'].join(' ');
  const own = connection?.channelId ?? null;
  return await toolSpan('peer-match', 'peer_search', { query: terms }, async (span) => {
    const hits = await searchVideos(
      terms,
      { order: 'relevance', maxResults: SEARCH_RESULTS, categoryId: MUSIC_CATEGORY },
      deadline,
    );
    const ids = [...new Set(hits.map((hit) => hit.channelId))]
      .filter((id) => id !== own && !rejected.includes(id))
      .slice(0, own ? MAX_IDS - 1 : MAX_IDS);
    const channels = await channelsByIds(own ? [own, ...ids] : ids, deadline);
    const byId = new Map(channels.map((channel) => [channel.channelId, channel]));
    const artistStats = own ? (byId.get(own)?.stats ?? null) : null;
    const artistBracket = bracketOf(artistStats?.subscribers ?? null);
    const found = ids.flatMap((id) => byId.get(id) ?? []);
    const { candidates, skipped, limits } = bracketed(found, artistBracket);
    // Only the IDs one read covers are judged; the rest expire on their own.
    const checked = rejected.slice(0, MAX_IDS);
    const kept = new Set((await channelsByIds(checked, deadline)).map((c) => c.channelId));
    const gone = checked.filter((id) => !kept.has(id));
    const evidence: PeerEvidence = {
      query: terms,
      artist: { stats: artistStats, bracket: artistBracket },
      candidates,
      peers: [],
      releases: [],
      skipped,
    };
    // Counts only: channel names are YouTube data and stay out of Sentry.
    span.setAttribute(
      'gen_ai.tool.call.result',
      JSON.stringify({ results: hits.length, candidates: candidates.length }),
    );
    const none = candidates.length === 0;
    return {
      done: 1,
      stage: none ? 'done' : 'discover',
      cursor: none ? 0 : 1,
      limits: none ? [...limits, 'no-peers'] : limits,
      writes: async (tx, token) => {
        await saveEvidence(tx, run.id, token, evidence);
        if (checked.length === 0) return;
        await tx.execute(
          sql`select public.soundboard_refresh_rejections(${run.id}, ${token}, ${textArray([...kept])}, ${textArray(gone)})`,
        );
      },
    };
  });
}

/**
 * Brackets before the cap (#18): `other` and unknown ranges are skipped; the rest go next, same,
 * then two-up, each in search order, and the first 12 stay. With the artist's own count hidden,
 * nothing is bracketed and search order stands.
 */
export function bracketed(
  channels: PublicChannel[],
  artist: Bracket | null,
): { candidates: Candidate[]; skipped: PeerEvidence['skipped']; limits: ResearchLimit[] } {
  const candidate = (channel: PublicChannel, rel: Relation | null): Candidate => ({
    channelId: channel.channelId,
    title: channel.title,
    description: channel.description,
    uploadsPlaylist: channel.uploadsPlaylist,
    stats: channel.stats,
    bracket: bracketOf(channel.stats.subscribers),
    relation: rel,
  });
  if (artist === null) {
    return {
      candidates: channels.slice(0, PEER_CANDIDATES).map((channel) => candidate(channel, null)),
      skipped: [],
      limits: ['artist-range-unknown'],
    };
  }
  const skipped: PeerEvidence['skipped'] = [];
  const ranked: Candidate[] = [];
  for (const channel of channels) {
    const rel = relation(artist, bracketOf(channel.stats.subscribers));
    if (rel === null || rel === 'other') {
      skipped.push({
        channelId: channel.channelId,
        reason: rel === null ? 'range-unknown' : 'range-other',
      });
    } else {
      ranked.push(candidate(channel, rel));
    }
  }
  const ordered = ORDER.flatMap((rel) => ranked.filter((c) => c.relation === rel));
  const limits: ResearchLimit[] = skipped.some((s) => s.reason === 'range-unknown')
    ? ['peer-range-unknown']
    : [];
  return { candidates: ordered.slice(0, PEER_CANDIDATES), skipped, limits };
}

/** Each candidate's newest public upload, from `cursor - 1`, while time allows. */
async function sample(
  runId: string,
  cursor: number,
  evidence: PeerEvidence,
  deadline: number,
): Promise<Batch> {
  const items = await eachItem(evidence.candidates, cursor - 1, deadline, SAMPLE_MS, async (c) => {
    const [upload] = c.uploadsPlaylist ? await uploadsOf(c.uploadsPlaylist, 1, deadline) : [];
    c.sample = upload ? { videoId: upload.videoId, title: upload.title, tags: upload.tags } : null;
    return undefined;
  });
  const finished = items.next >= evidence.candidates.length;
  return {
    done: items.done,
    stage: finished ? 'match' : 'discover',
    cursor: finished ? 0 : items.next + 1,
    wait: items.wait,
    writes: (tx, token) => saveEvidence(tx, runId, token, evidence),
  };
}

// Drizzle spreads a JS array into a parameter list, so the IDs travel as one JSON value.
const textArray = (values: string[]) =>
  sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
