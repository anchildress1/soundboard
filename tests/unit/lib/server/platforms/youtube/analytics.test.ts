// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSpan } from '../../../../../mocks/sentry';
import {
  addDays,
  analyticsFailure,
  coverageDay,
  pacificDate,
  videoReport,
} from '#lib/server/platforms/youtube/analytics.js';
import { DeadlineSpent, YouTubeError } from '#lib/server/platforms/youtube/youtube.js';
import { json } from '../../../../../helpers/pipeline';

const later = () => Date.now() + 60_000;
const fetchMock = vi.fn<typeof fetch>();

const table = (rows?: (string | number)[][]) =>
  json({
    kind: 'youtubeAnalytics#resultTable',
    columnHeaders: [
      { name: 'video', columnType: 'DIMENSION' },
      { name: 'views', columnType: 'METRIC' },
      { name: 'subscribersGained', columnType: 'METRIC' },
      { name: 'subscribersLost', columnType: 'METRIC' },
    ],
    ...(rows ? { rows } : {}),
  });

const failure = (status: number, reason: string) =>
  json({ error: { code: status, errors: [{ reason }] } }, { status });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(startSpan).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe('pacificDate', () => {
  it.each([
    ['2026-10-25T06:59:00Z', '2026-10-24'],
    ['2026-10-25T07:00:00Z', '2026-10-25'],
    ['2026-03-08T10:30:00Z', '2026-03-08'],
    ['2026-03-08T07:59:00Z', '2026-03-07'],
    ['2026-11-01T08:30:00Z', '2026-11-01'],
    ['2026-11-01T07:59:00Z', '2026-11-01'],
    ['2026-11-02T07:30:00Z', '2026-11-01'],
  ])('puts %s on the Pacific day %s', (instant, day) => {
    expect(pacificDate(instant)).toBe(day);
  });

  it('takes a Date or a timestamp too', () => {
    const instant = Date.parse('2026-10-25T06:59:00Z');
    expect(pacificDate(new Date(instant))).toBe('2026-10-24');
    expect(pacificDate(instant)).toBe('2026-10-24');
  });
});

describe('addDays', () => {
  it('moves across months and years', () => {
    expect(addDays('2026-10-25', 27)).toBe('2026-11-21');
    expect(addDays('2026-12-20', 27)).toBe('2027-01-16');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts calendar days across the DST change', () => {
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });
});

describe('videoReport', () => {
  it('asks for the upload alone over the window and reads the numbers as reported', async () => {
    fetchMock.mockResolvedValue(table([['vid1', 1200, 14, 3]]));
    const totals = await videoReport('tok', 'vid1', '2026-10-01', '2026-10-28', later());
    expect(totals).toEqual({ views: 1200, subscribersGained: 14, subscribersLost: 3 });
    const [href, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(href));
    expect(url.origin + url.pathname).toBe('https://youtubeanalytics.googleapis.com/v2/reports');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ids: 'channel==MINE',
      startDate: '2026-10-01',
      endDate: '2026-10-28',
      metrics: 'views,subscribersGained,subscribersLost',
      dimensions: 'video',
      filters: 'video==vid1',
    });
    expect(init?.headers).toEqual({ authorization: 'Bearer tok' });
  });

  it('reads columns by their header, whatever order they come in', async () => {
    fetchMock.mockResolvedValue(
      json({
        columnHeaders: [
          { name: 'subscribersLost' },
          { name: 'views' },
          { name: 'subscribersGained' },
        ],
        rows: [[1, 50, 2]],
      }),
    );
    expect(await videoReport('t', 'v', 'a', 'b', later())).toEqual({
      views: 50,
      subscribersGained: 2,
      subscribersLost: 1,
    });
  });

  it('gives null, never 0, when Analytics has no rows', async () => {
    fetchMock.mockResolvedValue(table());
    expect(await videoReport('t', 'v', 'a', 'b', later())).toEqual({
      views: null,
      subscribersGained: null,
      subscribersLost: null,
    });
  });

  it('gives null for a metric Analytics left out or sent unreadable', async () => {
    fetchMock.mockResolvedValue(
      json({
        columnHeaders: [{ name: 'views' }, { name: 'subscribersGained' }],
        rows: [['7', 'x']],
      }),
    );
    expect(await videoReport('t', 'v', 'a', 'b', later())).toEqual({
      views: 7,
      subscribersGained: null,
      subscribersLost: null,
    });
  });

  it('gives null when there are no column headers at all', async () => {
    fetchMock.mockResolvedValue(json({ rows: [[1, 2, 3]] }));
    expect(await videoReport('t', 'v', 'a', 'b', later())).toEqual({
      views: null,
      subscribersGained: null,
      subscribersLost: null,
    });
  });

  it('records one analytics_report span without the token or the video', async () => {
    fetchMock.mockResolvedValue(table());
    await videoReport('secret-token', 'private-vid', '2026-10-01', '2026-10-28', later());
    expect(startSpan).toHaveBeenCalledTimes(1);
    const [options] = vi.mocked(startSpan).mock.calls[0]!;
    expect(options).toMatchObject({ name: 'execute_tool analytics_report' });
    const recorded = JSON.stringify(options);
    expect(recorded).not.toContain('secret-token');
    expect(recorded).not.toContain('private-vid');
  });

  it('throws a YouTubeError carrying the status and reason on a refusal', async () => {
    fetchMock.mockResolvedValue(failure(403, 'insufficientPermissions'));
    await expect(videoReport('t', 'v', 'a', 'b', later())).rejects.toMatchObject({
      status: 403,
      reason: 'insufficientPermissions',
    });
  });

  it('starts no request once the step has no time left', async () => {
    await expect(videoReport('t', 'v', 'a', 'b', Date.now() - 1)).rejects.toBeInstanceOf(
      DeadlineSpent,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('coverageDay', () => {
  it('asks for one day of one upload', async () => {
    fetchMock.mockResolvedValue(json({ rows: [['2026-10-28', 4]] }));
    expect(await coverageDay('tok', 'vid1', '2026-10-28', later())).toBe(true);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ids: 'channel==MINE',
      startDate: '2026-10-28',
      endDate: '2026-10-28',
      metrics: 'views',
      dimensions: 'day',
      filters: 'video==vid1',
    });
  });

  it('is false when Analytics has not reported the day', async () => {
    fetchMock.mockResolvedValue(json({ columnHeaders: [] }));
    expect(await coverageDay('t', 'v', '2026-10-28', later())).toBe(false);
  });
});

describe('analyticsFailure', () => {
  const error = (status: number, reason: string | null = null) =>
    new YouTubeError(status, `analytics ${status}`, reason);

  it('reads a 403 without a quota reason as the missing scope', () => {
    expect(analyticsFailure(error(403, 'insufficientPermissions'))).toBe('analytics-not-shared');
    expect(analyticsFailure(error(403))).toBe('analytics-not-shared');
  });

  it('reads a 401 as a lost grant', () => {
    expect(analyticsFailure(error(401))).toBe('access-lost');
  });

  it('waits on a quota, rate limit, 429, 5xx or timeout', () => {
    expect(analyticsFailure(error(403, 'quotaExceeded'))).toBe('busy');
    expect(analyticsFailure(error(429))).toBe('busy');
    expect(analyticsFailure(error(503))).toBe('busy');
    expect(analyticsFailure(new DeadlineSpent())).toBe('busy');
  });

  it('calls anything else a failure', () => {
    expect(analyticsFailure(error(400))).toBe('other');
    expect(analyticsFailure(new Error('boom'))).toBe('other');
  });
});
