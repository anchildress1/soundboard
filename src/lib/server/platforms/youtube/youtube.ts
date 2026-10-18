import type { LiveMetadata, PickFields } from '$lib/types';
import { required } from '$lib/server/core/env';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';
/** Resumable chunks must be multiples of 256 KiB; 128 MiB keeps each step well under two minutes. */
export const UPLOAD_CHUNK_BYTES = 128 * 1024 * 1024;

/** OAuth scopes a connected channel grants: upload, plus reading back what was uploaded. */
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export class YouTubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type UploadFailure = 'session-lost' | 'quota-spent' | 'access-lost' | 'denied' | 'other';

/**
 * Classifies an upload error: an expired resumable session, a spent daily limit (the project's
 * `quotaExceeded` or the channel's `uploadLimitExceeded`), a refused grant, any other refusal of
 * the request (a 4xx), or anything else (a 5xx or a request that never got an answer).
 */
export function uploadFailure(error: unknown): UploadFailure {
  if (!(error instanceof YouTubeError)) return 'other';
  if (error.status === 404 || error.status === 410) return 'session-lost';
  if (error.status === 401) return 'access-lost';
  // Google's docs don't pin the channel limit's status, so its reason counts on 400 or 403.
  if ([400, 403].includes(error.status) && /uploadLimitExceeded/.test(error.message))
    return 'quota-spent';
  if (error.status === 403 && /quota/i.test(error.message)) return 'quota-spent';
  return error.status >= 400 && error.status < 500 ? 'denied' : 'other';
}

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Pacific wall-clock time minus UTC at `at`, in ms. */
function pacificOffset(at: number): number {
  const part = Object.fromEntries(
    PACIFIC.formatToParts(at).map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  const wall = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
  return wall - Math.floor(at / 1000) * 1000;
}

/** The next midnight Pacific time, when YouTube's daily quota resets. */
export function quotaResetAt(now: number): number {
  const today = new Date(now + pacificOffset(now));
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  // US clocks change at 2 a.m., so the offset an hour either side of midnight is midnight's own.
  return midnight - pacificOffset(midnight - pacificOffset(now));
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

// Keyed by channel ID: each user's header shows their own channel, never another's.
const statsCache = new Map<string, { at: number; value: ChannelStats }>();
const STATS_TTL_MS = 10 * 60 * 1000;

const latestUpload = async (playlistId: string): Promise<PlaylistItem | undefined> =>
  playlistId ? (await uploadsPage(playlistId, 1))[0] : undefined;

/** A channel's header stats; cached so the home page doesn't spend a read on every visit. */
export async function channelStats(channelId: string, now = Date.now()): Promise<ChannelStats> {
  const cached = statsCache.get(channelId);
  if (cached && now - cached.at < STATS_TTL_MS) return cached.value;
  const body = await keyGet<ListResponse<ChannelItem>>('channels', {
    part: 'snippet,statistics,contentDetails',
    id: channelId,
  });
  const item = body.items?.[0];
  if (!item) throw new YouTubeError(404, 'Channel not found');
  const uploadsPlaylist = item.contentDetails?.relatedPlaylists?.uploads ?? '';
  const latest = await latestUpload(uploadsPlaylist);
  const value: ChannelStats = {
    handle: item.snippet?.customUrl ?? item.snippet?.title ?? '',
    videoCount: Number(item.statistics?.videoCount ?? 0),
    subscriberCount: Number(item.statistics?.subscriberCount ?? 0),
    lastUploadAt: latest?.contentDetails?.videoPublishedAt ?? null,
    uploadsPlaylist,
  };
  statsCache.set(channelId, { at: now, value });
  return value;
}

export function clearStatsCache(): void {
  statsCache.clear();
}

/** A channel's most recent public uploads, newest first. */
export async function recentVideos(channelId: string, count: number): Promise<CatalogVideo[]> {
  const { uploadsPlaylist } = await channelStats(channelId);
  const items = await uploadsPage(uploadsPlaylist, count + 5);
  const ids = items
    .map((item) => item.contentDetails?.videoId)
    .filter((id): id is string => typeof id === 'string' && id !== '');
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

/** Whether the chunk starting at `offset` reaches the end of a `total`-byte file. */
export const finalChunk = (offset: number, total: number): boolean =>
  offset + UPLOAD_CHUNK_BYTES >= total;

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

const chunkEnd = (offset: number, total: number) =>
  Math.min(offset + UPLOAD_CHUNK_BYTES, total) - 1;

/** Opens the GCS range that the chunk starting at `offset` sends; null once the object is gone. */
export async function sourceRange(
  sourceUrl: string,
  offset: number,
  total: number,
): Promise<Response | null> {
  const source = await fetch(sourceUrl, {
    headers: { range: `bytes=${offset}-${chunkEnd(offset, total)}` },
    signal: AbortSignal.timeout(110_000),
  });
  if (source.status === 404) return null;
  if (source.status !== 206 && source.status !== 200) {
    // A plain error: a GCS failure must not read as a lost upload session.
    throw new Error(`GCS range read ${source.status}`);
  }
  return source;
}

/**
 * Sends one chunk from an open `sourceRange`. The body is piped from the signed GCS response
 * straight into the PUT, so the chunk never sits in app memory.
 */
export async function uploadChunk(
  sessionUri: string,
  source: Response,
  offset: number,
  total: number,
): Promise<ChunkResult> {
  const end = chunkEnd(offset, total);
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

/** The channel the access token's account owns, or null when the account has none. */
export async function channelsMine(
  accessToken: string,
): Promise<{ id: string; title: string } | null> {
  const body = await readJson<ListResponse<{ id: string; snippet?: { title?: string } }>>(
    await fetch(`${API}/channels?part=snippet&mine=true`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    }),
    'channels.list',
  );
  const item = body.items?.[0];
  return item ? { id: item.id, title: item.snippet?.title ?? '' } : null;
}

/**
 * YouTube's verdict on a read-back upload. `reason` is YouTube's past-tense status word
 * (`rejected`, `failed`, `deleted`). Every documented word is sorted, so `raw` on a pending verdict
 * is a word YouTube added since, or null when it sent none.
 */
export type UploadVerdict =
  | { status: 'accepted' }
  | { status: 'pending'; raw: string | null }
  | { status: 'rejected'; reason: string };

/** Reads the video back from the target channel; only this result can mark a publish verified. */
export type ReadBack = LiveMetadata & UploadVerdict;

// Only an upload YouTube kept counts as accepted; `uploaded` is still processing but kept.
const ACCEPTED_UPLOADS = new Set(['uploaded', 'processed']);
const REJECTED_UPLOADS = new Set(['rejected', 'failed', 'deleted']);

function verdict(uploadStatus: string | undefined): UploadVerdict {
  if (uploadStatus && REJECTED_UPLOADS.has(uploadStatus)) {
    return { status: 'rejected', reason: uploadStatus };
  }
  if (uploadStatus && ACCEPTED_UPLOADS.has(uploadStatus)) return { status: 'accepted' };
  return { status: 'pending', raw: uploadStatus || null };
}

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
  return item ? { ...toCatalog(item), ...verdict(item.status?.uploadStatus) } : null;
}

export type VideoOwner = { channelId: string; publishedAt: number };

/**
 * The channel that owns the video, as the token's grant sees it, and when it was published; null
 * when it isn't visible or YouTube omits either field.
 */
export async function videoChannel(accessToken: string, id: string): Promise<VideoOwner | null> {
  const query = new URLSearchParams({ part: 'snippet', id });
  const body = await readJson<
    ListResponse<{ snippet?: { channelId?: string; publishedAt?: string } }>
  >(
    await fetch(`${API}/videos?${query}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    }),
    'videos.list',
  );
  const snippet = body.items?.[0]?.snippet;
  const publishedAt = Date.parse(snippet?.publishedAt ?? '');
  return snippet?.channelId && Number.isFinite(publishedAt)
    ? { channelId: snippet.channelId, publishedAt }
    : null;
}

const VIDEO_ID = /^[\w-]{11}$/;

/**
 * The video ID in a pasted `watch?v=`, `youtu.be/`, `/shorts/` or YouTube Studio `/video/` URL;
 * null for anything else.
 */
export function videoIdFromUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const [first, second] = url.pathname.split('/').filter(Boolean);
  let id: string | null | undefined;
  if (host === 'youtu.be') id = first;
  else if (host === 'studio.youtube.com') id = first === 'video' ? second : null;
  else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (first === 'shorts') id = second;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}
