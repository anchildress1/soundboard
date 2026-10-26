import type { LiveMetadata, PickFields } from '#lib/types.js';
import { required } from '#lib/server/core/env.js';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';
/** Resumable chunks must be multiples of 256 KiB; 128 MiB keeps each step well under two minutes. */
export const UPLOAD_CHUNK_BYTES = 128 * 1024 * 1024;

/** OAuth scopes a connected channel grants: upload, plus reading back what was uploaded. */
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

/** The optional grant that lets learning read the artist's own YouTube Analytics. */
export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';

export class YouTubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The first `error.errors[].reason` YouTube sent, when it sent one. */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

/** The step's budget ran out before a request could start. */
export class DeadlineSpent extends Error {
  constructor() {
    super('The step ran out of time for YouTube.');
  }
}

/** The connected channel isn't the one asked for: a reconnect landed in between. */
export class ChannelMismatch extends Error {
  constructor() {
    super("Connected channel doesn't match this job's channel.");
  }
}

/**
 * A signal that aborts at the step's `deadline`. Throws `DeadlineSpent` when no time is left, so no
 * request starts; `AbortSignal.timeout` would throw a RangeError on a negative wait.
 */
export function budgetSignal(deadline: number): AbortSignal {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DeadlineSpent();
  return AbortSignal.timeout(remaining);
}

export type IdentityFailure = 'access-lost' | 'busy' | 'app-rejected';

// Research R8: a 403 is read by its reason, never by its status alone.
const BUSY_REASONS = new Set([
  'quotaExceeded',
  'dailyLimitExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);
const REJECTED_REASONS = new Set(['accessNotConfigured', 'keyInvalid', 'keyExpired']);
const REJECTED_CLIENTS = new Set(['invalid_client', 'unauthorized_client']);

function statusFailure(status: number, reason: string | null): IdentityFailure {
  if (status === 429 || status >= 500) return 'busy';
  if (reason && REJECTED_REASONS.has(reason)) return 'app-rejected';
  if (status === 403) return reason && BUSY_REASONS.has(reason) ? 'busy' : 'access-lost';
  if (status === 401 || status === 404) return 'access-lost';
  return 'app-rejected';
}

type Failed = {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  config?: unknown;
  response?: { status?: unknown; data?: { error?: unknown } };
};

const ABORTED = new Set(['AbortError', 'TimeoutError']);

/** Whether a read stopped at the step's deadline: it never started, or it was aborted. */
export function outOfTime(error: unknown): boolean {
  if (error instanceof DeadlineSpent) return true;
  const { name, code } = (error ?? {}) as Failed;
  return ABORTED.has(String(name)) || ABORTED.has(String(code));
}

/** A refresh, fetch or abort failure's outcome; null when `error` is none of those. */
function requestFailure(error: unknown): IdentityFailure | null {
  if (error instanceof ChannelMismatch || outOfTime(error)) return 'busy';
  if (error instanceof YouTubeError) return statusFailure(error.status, error.reason);
  if (!(error instanceof Error)) return null;
  const failed = error as Failed;
  // Gaxios (the token refresh) keeps Google's OAuth error code and the HTTP status on the error.
  const grant = failed.response?.data?.error;
  if (typeof grant === 'string' && REJECTED_CLIENTS.has(grant)) return 'app-rejected';
  const status = failed.status ?? failed.response?.status;
  if (typeof status === 'number') return statusFailure(status, null);
  if (failed.config !== undefined || error.message === 'fetch failed') return 'busy';
  return null;
}

/**
 * Classifies a failed identity or brand read (research R8): `access-lost` waits on a reconnect,
 * `busy` waits and leaves the grant alone, and `app-rejected` (or anything unrecognized) is a
 * failure.
 */
export function identityFailure(error: unknown): IdentityFailure {
  return (
    requestFailure(error) ?? requestFailure((error as { cause?: unknown })?.cause) ?? 'app-rejected'
  );
}

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);

/** The project's daily YouTube quota is spent: an empty result for the day, not a failure. */
export function quotaSpent(error: unknown): boolean {
  return (
    error instanceof YouTubeError &&
    error.status === 403 &&
    error.reason !== null &&
    QUOTA_REASONS.has(error.reason)
  );
}

export type UploadFailure = 'session-lost' | 'quota-spent' | 'access-lost' | 'denied' | 'other';

/**
 * Classifies an upload error: an expired resumable session, a spent daily limit (the project's
 * `quotaExceeded` or the channel's `uploadLimitExceeded`), a refused grant, any other refusal of
 * the request (a 4xx), or `'other'`: a rate limit, a status outside 4xx, or no answer at all.
 */
export function uploadFailure(error: unknown): UploadFailure {
  if (!(error instanceof YouTubeError)) return 'other';
  if (error.status === 404 || error.status === 410) return 'session-lost';
  if (error.status === 401) return 'access-lost';
  // Google's docs don't pin the channel limit's status, so its reason counts on 400 or 403.
  if ([400, 403].includes(error.status) && /uploadLimitExceeded/.test(error.message))
    return 'quota-spent';
  if (error.status === 403 && /quota/i.test(error.message)) return 'quota-spent';
  // A rate limit passes on a retry, so it reads as no answer rather than a denial.
  if (error.status === 429 || (error.status === 403 && /rateLimit/i.test(error.message)))
    return 'other';
  return error.status >= 400 && error.status < 500 ? 'denied' : 'other';
}

function errorReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: { reason?: unknown }[] } };
    const reason = parsed.error?.errors?.[0]?.reason;
    return typeof reason === 'string' ? reason : null;
  } catch {
    return null;
  }
}

export async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new YouTubeError(
      response.status,
      `${what} ${response.status}: ${body.slice(0, 300)}`,
      errorReason(body),
    );
  }
  return (await response.json()) as T;
}

/**
 * Catalog reads use the API key from the second project, so they never spend upload quota. The
 * caller's `deadline` bounds the request.
 */
async function keyGet<T>(
  path: string,
  params: Record<string, string>,
  deadline: number,
): Promise<T> {
  const query = new URLSearchParams({ ...params, key: required('YOUTUBE_API_KEY') });
  return readJson<T>(
    await fetch(`${API}/${path}?${query}`, { signal: budgetSignal(deadline) }),
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
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
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

export async function videosByIds(ids: string[], deadline: number): Promise<CatalogVideo[]> {
  if (ids.length === 0) return [];
  const body = await keyGet<ListResponse<VideoItem>>(
    'videos',
    { part: 'snippet,statistics,contentDetails', id: ids.slice(0, 50).join(','), maxResults: '50' },
    deadline,
  );
  return (body.items ?? []).map(toCatalog);
}

type ChannelItem = {
  id?: string;
  snippet?: { customUrl?: string; title?: string; description?: string };
  statistics?: {
    videoCount?: string;
    subscriberCount?: string;
    viewCount?: string;
    hiddenSubscriberCount?: boolean;
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
};

/** A statistic exactly as YouTube reported it; null when it sent none. */
const reported = (value: string | undefined): number | null => {
  if (value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** A channel's statistics as reported; a hidden subscriber count is `null` and `hidden`. */
export type ChannelStatsReported = {
  subscribers: number | null;
  hidden: boolean;
  videos: number | null;
  views: number | null;
};

export type PublicChannel = {
  channelId: string;
  title: string;
  description: string;
  uploadsPlaylist: string | null;
  stats: ChannelStatsReported;
};

const toChannel = (item: ChannelItem & { id: string }): PublicChannel => {
  const hidden = item.statistics?.hiddenSubscriberCount === true;
  return {
    channelId: item.id,
    title: item.snippet?.title ?? '',
    description: item.snippet?.description ?? '',
    uploadsPlaylist: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    stats: {
      subscribers: hidden ? null : reported(item.statistics?.subscriberCount),
      hidden,
      videos: reported(item.statistics?.videoCount),
      views: reported(item.statistics?.viewCount),
    },
  };
};

/** Public channels by ID (at most 50, one read), with statistics as reported. */
export async function channelsByIds(ids: string[], deadline: number): Promise<PublicChannel[]> {
  if (ids.length === 0) return [];
  const body = await keyGet<ListResponse<ChannelItem>>(
    'channels',
    { part: 'snippet,statistics,contentDetails', id: ids.slice(0, 50).join(','), maxResults: '50' },
    deadline,
  );
  return (body.items ?? [])
    .filter((item): item is ChannelItem & { id: string } => Boolean(item.id))
    .map(toChannel);
}

/** A public upload with its statistics as reported: each a number, or null when YouTube sent none. */
export type PublicUpload = Omit<CatalogVideo, 'views' | 'thumbnailUrl'> & {
  stats: { views: number | null; likes: number | null; comments: number | null };
};

/** The newest `count` uploads of a public uploads playlist, newest first. */
export async function uploadsOf(
  playlistId: string,
  count: number,
  deadline: number,
): Promise<PublicUpload[]> {
  const items = await playlistPage(() =>
    keyGet(
      'playlistItems',
      { part: 'contentDetails', playlistId, maxResults: String(Math.min(count, 50)) },
      deadline,
    ),
  );
  const ids = items
    .map((item) => item.contentDetails?.videoId)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return [];
  const body = await keyGet<ListResponse<VideoItem>>(
    'videos',
    { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: '50' },
    deadline,
  );
  const order = new Map(ids.map((id, i) => [id, i]));
  return (body.items ?? [])
    .toSorted((a, b) => order.get(a.id)! - order.get(b.id)!)
    .map((item) => {
      const { videoId, title, description, tags, publishedAt, durationSec } = toCatalog(item);
      return {
        videoId,
        title,
        description,
        tags,
        publishedAt,
        durationSec,
        stats: {
          views: reported(item.statistics?.viewCount),
          likes: reported(item.statistics?.likeCount),
          comments: reported(item.statistics?.commentCount),
        },
      };
    });
}

/** A video found by search, with the channel that published it. */
export type SearchHit = { videoId: string; channelId: string };

/**
 * Music videos for a query by relevance (`type=video`), so peers match on sound and genre first.
 * Never by view count.
 */
export async function searchVideos(
  query: string,
  options: { order: 'relevance'; maxResults: number; categoryId: string },
  deadline: number,
): Promise<SearchHit[]> {
  const body = await keyGet<
    ListResponse<{ id?: { videoId?: string }; snippet?: { channelId?: string } }>
  >(
    'search',
    {
      part: 'snippet',
      q: query,
      type: 'video',
      videoCategoryId: options.categoryId,
      order: options.order,
      maxResults: String(options.maxResults),
    },
    deadline,
  );
  return (body.items ?? []).flatMap((item) =>
    item.id?.videoId && item.snippet?.channelId
      ? [{ videoId: item.id.videoId, channelId: item.snippet.channelId }]
      : [],
  );
}
type PlaylistItem = { contentDetails?: { videoId?: string; videoPublishedAt?: string } };

/**
 * One page of an uploads playlist. YouTube answers 404 `playlistNotFound` for the uploads playlist
 * of a channel with no videos, which is an empty list, not a lost grant.
 */
async function playlistPage(
  read: () => Promise<ListResponse<PlaylistItem>>,
): Promise<PlaylistItem[]> {
  try {
    return (await read()).items ?? [];
  } catch (error) {
    if (error instanceof YouTubeError && error.reason === 'playlistNotFound') return [];
    throw error;
  }
}

const uploadsPage = (playlistId: string, deadline: number): Promise<PlaylistItem[]> =>
  playlistPage(() =>
    keyGet('playlistItems', { part: 'contentDetails', maxResults: '1', playlistId }, deadline),
  );

// Keyed by channel ID: each user's header shows their own channel, never another's.
const statsCache = new Map<string, { at: number; value: ChannelStats }>();
const STATS_TTL_MS = 10 * 60 * 1000;
/** The header has no step budget; each stats read gets its own. */
const STATS_BUDGET_MS = 15_000;

const latestUpload = async (
  playlistId: string,
  deadline: number,
): Promise<PlaylistItem | undefined> =>
  playlistId ? (await uploadsPage(playlistId, deadline))[0] : undefined;

/** A channel's header stats; cached so the home page doesn't spend a read on every visit. */
export async function channelStats(channelId: string, now = Date.now()): Promise<ChannelStats> {
  const cached = statsCache.get(channelId);
  if (cached && now - cached.at < STATS_TTL_MS) return cached.value;
  const deadline = Date.now() + STATS_BUDGET_MS;
  const body = await keyGet<ListResponse<ChannelItem>>(
    'channels',
    { part: 'snippet,statistics,contentDetails', id: channelId },
    deadline,
  );
  const item = body.items?.[0];
  if (!item) throw new YouTubeError(404, 'Channel not found');
  const uploadsPlaylist = item.contentDetails?.relatedPlaylists?.uploads ?? '';
  const latest = await latestUpload(uploadsPlaylist, deadline);
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

/** An owner-read upload, with its privacy (`public`, `unlisted`, `private`) when YouTube sent it. */
export type OwnUpload = CatalogVideo & { privacy: string | null };

/**
 * The newest `count` uploads of `channelId`, read through its owner's own grant (`token`), newest
 * first. Only snippets and status are read, never statistics, so `views` is 0. A grant that doesn't
 * own the channel throws a 404 `YouTubeError`, which `identityFailure` reads as lost access.
 */
export async function ownUploads(
  token: string,
  channelId: string,
  count: number,
  deadline: number,
): Promise<OwnUpload[]> {
  const get = async <T>(path: string, params: Record<string, string>) =>
    readJson<T>(
      await fetch(`${API}/${path}?${new URLSearchParams(params)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: budgetSignal(deadline),
      }),
      path,
    );
  // `mine=true` lists every channel on the grant, so only the connected one counts.
  const channels = await get<ListResponse<ChannelItem>>('channels', {
    part: 'contentDetails',
    mine: 'true',
  });
  const channel = channels.items?.find((item) => item.id === channelId);
  if (!channel) throw new YouTubeError(404, "channels.list: the grant doesn't own the channel");
  const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) return [];
  const items = await playlistPage(() =>
    get('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: String(Math.min(count + 5, 50)),
    }),
  );
  const ids = items
    .map((item) => item.contentDetails?.videoId)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return [];
  const body = await get<ListResponse<VideoItem>>('videos', {
    part: 'snippet,status',
    id: ids.join(','),
  });
  const order = new Map(ids.map((id, i) => [id, i]));
  return (body.items ?? [])
    .map((item) => ({ ...toCatalog(item), privacy: item.status?.privacyStatus ?? null }))
    .toSorted((a, b) => order.get(a.videoId)! - order.get(b.videoId)!)
    .slice(0, count);
}

export type VideoDuration = 'short' | 'medium' | 'long';

/** Top music videos for a query (`type=video`, `videoCategoryId=10`), optionally by length bucket. */
export async function searchMusicVideos(
  query: string,
  maxResults: number,
  videoDuration: VideoDuration | undefined,
  deadline: number,
): Promise<string[]> {
  const body = await keyGet<ListResponse<{ id?: { videoId?: string } }>>(
    'search',
    {
      part: 'id',
      q: query,
      type: 'video',
      videoCategoryId: '10',
      order: 'viewCount',
      maxResults: String(maxResults),
      ...(videoDuration ? { videoDuration } : {}),
    },
    deadline,
  );
  return (body.items ?? [])
    .map((item) => item.id?.videoId)
    .filter((id): id is string => Boolean(id));
}

/** A thumbnail as the model takes images: base64 bytes and their type. */
export type Thumbnail = { data: string; mime_type: string };

/** Fetches a thumbnail for the model by `deadline`; null when it can't be read in time. */
export async function thumbnailImage(url: string, deadline: number): Promise<Thumbnail | null> {
  try {
    const response = await fetch(url, { signal: budgetSignal(deadline) });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') ?? 'image/jpeg';
    return { data: Buffer.from(await response.arrayBuffer()).toString('base64'), mime_type: type };
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
  const end = /bytes=\d+-(\d+)/.exec(range ?? '')?.[1];
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
 * YouTube's verdict on a read-back upload. `uploadStatus` on a rejected verdict is YouTube's
 * past-tense status word (`rejected`, `failed`, `deleted`); on a pending verdict it is an
 * undocumented status word, or null when YouTube sent none.
 */
export type UploadVerdict =
  | { status: 'accepted' }
  | { status: 'pending'; uploadStatus: string | null }
  | { status: 'rejected'; uploadStatus: string };

/** Reads the video back from the target channel; only this result can mark a publish verified. */
export type ReadBack = LiveMetadata & UploadVerdict;

// Only an upload YouTube kept counts as accepted; `uploaded` is still processing but kept.
const ACCEPTED_UPLOADS = new Set(['uploaded', 'processed']);
const REJECTED_UPLOADS = new Set(['rejected', 'failed', 'deleted']);

function verdict(uploadStatus: string | undefined): UploadVerdict {
  if (uploadStatus && REJECTED_UPLOADS.has(uploadStatus)) {
    return { status: 'rejected', uploadStatus };
  }
  if (uploadStatus && ACCEPTED_UPLOADS.has(uploadStatus)) return { status: 'accepted' };
  return { status: 'pending', uploadStatus: uploadStatus || null };
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
