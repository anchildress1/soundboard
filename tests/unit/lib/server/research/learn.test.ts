// @vitest-environment node
import * as Sentry from '@sentry/sveltekit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artistOutcomes, connections, researchRuns } from '#lib/server/core/schema.js';
import { DeadlineSpent } from '#lib/server/platforms/youtube/index.js';
import { runDelivery, type Stages } from '#lib/server/research/delivery.js';
import { differs, learn } from '#lib/server/research/learn.js';
import { seed, truncate } from '../../../../helpers/db';
import {
  A_JOB,
  approvedGuide,
  CHANNEL_A,
  json,
  seedJob,
  USERS,
  USER_A,
  USER_B,
} from '../../../../helpers/pipeline';

const h = vi.hoisted(() => ({ refreshError: null as unknown }));

vi.mock('@google-cloud/kms', () => import('../../../../e2e/fakes/kms'));
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = () => Promise.resolve('tasks-access-token');
  },
  OAuth2Client: class {
    refresh = '';
    setCredentials(credentials: { refresh_token: string }) {
      this.refresh = credentials.refresh_token;
    }
    async getAccessToken() {
      if (h.refreshError) throw h.refreshError;
      return { token: `access:${this.refresh}` };
    }
  },
}));

const ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const DAY = 24 * 60 * 60_000;
const DELIVERY = { jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 };
const asA = <T>(operation: () => Promise<T>) => withIdentity(USER_A.uid, operation);
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

type Upload = {
  id: string;
  publishedAt: string;
  privacy?: string;
  title?: string;
  description?: string;
  tags?: string[];
};
type World = {
  uploads: Upload[];
  /** `[views, gained, lost]` per video; a missing video has no rows. */
  totals?: Record<string, [number, number, number]>;
  /** Videos whose last window day Analytics has reported. */
  covered?: string[];
  /** Runs before an Analytics answer, with the report's kind. */
  onReport?: (kind: 'video' | 'day') => Promise<void> | void;
  /** Replaces the n-th Analytics answer (1-based). */
  failReport?: { at: number; response: () => Response };
  /** Replaces the `channels?mine` / `playlistItems` / `videos` answers. */
  dataFailure?: { path: string; response: () => Response };
};

const fetchMock = vi.fn<typeof fetch>();
let reports = 0;

function answer(world: World) {
  reports = 0;
  fetchMock.mockImplementation((input) => reply(world, String(input)));
}

async function reply(world: World, href: string): Promise<Response> {
  const url = new URL(href);
  if (url.hostname === 'cloudtasks.googleapis.com') return json({});
  if (url.hostname === 'youtubeanalytics.googleapis.com') {
    reports += 1;
    const kind = url.searchParams.get('dimensions') === 'day' ? 'day' : 'video';
    await world.onReport?.(kind);
    if (world.failReport?.at === reports) return world.failReport.response();
    const id = url.searchParams.get('filters')!.replace('video==', '');
    if (kind === 'day')
      return json(
        world.covered?.includes(id) ? { rows: [[url.searchParams.get('startDate'), 1]] } : {},
      );
    const totals = world.totals?.[id];
    return json({
      columnHeaders: [
        { name: 'video' },
        { name: 'views' },
        { name: 'subscribersGained' },
        { name: 'subscribersLost' },
      ],
      ...(totals ? { rows: [[id, ...totals]] } : {}),
    });
  }
  const path = url.pathname.split('/').at(-1)!;
  if (world.dataFailure?.path === path) return world.dataFailure.response();
  if (path === 'channels') {
    return json({
      items: [{ id: CHANNEL_A, contentDetails: { relatedPlaylists: { uploads: 'UUflr' } } }],
    });
  }
  if (path === 'playlistItems') {
    return json({ items: world.uploads.map((u) => ({ contentDetails: { videoId: u.id } })) });
  }
  if (path === 'videos') {
    return json({
      items: world.uploads.map((u) => ({
        id: u.id,
        snippet: {
          title: u.title ?? `Song ${u.id}`,
          description: u.description ?? '',
          tags: u.tags ?? [],
          publishedAt: u.publishedAt,
        },
        status: { privacyStatus: u.privacy ?? 'public' },
      })),
    });
  }
  throw new Error(`unexpected fetch ${url.href}`);
}

const analyticsCalls = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u)))
    .filter((u) => u.hostname === 'youtubeanalytics.googleapis.com');

const share = (scopes = ['openid', 'email', ANALYTICS]) =>
  db().update(connections).set({ scopes }).where(eq(connections.uid, USER_A.uid));
const runAt = (patch: Partial<typeof researchRuns.$inferInsert> = {}) =>
  seed({
    researchRuns: [
      {
        jobId: 'j1',
        id: 'run-1',
        ownerUid: USER_A.uid,
        artistId: USER_A.artistId,
        stage: 'learn',
        ...patch,
      },
    ],
  });
const storedRun = async () =>
  (await db().select().from(researchRuns).where(eq(researchRuns.jobId, 'j1')))[0]!;
const outcomes = () => db().select().from(artistOutcomes);

/** Only learn runs; discover ends the run. */
const ONLY_LEARN: Stages = {
  learn,
  discover: () => Promise.resolve({ done: 0, stage: 'discover', cursor: 0 }),
  match: () => Promise.resolve({ done: 0, stage: 'discover', cursor: 0 }),
  releases: () => Promise.resolve({ done: 0, stage: 'discover', cursor: 0 }),
};
const deliver = (seq: number) => runDelivery({ ...DELIVERY, seq }, ONLY_LEARN);
const batch = () =>
  asA(async () => learn({ run: await storedRun(), deadline: Date.now() + 110_000 }));

const publishRecord = (
  videoId: string,
  fields: { title: string; description: string; tags: string[] },
) =>
  seed({
    artistMemory: [
      {
        artistId: USER_A.artistId,
        kind: 'publish',
        key: videoId,
        data: {
          videoId,
          url: `https://youtu.be/${videoId}`,
          jobId: 'jx',
          fields,
          status: 'VERIFIED',
          at: 1,
        },
      },
    ],
  });

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
  await share();
  h.refreshError = null;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'csecret');
  vi.stubEnv('RESEARCH_QUEUE', 'projects/p/locations/us-central1/queues/soundboard-research');
  vi.stubEnv('RESEARCH_TASK_URL', 'https://soundboard-1.us-central1.run.app/api/research/task');
  vi.stubEnv('RESEARCH_TASK_SA', 'research@p.iam.gserviceaccount.com');
  vi.mocked(Sentry.captureMessage).mockClear();
  await runAt();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('learn: consent', () => {
  it('asks Analytics for nothing and moves on when the artist has not shared it', async () => {
    await share(['openid', 'email']);
    answer({ uploads: [] });
    expect(await batch()).toEqual({
      done: 1,
      stage: 'discover',
      cursor: 0,
      limits: ['analytics-not-shared'],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a revoked connection as not shared', async () => {
    await db()
      .update(connections)
      .set({ status: 'revoked', tokenCiphertext: null })
      .where(eq(connections.uid, USER_A.uid));
    answer({ uploads: [] });
    expect((await batch()).limits).toEqual(['analytics-not-shared']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a user who never connected as not shared', async () => {
    answer({ uploads: [] });
    const run = { ...(await storedRun()), ownerUid: USER_B.uid };
    const result = await withIdentity(USER_B.uid, () =>
      learn({ run, deadline: Date.now() + 110_000 }),
    );
    expect(result.limits).toEqual(['analytics-not-shared']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('moves on as not connected when Google refuses the refresh token', async () => {
    h.refreshError = Object.assign(new Error('reauth'), {
      response: { data: { error: 'invalid_grant' } },
    });
    answer({ uploads: [] });
    expect(await batch()).toEqual({
      done: 1,
      stage: 'discover',
      cursor: 0,
      limits: ['youtube-not-connected'],
    });
    expect(analyticsCalls()).toHaveLength(0);
    expect(
      (await db().select().from(connections).where(eq(connections.uid, USER_A.uid)))[0],
    ).toMatchObject({
      status: 'revoked',
      tokenCiphertext: null,
    });
  });

  it('moves on as not connected when the stored grant does not decrypt', async () => {
    await db()
      .update(connections)
      .set({ tokenCiphertext: 'Zm9yZWlnbg==' })
      .where(eq(connections.uid, USER_A.uid));
    answer({ uploads: [] });
    expect((await batch()).limits).toEqual(['youtube-not-connected']);
    expect(analyticsCalls()).toHaveLength(0);
  });

  it('waits rather than reading when the step has no time left', async () => {
    answer({ uploads: [] });
    const run = await storedRun();
    await expect(asA(() => learn({ run, deadline: Date.now() - 1 }))).rejects.toBeInstanceOf(
      DeadlineSpent,
    );
  });

  it('gives up the grant when YouTube says the token no longer owns the channel', async () => {
    answer({
      uploads: [],
      dataFailure: { path: 'channels', response: () => json({}, { status: 401 }) },
    });
    expect(await batch()).toMatchObject({ stage: 'discover', limits: ['youtube-not-connected'] });
    expect(
      (await db().select().from(connections).where(eq(connections.uid, USER_A.uid)))[0],
    ).toMatchObject({
      status: 'revoked',
    });
  });

  it('leaves the grant alone when YouTube is busy', async () => {
    answer({
      uploads: [],
      dataFailure: { path: 'channels', response: () => json({}, { status: 503 }) },
    });
    await expect(batch()).rejects.toMatchObject({ status: 503 });
    expect(
      (await db().select().from(connections).where(eq(connections.uid, USER_A.uid)))[0],
    ).toMatchObject({
      status: 'connected',
    });
  });
});

describe('learn: reading the results', () => {
  it('includes uploads from before Soundboard and reports them as Analytics sent them', async () => {
    answer({
      uploads: [{ id: 'old1', publishedAt: daysAgo(90), title: 'Before Soundboard' }],
      totals: { old1: [1200, 14, 3] },
      covered: ['old1'],
    });
    await deliver(0);
    expect(await storedRun()).toMatchObject({ stage: 'discover', seq: 1, consecutiveFailures: 0 });
    const [row] = await outcomes();
    expect(row).toMatchObject({
      artistId: USER_A.artistId,
      videoId: 'old1',
      coverage: 'complete',
      metrics: { views: 1200, subscribersGained: 14, subscribersLost: 3 },
      live: { title: 'Before Soundboard', description: '', tags: [] },
      differsFromApproved: null,
    });
  });

  it('asks for the 28 Pacific days from the publish day, not the calendar age', async () => {
    answer({
      uploads: [{ id: 'old1', publishedAt: '2026-03-08T10:30:00Z' }],
      totals: { old1: [1, 0, 0] },
      covered: ['old1'],
    });
    await batch();
    const [totals, day] = analyticsCalls();
    expect(totals!.searchParams.get('startDate')).toBe('2026-03-08');
    expect(totals!.searchParams.get('endDate')).toBe('2026-04-04');
    expect(day!.searchParams.get('startDate')).toBe('2026-04-04');
    expect(day!.searchParams.get('endDate')).toBe('2026-04-04');
  });

  it('skips private and unlisted uploads and says so', async () => {
    answer({
      uploads: [
        { id: 'pub', publishedAt: daysAgo(60) },
        { id: 'priv', publishedAt: daysAgo(60), privacy: 'private' },
        { id: 'unl', publishedAt: daysAgo(60), privacy: 'unlisted' },
      ],
      totals: { pub: [5, 1, 0] },
      covered: ['pub'],
    });
    const result = await batch();
    expect(result.limits).toEqual(['private-releases']);
    expect(analyticsCalls().every((u) => u.searchParams.get('filters') === 'video==pub')).toBe(
      true,
    );
    await deliver(0);
    expect((await outcomes()).map((o) => o.videoId)).toEqual(['pub']);
  });

  it('marks a window that is still running open, without asking for coverage', async () => {
    answer({ uploads: [{ id: 'new1', publishedAt: daysAgo(3) }], totals: { new1: [40, 2, 0] } });
    await deliver(0);
    expect(analyticsCalls().map((u) => u.searchParams.get('dimensions'))).toEqual(['video']);
    const [row] = await outcomes();
    expect(row).toMatchObject({ coverage: 'open', metrics: { views: 40 } });
    expect(row!.requestedEnd).not.toBe(row!.requestedStart);
  });

  it('marks delayed data unknown when the last day is not reported yet', async () => {
    answer({ uploads: [{ id: 'old1', publishedAt: daysAgo(40) }], totals: { old1: [10, 0, 0] } });
    await deliver(0);
    expect((await outcomes())[0]).toMatchObject({ coverage: 'unknown' });
  });

  it('keeps every metric null, never 0, when Analytics has no rows', async () => {
    answer({ uploads: [{ id: 'old1', publishedAt: daysAgo(60) }] });
    await deliver(0);
    expect((await outcomes())[0]).toMatchObject({
      coverage: 'unknown',
      metrics: { views: null, subscribersGained: null, subscribersLost: null },
    });
  });

  it('replaces an earlier report of the same upload with the revised one', async () => {
    const world: World = {
      uploads: [{ id: 'old1', publishedAt: daysAgo(60) }],
      totals: { old1: [100, 1, 0] },
      covered: ['old1'],
    };
    answer(world);
    await deliver(0);
    await db()
      .update(researchRuns)
      .set({ stage: 'learn', claimToken: null, claimUntil: null, seq: 1 });
    world.totals = { old1: [150, 3, 1] };
    await deliver(1);
    const rows = await outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      metrics: { views: 150, subscribersGained: 3, subscribersLost: 1 },
    });
  });

  it('compares the live text with the approved text on full values, then clips the stored copy', async () => {
    const long = `${'word '.repeat(180)}end`;
    expect(long.length).toBeGreaterThan(700);
    await publishRecord('same', { title: 'Song', description: long, tags: ['a', 'b'] });
    await publishRecord('edited', { title: 'Song', description: long, tags: ['a'] });
    answer({
      uploads: [
        // Whitespace and tag order are not edits.
        {
          id: 'same',
          publishedAt: daysAgo(60),
          title: ' Song ',
          description: long.replace(' ', '  '),
          tags: ['b', 'a'],
        },
        {
          id: 'edited',
          publishedAt: daysAgo(60),
          title: 'Song',
          description: `${long}!`,
          tags: ['a'],
        },
      ],
      covered: ['same', 'edited'],
    });
    await deliver(0);
    const rows = new Map((await outcomes()).map((o) => [o.videoId, o]));
    expect(rows.get('same')).toMatchObject({ differsFromApproved: false });
    expect(rows.get('edited')).toMatchObject({ differsFromApproved: true });
    expect((rows.get('same')!.live as { description: string }).description).toHaveLength(700);
  });

  it('has nothing to report for a channel without uploads and moves on', async () => {
    answer({ uploads: [] });
    expect(await batch()).toEqual({
      done: 0,
      stage: 'discover',
      cursor: 0,
      limits: [],
      wait: undefined,
      writes: undefined,
    });
  });

  it('moves on when uploads vanished since the cursor was committed', async () => {
    answer({ uploads: [{ id: 'old1', publishedAt: daysAgo(60) }] });
    await db().update(researchRuns).set({ cursor: 5 });
    expect(await batch()).toMatchObject({ stage: 'discover', cursor: 0, done: 0 });
  });

  it('never calls Analytics for another channel than the connected one', async () => {
    answer({ uploads: [{ id: 'old1', publishedAt: daysAgo(60) }] });
    await batch();
    expect(analyticsCalls().every((u) => u.searchParams.get('ids') === 'channel==MINE')).toBe(true);
  });
});

describe('learn: failures', () => {
  it('moves on as not shared when Analytics refuses the scope, saving what it read first', async () => {
    answer({
      uploads: [
        { id: 'a', publishedAt: daysAgo(10) },
        { id: 'b', publishedAt: daysAgo(10) },
      ],
      totals: { a: [1, 0, 0] },
      failReport: {
        at: 2,
        response: () =>
          json(
            { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } },
            { status: 403 },
          ),
      },
    });
    await deliver(0);
    expect(await storedRun()).toMatchObject({
      stage: 'discover',
      limits: ['analytics-not-shared'],
      consecutiveFailures: 0,
    });
    expect((await outcomes()).map((o) => o.videoId)).toEqual(['a']);
  });

  it('gives up the grant and saves nothing when Analytics says it is lost', async () => {
    answer({
      uploads: [
        { id: 'a', publishedAt: daysAgo(10) },
        { id: 'b', publishedAt: daysAgo(10) },
      ],
      totals: { a: [1, 0, 0] },
      failReport: { at: 2, response: () => json({ error: { code: 401 } }, { status: 401 }) },
    });
    await deliver(0);
    expect(await storedRun()).toMatchObject({
      stage: 'discover',
      limits: ['youtube-not-connected'],
    });
    expect(await outcomes()).toEqual([]);
    expect(
      (await db().select().from(connections).where(eq(connections.uid, USER_A.uid)))[0],
    ).toMatchObject({
      status: 'revoked',
    });
  });

  it('waits on a busy Analytics without counting a failure, even before any progress', async () => {
    answer({
      uploads: [{ id: 'a', publishedAt: daysAgo(10) }],
      failReport: { at: 1, response: () => json({}, { status: 503 }) },
    });
    await deliver(0);
    expect(await storedRun()).toMatchObject({
      stage: 'learn',
      cursor: 0,
      wait: 'waiting on YouTube',
      consecutiveFailures: 0,
      seq: 1,
    });
  });

  it('keeps the uploads reported before a spent quota and resumes after them', async () => {
    answer({
      uploads: [
        { id: 'a', publishedAt: daysAgo(10) },
        { id: 'b', publishedAt: daysAgo(10) },
      ],
      totals: { a: [1, 0, 0], b: [2, 0, 0] },
      failReport: {
        at: 2,
        response: () => json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }),
      },
    });
    await deliver(0);
    expect(await storedRun()).toMatchObject({
      stage: 'learn',
      cursor: 1,
      wait: 'waiting on YouTube',
    });
    expect((await outcomes()).map((o) => o.videoId)).toEqual(['a']);
    await deliver(1);
    expect(await storedRun()).toMatchObject({ stage: 'discover' });
    expect((await outcomes()).map((o) => o.videoId).toSorted()).toEqual(['a', 'b']);
  });

  it('fails the batch, not the run, on an error that is not a wait', async () => {
    answer({
      uploads: [{ id: 'a', publishedAt: daysAgo(10) }],
      failReport: { at: 1, response: () => json({ error: { code: 400 } }, { status: 400 }) },
    });
    await deliver(0);
    expect(await storedRun()).toMatchObject({ stage: 'learn', consecutiveFailures: 1 });
  });

  it('spans several deliveries when 20 uploads outlast one step', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const uploads = Array.from({ length: 20 }, (_, i) => ({
      id: `v${i}`,
      publishedAt: daysAgo(10),
    }));
    // Each upload's report takes 25 s of the 110 s step, so a delivery reads four.
    answer({ uploads, onReport: () => void vi.setSystemTime(Date.now() + 25_000) });
    await deliver(0);
    expect(await storedRun()).toMatchObject({ stage: 'learn', cursor: 4, seq: 1 });
    let seq = 1;
    while ((await storedRun()).stage === 'learn') await deliver(seq++);
    expect(await storedRun()).toMatchObject({ stage: 'discover' });
    expect(await outcomes()).toHaveLength(20);
  });
});

describe('learn: the grant changes while a report is in flight', () => {
  const world = (onReport: World['onReport']): World => ({
    uploads: [{ id: 'old1', publishedAt: daysAgo(60) }],
    totals: { old1: [100, 1, 0] },
    covered: ['old1'],
    onReport,
  });

  it('writes nothing after a disconnect, and the next delivery finds nothing shared', async () => {
    let first = true;
    answer(
      world(async () => {
        if (!first) return;
        first = false;
        await db().delete(connections).where(eq(connections.uid, USER_A.uid));
      }),
    );
    await deliver(0);
    expect(await outcomes()).toEqual([]);
    expect(await storedRun()).toMatchObject({
      stage: 'learn',
      cursor: 0,
      seq: 1,
      wait: 'waiting on YouTube',
      consecutiveFailures: 0,
      claimToken: null,
    });
    await deliver(1);
    expect(await storedRun()).toMatchObject({
      stage: 'discover',
      limits: ['analytics-not-shared'],
    });
    expect(await outcomes()).toEqual([]);
  });

  it('writes nothing under the old grant after a reconnect, then reads again under the new one', async () => {
    let first = true;
    answer(
      world(async () => {
        if (!first) return;
        first = false;
        await db()
          .update(connections)
          .set({ updatedAt: new Date(Date.now() + 5) })
          .where(eq(connections.uid, USER_A.uid));
      }),
    );
    await deliver(0);
    expect(await outcomes()).toEqual([]);
    expect(await storedRun()).toMatchObject({ stage: 'learn', seq: 1, consecutiveFailures: 0 });
    await deliver(1);
    expect(await storedRun()).toMatchObject({ stage: 'discover' });
    expect((await outcomes()).map((o) => o.videoId)).toEqual(['old1']);
  });

  it('never writes the approved guide or any other artist data', async () => {
    await seed({ artistGuides: [approvedGuide(USER_A.artistId, 'brand', { rules: [] } as never)] });
    const before = await db().query.artistGuides.findMany();
    answer(world(undefined));
    await deliver(0);
    expect(await db().query.artistGuides.findMany()).toEqual(before);
  });
});

describe('differs', () => {
  const live = { title: 'T', description: 'D', tags: ['x'] } as Parameters<typeof differs>[0];
  const approved = { title: 'T', description: 'D', hashtags: [], tags: ['x'] };

  it('is false for identical values', () => {
    expect(differs(live, approved)).toBe(false);
  });

  it.each([
    ['title', { title: 'T2' }],
    ['description', { description: 'D2' }],
    ['tags', { tags: ['x', 'y'] }],
  ])('is true when the %s changed', (_field, patch) => {
    expect(differs({ ...live, ...patch }, approved)).toBe(true);
  });
});
