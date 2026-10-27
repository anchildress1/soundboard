// @vitest-environment node
import * as Sentry from '@sentry/sveltekit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import {
  connections,
  jobResearch,
  jobs,
  peerRejections,
  researchRuns,
} from '#lib/server/core/schema.js';
import type { PublicChannel } from '#lib/server/platforms/youtube/index.js';
import { runDelivery, type Stages } from '#lib/server/research/delivery.js';
import { bracketed, discover, PEER_CANDIDATES } from '#lib/server/research/discover.js';
import type { PeerEvidence } from '#lib/server/research/evidence.js';
import { seed, truncate } from '../../../../helpers/db';
import {
  A_JOB,
  ANALYSIS,
  CHANNEL_A,
  json,
  seedJob,
  USERS,
  USER_A,
} from '../../../../helpers/pipeline';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = () => Promise.resolve('tasks-access-token');
  },
}));

// The global Sentry mock's one span (tests/mocks/sentry.ts).
const { span } = Sentry as unknown as { span: { setAttribute: ReturnType<typeof vi.fn> } };
const DAY = 24 * 60 * 60_000;
const DELIVERY = { jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 };
const asA = <T>(operation: () => Promise<T>) => withIdentity(USER_A.uid, operation);

/** A channel answer as `channels.list` sends it; `null` subscribers means hidden. */
const channelItem = (id: string, subscribers: number | null) => ({
  id,
  snippet: { title: `Channel ${id}`, description: `About ${id}` },
  statistics:
    subscribers === null
      ? { hiddenSubscriberCount: true, videoCount: '3' }
      : { subscriberCount: String(subscribers), videoCount: '3', viewCount: '900' },
  contentDetails: { relatedPlaylists: { uploads: `UU${id}` } },
});

type World = {
  /** Channel IDs the search returns, in order, one video each. */
  search: string[];
  /** Subscribers per channel; a missing channel is gone from YouTube. */
  channels: Record<string, number | null>;
  /** Called on each sample read, before it answers. */
  onSample?: (playlistId: string) => void;
  /** Throws on the n-th sample read (1-based). */
  failSample?: { at: number; error: () => Response };
};

const fetchMock = vi.fn<typeof fetch>();
let samples = 0;

function answer(world: World) {
  samples = 0;
  fetchMock.mockImplementation((input) => Promise.resolve(reply(world, String(input))));
}

function reply(world: World, href: string): Response {
  const url = new URL(href);
  const ids = url.searchParams.get('id')?.split(',') ?? [];
  if (url.hostname === 'cloudtasks.googleapis.com') return json({});
  if (url.pathname.endsWith('/search')) {
    return json({
      items: world.search.map((channelId, i) => ({
        id: { videoId: `s${i}` },
        snippet: { channelId },
      })),
    });
  }
  if (url.pathname.endsWith('/channels')) {
    return json({
      items: ids
        .filter((id) => id in world.channels)
        .map((id) => channelItem(id, world.channels[id]!)),
    });
  }
  if (url.pathname.endsWith('/playlistItems')) {
    samples += 1;
    const playlist = url.searchParams.get('playlistId')!;
    world.onSample?.(playlist);
    if (world.failSample?.at === samples) return world.failSample.error();
    return json({ items: [{ contentDetails: { videoId: `new-${playlist}` } }] });
  }
  if (url.pathname.endsWith('/videos')) {
    return json({
      items: ids.map((id) => ({
        id,
        snippet: {
          title: `Upload ${id}`,
          tags: ['synthwave'],
          publishedAt: '2026-09-01T00:00:00Z',
        },
        statistics: { viewCount: '10' },
        contentDetails: { duration: 'PT3M30S' },
      })),
    });
  }
  throw new Error(`unexpected fetch ${url.href}`);
}

const urls = (path: string) =>
  fetchMock.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.pathname.endsWith(path));

const runAt = (patch: Partial<typeof researchRuns.$inferInsert> = {}) =>
  seed({
    researchRuns: [
      {
        jobId: 'j1',
        id: 'run-1',
        ownerUid: USER_A.uid,
        artistId: USER_A.artistId,
        stage: 'discover',
        ...patch,
      },
    ],
  });
const storedRun = async () =>
  (await db().select().from(researchRuns).where(eq(researchRuns.jobId, 'j1')))[0]!;
const storedEvidence = async () =>
  (await db().select().from(jobResearch).where(eq(jobResearch.runId, 'run-1')))[0]?.evidence as
    PeerEvidence | undefined;

/** Only discover runs; the stages after it end the run. */
const ONLY_DISCOVER: Stages = {
  learn: () => Promise.resolve({ done: 0, stage: 'discover', cursor: 0 }),
  discover,
  match: () => Promise.resolve({ done: 0, stage: 'done', cursor: 0 }),
  releases: () => Promise.resolve({ done: 0, stage: 'done', cursor: 0 }),
};
const deliver = (seq: number) => runDelivery({ ...DELIVERY, seq }, ONLY_DISCOVER);

/** Artist A sits in the 100 range (300 subscribers). */
const ARTIST_SUBS = 300;

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
  await db()
    .update(jobs)
    .set({ chunks: [{ index: 0, analysis: ANALYSIS }] })
    .where(eq(jobs.id, 'j1'));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('YOUTUBE_API_KEY', 'yt-key');
  vi.stubEnv('RESEARCH_QUEUE', 'projects/p/locations/us-central1/queues/soundboard-research');
  vi.stubEnv('RESEARCH_TASK_URL', 'https://soundboard-1.us-central1.run.app/api/research/task');
  vi.stubEnv('RESEARCH_TASK_SA', 'research@p.iam.gserviceaccount.com');
  vi.mocked(Sentry.startSpan).mockClear();
  span.setAttribute.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('discover: the genre search', () => {
  beforeEach(() => runAt());

  it('searches by relevance in Music for the top genre terms plus music, never by view count', async () => {
    answer({ search: [], channels: { [CHANNEL_A]: ARTIST_SUBS } });
    await deliver(0);
    const [search] = urls('/search');
    expect(search?.searchParams.get('q')).toBe('synthwave electronic music');
    expect(search?.searchParams.get('order')).toBe('relevance');
    expect(search?.searchParams.get('videoCategoryId')).toBe('10');
    expect(search?.searchParams.get('maxResults')).toBe('50');
    expect(search?.href).not.toContain('viewCount');
  });

  it("leaves out the artist's own channel and fresh rejections, reading the rest with A's in one call", async () => {
    await seed({
      peerRejections: [
        { artistId: USER_A.artistId, channelId: 'UCrej', retrievedAt: new Date() },
        {
          artistId: USER_A.artistId,
          channelId: 'UCold',
          retrievedAt: new Date(Date.now() - 30 * DAY),
        },
      ],
    });
    answer({
      search: [CHANNEL_A, 'UCrej', 'UCnext', 'UCold', 'UCnext'],
      channels: { [CHANNEL_A]: ARTIST_SUBS, UCrej: 2000, UCnext: 2000, UCold: 2000 },
    });
    await deliver(0);
    const [first, rejections] = urls('/channels');
    expect(first?.searchParams.get('id')).toBe(`${CHANNEL_A},UCnext,UCold`);
    expect(rejections?.searchParams.get('id')).toBe('UCrej');
    expect((await storedEvidence())?.candidates.map((c) => c.channelId)).toEqual([
      'UCnext',
      'UCold',
    ]);
  });

  it('stores the candidates, the artist range, and moves on to sampling', async () => {
    answer({ search: ['UCnext'], channels: { [CHANNEL_A]: ARTIST_SUBS, UCnext: 2000 } });
    expect(await deliver(0)).toBe(200);
    expect(await storedRun()).toMatchObject({ stage: 'discover', cursor: 1, seq: 1 });
    const stored = await storedEvidence();
    expect(stored).toMatchObject({
      query: 'synthwave electronic music',
      artist: { bracket: 100, stats: { subscribers: ARTIST_SUBS, hidden: false } },
      peers: [],
      releases: [],
    });
    expect(stored?.candidates).toEqual([
      {
        channelId: 'UCnext',
        title: 'Channel UCnext',
        description: 'About UCnext',
        uploadsPlaylist: 'UUUCnext',
        stats: { subscribers: 2000, hidden: false, videos: 3, views: 900 },
        bracket: 1000,
        relation: 'next',
      },
    ]);
  });

  it('ends the run with no-peers when nothing is left to match', async () => {
    answer({ search: [CHANNEL_A], channels: { [CHANNEL_A]: ARTIST_SUBS } });
    await deliver(0);
    expect(await storedRun()).toMatchObject({ stage: 'done', limits: ['no-peers'] });
    expect(await storedEvidence()).toMatchObject({ candidates: [] });
  });

  it('refreshes a rejection YouTube still returns and deletes one it no longer does', async () => {
    const old = new Date(Date.now() - 10 * DAY);
    await seed({
      peerRejections: [
        { artistId: USER_A.artistId, channelId: 'UCkept', retrievedAt: old },
        { artistId: USER_A.artistId, channelId: 'UCgone', retrievedAt: old },
      ],
    });
    answer({ search: ['UCnext'], channels: { [CHANNEL_A]: ARTIST_SUBS, UCnext: 2000, UCkept: 5 } });
    await deliver(0);
    const rows = await db().select().from(peerRejections);
    expect(rows.map((r) => r.channelId)).toEqual(['UCkept']);
    expect(rows[0]!.retrievedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it('records one execute_tool peer_search span with counts, never channel names', async () => {
    answer({ search: ['UCnext'], channels: { [CHANNEL_A]: ARTIST_SUBS, UCnext: 2000 } });
    await deliver(0);
    const options = vi
      .mocked(Sentry.startSpan)
      .mock.calls.map(([o]) => o as { name: string; attributes: Record<string, unknown> });
    const tool = options.find((o) => o.name === 'execute_tool peer_search');
    expect(tool?.attributes).toMatchObject({
      'gen_ai.tool.name': 'peer_search',
      'gen_ai.tool.call.arguments': JSON.stringify({ query: 'synthwave electronic music' }),
    });
    expect(span.setAttribute).toHaveBeenCalledWith(
      'gen_ai.tool.call.result',
      JSON.stringify({ results: 1, candidates: 1 }),
    );
    expect(JSON.stringify(span.setAttribute.mock.calls)).not.toContain('Channel UCnext');
  });

  it('records a spent YouTube quota as a wait with nothing advanced', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        String(input).includes('cloudtasks')
          ? json({})
          : json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }),
      ),
    );
    expect(await deliver(0)).toBe(200);
    expect(await storedRun()).toMatchObject({
      stage: 'discover',
      cursor: 0,
      wait: 'waiting on YouTube',
      consecutiveFailures: 0,
    });
    expect(await storedEvidence()).toBeUndefined();
  });
});

describe('discover: sampling', () => {
  const searched = (ids: string[]) => ({
    search: ids,
    channels: Object.fromEntries([[CHANNEL_A, ARTIST_SUBS], ...ids.map((id) => [id, 2000])]),
  });

  beforeEach(() => runAt());

  it("reads each candidate's newest upload, then hands over to match", async () => {
    answer(searched(['UC1', 'UC2']));
    await deliver(0);
    await deliver(1);
    expect(await storedRun()).toMatchObject({ stage: 'match', cursor: 0, seq: 2 });
    expect(urls('/playlistItems').map((u) => u.searchParams.get('maxResults'))).toEqual(['1', '1']);
    expect((await storedEvidence())?.candidates.map((c) => c.sample)).toEqual([
      { videoId: 'new-UUUC1', title: 'Upload new-UUUC1', tags: ['synthwave'] },
      { videoId: 'new-UUUC2', title: 'Upload new-UUUC2', tags: ['synthwave'] },
    ]);
  });

  it('keeps the samples read before a spent quota and resumes after them', async () => {
    answer({
      ...searched(['UC1', 'UC2', 'UC3']),
      failSample: {
        at: 2,
        error: () => json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }),
      },
    });
    await deliver(0);
    await deliver(1);
    expect(await storedRun()).toMatchObject({
      stage: 'discover',
      cursor: 2,
      wait: 'waiting on YouTube',
      consecutiveFailures: 0,
    });
    const candidates = (await storedEvidence())!.candidates;
    expect(candidates[0]?.sample?.videoId).toBe('new-UUUC1');
    expect(candidates[1]).not.toHaveProperty('sample');
  });

  it('records a channel with no public upload as a null sample', async () => {
    answer(searched(['UC1']));
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) =>
      new URL(String(input)).pathname.endsWith('/playlistItems')
        ? Promise.resolve(json({ items: [] }))
        : base(input, init),
    );
    await deliver(0);
    await deliver(1);
    expect((await storedEvidence())?.candidates[0]?.sample).toBeNull();
  });

  it('spans several deliveries when the samples outlast one step', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Each sample takes 50 s of the 110 s step, so a delivery reads two.
    answer({
      ...searched(['UC1', 'UC2', 'UC3']),
      onSample: () => vi.setSystemTime(Date.now() + 50_000),
    });
    await deliver(0);
    await deliver(1);
    expect(await storedRun()).toMatchObject({ stage: 'discover', cursor: 3, seq: 2 });
    await deliver(2);
    expect(await storedRun()).toMatchObject({ stage: 'match', cursor: 0, seq: 3 });
    expect((await storedEvidence())?.candidates.every((c) => c.sample)).toBe(true);
  });

  it('ends with no-peers when the evidence is gone mid-run', async () => {
    await db().update(researchRuns).set({ cursor: 1 });
    answer(searched([]));
    const batch = await asA(async () =>
      discover({ run: await storedRun(), deadline: Date.now() + 110_000 }),
    );
    expect(batch).toEqual({ done: 1, stage: 'done', cursor: 0, limits: ['no-peers'] });
  });
});

describe('bracketed', () => {
  const channel = (id: string, subscribers: number | null): PublicChannel => ({
    channelId: id,
    title: id,
    description: '',
    uploadsPlaylist: `UU${id}`,
    stats: { subscribers, hidden: subscribers === null, videos: 1, views: 1 },
  });

  it('orders next, then same, then two-up, each in search order', () => {
    const { candidates, limits } = bracketed(
      [
        channel('s1', 150),
        channel('t1', 20_000),
        channel('n1', 1500),
        channel('s2', 500),
        channel('n2', 9000),
      ],
      100,
    );
    expect(candidates.map((c) => [c.channelId, c.relation])).toEqual([
      ['n1', 'next'],
      ['n2', 'next'],
      ['s1', 'same'],
      ['s2', 'same'],
      ['t1', 'two-up'],
    ]);
    expect(limits).toEqual([]);
  });

  it('skips a channel three ranges up before the cap', () => {
    const many = Array.from({ length: PEER_CANDIDATES }, (_, i) => channel(`s${i}`, 200));
    const { candidates, skipped } = bracketed([channel('big', 200_000), ...many], 100);
    expect(candidates).toHaveLength(PEER_CANDIDATES);
    expect(candidates.map((c) => c.channelId)).not.toContain('big');
    expect(skipped).toEqual([{ channelId: 'big', reason: 'range-other' }]);
  });

  it('skips a smaller channel as another range', () => {
    expect(bracketed([channel('small', 20)], 100).skipped).toEqual([
      { channelId: 'small', reason: 'range-other' },
    ]);
  });

  it('skips a hidden-count channel and says some peers were unknown', () => {
    const { candidates, skipped, limits } = bracketed(
      [channel('h', null), channel('n', 2000)],
      100,
    );
    expect(candidates.map((c) => c.channelId)).toEqual(['n']);
    expect(skipped).toEqual([{ channelId: 'h', reason: 'range-unknown' }]);
    expect(limits).toEqual(['peer-range-unknown']);
  });

  it('keeps 12 in priority order', () => {
    const next = Array.from({ length: 8 }, (_, i) => channel(`n${i}`, 2000));
    const same = Array.from({ length: 8 }, (_, i) => channel(`s${i}`, 200));
    const { candidates } = bracketed([...same, ...next], 100);
    expect(candidates.map((c) => c.channelId)).toEqual([
      ...next.map((c) => c.channelId),
      's0',
      's1',
      's2',
      's3',
    ]);
  });

  it("keeps search order with no ranges when the artist's own count is hidden", () => {
    const list = Array.from({ length: 14 }, (_, i) =>
      channel(`c${i}`, i % 2 ? null : 10 ** (i % 6)),
    );
    const { candidates, skipped, limits } = bracketed(list, null);
    expect(candidates.map((c) => c.channelId)).toEqual(list.slice(0, 12).map((c) => c.channelId));
    expect(candidates.every((c) => c.relation === null)).toBe(true);
    expect(skipped).toEqual([]);
    expect(limits).toEqual(['artist-range-unknown']);
  });

  it('returns nothing for no channels', () => {
    expect(bracketed([], 100)).toEqual({ candidates: [], skipped: [], limits: [] });
  });
});

describe('discover: the artist range', () => {
  beforeEach(() => runAt());

  it('falls back to search order with artist-range-unknown when the artist hides the count', async () => {
    answer({ search: ['UCa', 'UCb'], channels: { [CHANNEL_A]: null, UCa: 5, UCb: 900_000 } });
    await deliver(0);
    expect(await storedRun()).toMatchObject({ limits: ['artist-range-unknown'] });
    expect((await storedEvidence())?.candidates.map((c) => c.channelId)).toEqual(['UCa', 'UCb']);
  });

  it('treats an artist without a connection as range unknown', async () => {
    await db().delete(connections).where(eq(connections.uid, USER_A.uid));
    answer({ search: ['UCa'], channels: { UCa: 5 } });
    await deliver(0);
    expect(urls('/channels')[0]?.searchParams.get('id')).toBe('UCa');
    expect(await storedRun()).toMatchObject({ limits: ['artist-range-unknown'] });
  });
});
