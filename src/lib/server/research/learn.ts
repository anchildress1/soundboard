// Learn (research R8): the artist's own uploads and their first 28 days of results, read through
// their optional analytics grant. Cursor k is the k-th public upload; a delivery reports as many as
// the step allows and saves them in the commit, under the grant they were read through.
import { and, inArray, sql } from 'drizzle-orm';
import { query } from '#lib/server/core/db.js';
import { artistMemory } from '#lib/server/core/schema.js';
import { memoryOf } from '#lib/server/artist/memory.js';
import {
  accessTokenFor,
  addDays,
  analyticsFailure,
  analyticsShared,
  coverageDay,
  getConnection,
  identityFailure,
  ownUploads,
  pacificDate,
  videoReport,
  type OwnUpload,
  type VideoTotals,
} from '#lib/server/platforms/youtube/index.js';
import type { PickFields } from '#lib/types.js';
import { eachItem, type Batch, type StageContext } from './batch';
import type { ResearchLimit } from './runs';

/** Uploads reported per run: recent ones, including those from before Soundboard (FR-004). */
const UPLOADS = 20;
/** Two Analytics reads per upload. */
const REPORT_MS = 4_000;
/** The first 28 days run from the publish day to 27 days after it. */
const WINDOW_LAST_DAY = 27;
/** Live descriptions are kept this long; the comparison with the approved text uses the full one. */
const LIVE_DESCRIPTION = 700;

export type Coverage = 'open' | 'complete' | 'unknown';

/** One saved outcome, as `soundboard_save_outcomes` reads it. */
type OutcomeRow = {
  videoId: string;
  publishedAt: string;
  requestedStart: string;
  requestedEnd: string;
  coverage: Coverage;
  metrics: VideoTotals;
  live: { title: string; description: string; tags: string[] };
  differsFromApproved: boolean | null;
};

const advance = (limits: ResearchLimit[]): Batch => ({
  done: 1,
  stage: 'discover',
  cursor: 0,
  limits,
});

export async function learn({ run, deadline }: StageContext): Promise<Batch> {
  const uid = run.ownerUid;
  const connection = await getConnection(uid);
  if (connection?.status !== 'connected' || !analyticsShared(connection)) {
    return advance(['analytics-not-shared']);
  }
  const access = await accessTokenFor(uid, connection.channelId, deadline);
  if (!access) return advance(['youtube-not-connected']);

  let uploads: OwnUpload[];
  try {
    uploads = await ownUploads(access.token, connection.channelId, UPLOADS, deadline);
  } catch (error) {
    // Only a refused grant is given up; a busy YouTube or timeout is a wait for the delivery.
    if (identityFailure(error) !== 'access-lost') throw error;
    await access.refused({ 'job.id': run.jobId });
    return advance(['youtube-not-connected']);
  }
  const published = uploads.filter((upload) => upload.privacy === 'public');
  const limits: ResearchLimit[] = published.length < uploads.length ? ['private-releases'] : [];
  const approved = await approvedFields(
    run.artistId,
    published.map((upload) => upload.videoId),
  );

  const rows: OutcomeRow[] = [];
  let lost: ResearchLimit | null = null;
  const items = await eachItem(published, run.cursor, deadline, REPORT_MS, async (upload) => {
    try {
      rows.push(await outcomeOf(access.token, upload, approved.get(upload.videoId), deadline));
      return undefined;
    } catch (error) {
      // Analytics refuses the token: stop here, keeping what was read before it.
      const failure = analyticsFailure(error);
      if (failure === 'analytics-not-shared') lost = 'analytics-not-shared';
      else if (failure === 'access-lost') lost = 'youtube-not-connected';
      else throw error;
      return 'stop';
    }
  });
  if (lost === 'youtube-not-connected') {
    // The grant is refused outright: nothing read through it is saved.
    await access.refused({ 'job.id': run.jobId });
    return advance([...limits, lost]);
  }
  const finished = lost !== null || items.next >= published.length;
  return {
    done: items.done,
    stage: finished ? 'discover' : 'learn',
    cursor: finished ? 0 : items.next,
    limits: lost ? [...limits, lost] : limits,
    wait: items.wait,
    writes:
      rows.length === 0
        ? undefined
        : async (tx, token) => {
            await tx.execute(
              sql`select public.soundboard_save_outcomes(${run.id}, ${token}, ${access.grantAt.toISOString()}::timestamptz, ${JSON.stringify(rows)}::jsonb)`,
            );
          },
  };
}

async function outcomeOf(
  token: string,
  upload: OwnUpload,
  approved: PickFields | undefined,
  deadline: number,
): Promise<OutcomeRow> {
  const start = pacificDate(upload.publishedAt);
  const last = addDays(start, WINDOW_LAST_DAY);
  const today = pacificDate(Date.now());
  // Analytics lags a day or more, so a window that reaches today is still collecting.
  const open = last >= today;
  const end = open ? today : last;
  const metrics = await videoReport(token, upload.videoId, start, end, deadline);
  let coverage: Coverage = 'open';
  if (!open) {
    coverage = (await coverageDay(token, upload.videoId, end, deadline)) ? 'complete' : 'unknown';
  }
  return {
    videoId: upload.videoId,
    publishedAt: upload.publishedAt,
    requestedStart: start,
    requestedEnd: end,
    coverage,
    metrics,
    live: {
      title: upload.title,
      description: upload.description.slice(0, LIVE_DESCRIPTION),
      tags: upload.tags,
    },
    differsFromApproved: approved ? differs(upload, approved) : null,
  };
}

const squash = (text: string) => text.replaceAll(/\s+/g, ' ').trim();

/**
 * Whether the live title, description or tags differ from the approved ones. Whole values with
 * whitespace squashed, compared before any clipping; a reordered tag list is not a change.
 */
export function differs(live: OwnUpload, approved: PickFields): boolean {
  const tags = (list: string[]) =>
    list
      .map(squash)
      .toSorted((a, b) => a.localeCompare(b))
      .join('\n');
  return (
    squash(live.title) !== squash(approved.title) ||
    squash(live.description) !== squash(approved.description) ||
    tags(live.tags) !== tags(approved.tags)
  );
}

/** The fields approved for each video the artist published through Soundboard. */
async function approvedFields(
  artistId: string,
  videoIds: string[],
): Promise<Map<string, PickFields>> {
  if (videoIds.length === 0) return new Map();
  const rows = await query((tx) =>
    tx
      .select({ key: artistMemory.key, data: artistMemory.data })
      .from(artistMemory)
      .where(and(memoryOf(artistId, 'publish'), inArray(artistMemory.key, videoIds))),
  );
  return new Map(
    rows.map((row) => [row.key!, (row.data as { fields: PickFields }).fields] as const),
  );
}
