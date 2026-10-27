// YouTube Analytics reads for the artist's own channel (research R8). Requires the optional
// `yt-analytics.readonly` grant; every call runs through the owner's access token.
import { toolSpan } from '#lib/server/core/tracing.js';
import { budgetSignal, identityFailure, readJson, YouTubeError } from './youtube';

const REPORTS = 'https://youtubeanalytics.googleapis.com/v2/reports';
const PACIFIC = 'America/Los_Angeles';
const DAY_MS = 24 * 60 * 60_000;

type ResultTable = {
  columnHeaders?: { name?: string }[];
  rows?: (string | number)[][];
};

/** One upload's totals over the requested days, as Analytics reports them; null when it sent none. */
export type VideoTotals = {
  views: number | null;
  subscribersGained: number | null;
  subscribersLost: number | null;
};

/** Analytics days are Pacific: the `YYYY-MM-DD` date `instant` falls on in Los Angeles. */
export function pacificDate(instant: Date | string | number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

/** `date` (`YYYY-MM-DD`) moved by `days` calendar days. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

async function report(
  token: string,
  params: Record<string, string>,
  deadline: number,
): Promise<ResultTable> {
  // The span records the report's kind and days, never the token or the video's ID.
  const { metrics, dimensions } = params;
  return await toolSpan(
    'analytics',
    'analytics_report',
    { metrics, dimensions, startDate: params.startDate, endDate: params.endDate },
    async () =>
      await readJson<ResultTable>(
        await fetch(`${REPORTS}?${new URLSearchParams({ ids: 'channel==MINE', ...params })}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: budgetSignal(deadline),
        }),
        'analytics',
      ),
  );
}

const reported = (value: string | number | undefined): number | null => {
  if (value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * `videoId`'s views and subscribers gained and lost from `start` to `end` (Pacific dates). No rows
 * means Analytics has nothing for those days, so every number is null, never 0.
 */
export async function videoReport(
  token: string,
  videoId: string,
  start: string,
  end: string,
  deadline: number,
): Promise<VideoTotals> {
  const table = await report(
    token,
    {
      startDate: start,
      endDate: end,
      metrics: 'views,subscribersGained,subscribersLost',
      dimensions: 'video',
      filters: `video==${videoId}`,
    },
    deadline,
  );
  const row = table.rows?.[0];
  if (!row) return { views: null, subscribersGained: null, subscribersLost: null };
  const at = (name: string) => table.columnHeaders?.findIndex((h) => h.name === name) ?? -1;
  const value = (name: string) => reported(row[at(name)]);
  return {
    views: value('views'),
    subscribersGained: value('subscribersGained'),
    subscribersLost: value('subscribersLost'),
  };
}

/**
 * Whether Analytics has reported `day` for `videoId`. Data lags, so a window's last day missing
 * means the totals may be incomplete, not that they are zero.
 */
export async function coverageDay(
  token: string,
  videoId: string,
  day: string,
  deadline: number,
): Promise<boolean> {
  const table = await report(
    token,
    {
      startDate: day,
      endDate: day,
      metrics: 'views',
      dimensions: 'day',
      filters: `video==${videoId}`,
    },
    deadline,
  );
  return (table.rows?.length ?? 0) > 0;
}

export type AnalyticsFailure = 'analytics-not-shared' | 'access-lost' | 'busy' | 'other';

/**
 * Classifies a failed Analytics read: a 403 that isn't a quota or rate limit means the token has
 * no Analytics scope (`analytics-not-shared`), a 401 means the grant is lost, a quota, 5xx or
 * timeout waits, and anything else is a failure.
 */
export function analyticsFailure(error: unknown): AnalyticsFailure {
  const failure = identityFailure(error);
  if (failure === 'busy') return 'busy';
  if (failure === 'access-lost') {
    return error instanceof YouTubeError && error.status === 403
      ? 'analytics-not-shared'
      : 'access-lost';
  }
  return 'other';
}
