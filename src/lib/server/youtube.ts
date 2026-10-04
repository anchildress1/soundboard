import type { LiveMetadata, PickFields } from '$lib/types';
import { required } from './env';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';
/** Resumable chunks must be multiples of 256 KiB; 128 MiB keeps each step well under two minutes. */
export const UPLOAD_CHUNK_BYTES = 128 * 1024 * 1024;

export class YouTubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    throw new YouTubeError(
      response.status,
      `${what} ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  return (await response.json()) as T;
}

/** Catalog reads use the API key from the second project, so they never spend upload quota. */
async function keyGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ ...params, key: required('YOUTUBE_API_KEY') });
  return readJson<T>(
    await fetch(`${API}/${path}?${query}`, { signal: AbortSignal.timeout(15_000) }),
    path,
  );
}

type Thumbs = Record<string, { url: string } | undefined>;
type VideoItem = {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    tags?: string[];
    publishedAt?: string;
    thumbnails?: Thumbs;
  };
  statistics?: { viewCount?: string };
  contentDetails?: { duration?: string };
  status?: { privacyStatus?: string; uploadStatus?: string };
};
type ListResponse<T> = { items?: T[] };

export type ChannelStats = {
  handle: string;
  videoCount: number;
  subscriberCount: number;
  uploadsPlaylist: string;
  lastUploadAt: string | null;
};

export type CatalogVideo = LiveMetadata & {
  publishedAt: string;
  thumbnailUrl: string | null;
  views: number;
  durationSec: number;
};

/** Seconds in an ISO 8601 video duration (`PT1H2M3S`); 0 when absent or unreadable. */
export function isoSeconds(duration: string | undefined): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration ?? '');
  if (!match) return 0;
  const [, d = '0', h = '0', m = '0', sec = '0'] = match;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(sec);
}

const toCatalog = (item: VideoItem): CatalogVideo => {
  const thumbs = item.snippet?.thumbnails ?? {};
  return {
    videoId: item.id,
    title: item.snippet?.title ?? '',
    description: item.snippet?.description ?? '',
    tags: item.snippet?.tags ?? [],
    publishedAt: item.snippet?.publishedAt ?? '',
    thumbnailUrl: (thumbs.medium ?? thumbs.default ?? thumbs.high)?.url ?? null,
    views: Number(item.statistics?.viewCount ?? 0),
    durationSec: isoSeconds(item.contentDetails?.duration),
  };
};

export async function videosByIds(ids: string[]): Promise<CatalogVideo[]> {
  if (ids.length === 0) return [];
  const body = await keyGet<ListResponse<VideoItem>>('videos', {
    part: 'snippet,statistics,contentDetails',
    id: ids.slice(0, 50).join(','),
    maxResults: '50',
  });
  return (body.items ?? []).map(toCatalog);
}

type ChannelItem = {
  snippet?: { customUrl?: string; title?: string };
  statistics?: { videoCount?: string; subscriberCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
};
type PlaylistItem = { contentDetails?: { videoId?: string; videoPublishedAt?: string } };

async function uploadsPage(playlistId: string, maxResults: number): Promise<PlaylistItem[]> {
  const body = await keyGet<ListResponse<PlaylistItem>>('playlistItems', {
    part: 'contentDetails',
    maxResults: String(maxResults),
    playlistId,
  });
  return body.items ?? [];
}

let statsCache: { at: number; value: ChannelStats } | null = null;
const STATS_TTL_MS = 10 * 60 * 1000;

const latestUpload = async (playlistId: string): Promise<PlaylistItem | undefined> =>
  playlistId ? (await uploadsPage(playlistId, 1))[0] : undefined;

/** FLR channel header stats; cached so the home page doesn't spend a read on every visit. */
export async function channelStats(now = Date.now()): Promise<ChannelStats> {
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const body = await keyGet<ListResponse<ChannelItem>>('channels', {
    part: 'snippet,statistics,contentDetails',
    id: required('FLR_CHANNEL_ID'),
  });
  const item = body.items?.[0];
  if (!item) throw new YouTubeError(404, 'FLR channel not found');
  const uploadsPlaylist = item.contentDetails?.relatedPlaylists?.uploads ?? '';
  const latest = await latestUpload(uploadsPlaylist);
  const value: ChannelStats = {
    handle: item.snippet?.customUrl ?? item.snippet?.title ?? '',
    videoCount: Number(item.statistics?.videoCount ?? 0),
    subscriberCount: Number(item.statistics?.subscriberCount ?? 0),
    lastUploadAt: latest?.contentDetails?.videoPublishedAt ?? null,
    uploadsPlaylist,
  };
  statsCache = { at: now, value };
  return value;
}

export function clearStatsCache(): void {
  statsCache = null;
}

/** FLR's most recent public uploads, newest first, optionally leaving one video out. */
export async function recentVideos(
  count: number,
  excludeId: string | null,
): Promise<CatalogVideo[]> {
  const { uploadsPlaylist } = await channelStats();
  const items = await uploadsPage(uploadsPlaylist, count + 5);
  const ids = items
    .map((item) => item.contentDetails?.videoId)
    .filter((id): id is string => typeof id === 'string' && id !== '' && id !== excludeId);
  const videos = await videosByIds(ids);
  const order = new Map(ids.map((id, i) => [id, i]));
  return videos.toSorted((a, b) => order.get(a.videoId)! - order.get(b.videoId)!).slice(0, count);
}

export type VideoDuration = 'short' | 'medium' | 'long';

/** Top music videos for a query (`type=video`, `videoCategoryId=10`), optionally by length bucket. */
export async function searchMusicVideos(
  query: string,
  maxResults = 25,
  videoDuration?: VideoDuration,
): Promise<string[]> {
  const body = await keyGet<ListResponse<{ id?: { videoId?: string } }>>('search', {
    part: 'id',
    q: query,
    type: 'video',
    videoCategoryId: '10',
    maxResults: String(maxResults),
    ...(videoDuration ? { videoDuration } : {}),
  });
  return (body.items ?? [])
    .map((item) => item.id?.videoId)
    .filter((id): id is string => Boolean(id));
}

/** Fetches a thumbnail and returns it as a data URL, the form the model accepts images in. */
export async function thumbnailDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') ?? 'image/jpeg';
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  } catch {
    return null;
  }
}

// ---- OAuth: upload and read-back on the target channel ----

export async function startResumableUpload(
  accessToken: string,
  fields: PickFields,
  total: number,
  contentType: string,
): Promise<string> {
  const response = await fetch(`${UPLOAD_API}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(total),
      'x-upload-content-type': contentType,
    },
    body: JSON.stringify({
      snippet: {
        title: fields.title,
        description: fields.description,
        tags: fields.tags,
        categoryId: '10',
      },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const location = response.headers.get('location');
  if (!response.ok || !location) {
    throw new YouTubeError(
      response.status,
      `upload init ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  return location;
}

export type ChunkResult = { done: true; videoId: string } | { done: false; next: number };

const nextFromRange = (range: string | null) => {
  const end = range?.match(/bytes=\d+-(\d+)/)?.[1];
  return end === undefined ? 0 : Number(end) + 1;
};

async function finish(response: Response): Promise<ChunkResult> {
  if (response.status === 308)
    return { done: false, next: nextFromRange(response.headers.get('range')) };
  const video = await readJson<VideoItem>(response, 'upload');
  return { done: true, videoId: video.id };
}

/** Bytes YouTube already holds for a session, so a lost step resumes where it stopped. */
export async function uploadOffset(sessionUri: string, total: number): Promise<ChunkResult> {
  return finish(
    await fetch(sessionUri, {
      method: 'PUT',
      headers: { 'content-range': `bytes */${total}`, 'content-length': '0' },
      signal: AbortSignal.timeout(30_000),
    }),
  );
}

/**
 * Streams one range of the GCS object into the upload session. The body is piped from the signed
 * GCS response straight into the PUT, so the chunk never sits in app memory.
 */
export async function uploadChunk(
  sessionUri: string,
  sourceUrl: string,
  offset: number,
  total: number,
): Promise<ChunkResult> {
  const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total) - 1;
  const source = await fetch(sourceUrl, {
    headers: { range: `bytes=${offset}-${end}` },
    signal: AbortSignal.timeout(110_000),
  });
  if (source.status !== 206 && source.status !== 200) {
    throw new YouTubeError(source.status, `GCS range read ${source.status}`);
  }
  return finish(
    await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'content-length': String(end - offset + 1),
        'content-range': `bytes ${offset}-${end}/${total}`,
      },
      body: source.body,
      duplex: 'half',
      signal: AbortSignal.timeout(110_000),
    } as RequestInit),
  );
}

/** Reads the video back from the target channel; only this result can mark a publish verified. */
export type ReadBack = LiveMetadata & { uploadStatus: string | null };

export async function readBack(accessToken: string, videoId: string): Promise<ReadBack | null> {
  const query = new URLSearchParams({ part: 'snippet,status', id: videoId });
  const body = await readJson<ListResponse<VideoItem>>(
    await fetch(`${API}/videos?${query}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    }),
    'videos.list',
  );
  const item = body.items?.[0];
  return item ? { ...toCatalog(item), uploadStatus: item.status?.uploadStatus ?? null } : null;
}
