// @vitest-environment node
import * as Sentry from '@sentry/sveltekit';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { jobResearch, researchRuns } from '#lib/server/core/schema.js';
import type { PublicUpload } from '#lib/server/platforms/youtube/index.js';
import { runDelivery, type Stages } from '#lib/server/research/delivery.js';
import type { Candidate, Peer, PeerEvidence } from '#lib/server/research/evidence.js';
import {
  comparableLength,
  inWindow,
  releases,
  selectReleases,
} from '#lib/server/research/releases.js';
import { seed, truncate } from '../../../../helpers/db';
import { A_JOB, json, seedJob, USERS, USER_A } from '../../../../helpers/pipeline';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = () => Promise.resolve('tasks-access-token');
  },
}));

const DAY = 24 * 60 * 60_000;
const DELIVERY = { jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 };
const asA = <T>(operation: () => Promise<T>) => withIdentity(USER_A.uid, operation);
const stats = { subscribers: 2000, hidden: false, videos: 10, views: 5000 };
/** The artist's upload is 200 s long, so releases of 140–260 s compare. */
const UPLOAD_SEC = 200;

describe('comparableLength', () => {
  it('needs both lengths known', () => {
    expect(comparableLength(0, 200)).toBe(false);
    expect(comparableLength(200, 0)).toBe(false);
    expect(comparableLength(Number.NaN, 200)).toBe(false);
  });

  it('never compares across 180 s, where a release may be a Short', () => {
    expect(comparableLength(180, 181)).toBe(false);
    expect(comparableLength(181, 180)).toBe(false);
    expect(comparableLength(179, 180)).toBe(true);
    expect(comparableLength(181, 182)).toBe(true);
  });

  it('allows the larger of 60 s and 25 % of the upload', () => {
    expect(comparableLength(260, 200)).toBe(true);
    expect(comparableLength(261, 200)).toBe(false);
    expect(comparableLength(1141, 1140)).toBe(true);
    // 25 % of 1200 s is 300 s, past the 60 s floor.
    expect(comparableLength(1500, 1200)).toBe(true);
    expect(comparableLength(1501, 1200)).toBe(false);
    expect(comparableLength(225, 300)).toBe(true);
    expect(comparableLength(224, 300)).toBe(false);
  });
});

describe('inWindow', () => {
  const retrieved = new Date('2026-10-25T12:00:00Z');
  const ago = (ms: number) => new Date(retrieved.getTime() - ms).toISOString();

  it('takes releases published 14 days to 3 years before retrieval', () => {
    expect(inWindow(ago(14 * DAY), retrieved)).toBe(true);
    expect(inWindow(ago(13 * DAY), retrieved)).toBe(false);
    expect(inWindow('2023-10-25T12:00:00Z', retrieved)).toBe(true);
    expect(inWindow('2023-10-25T11:59:59Z', retrieved)).toBe(false);
    expect(inWindow('2023-10-24T12:00:00Z', retrieved)).toBe(false);
  });

  it('refuses a release from the future or with no readable date', () => {
    expect(inWindow(ago(-DAY), retrieved)).toBe(false);
    expect(inWindow('', retrieved)).toBe(false);
    expect(inWindow('not a date', retrieved)).toBe(false);
  });
});

const upload = (id: string, over: Partial<PublicUpload> & { views?: number | null } = {}) => {
  const { views = 100, ...rest } = over;
  return {
    videoId: id,
    title: `Title ${id}`,
    description: `Desc ${id} #synthwave`,
    tags: ['synthwave'],
    publishedAt: '2026-08-01T00:00:00Z',
    durationSec: UPLOAD_SEC,
    stats: { views, likes: 10, comments: 0 },
    ...rest,
  } satisfies PublicUpload;
};

describe('selectReleases', () => {
  const ids = (uploads: PublicUpload[]) =>
    selectReleases(uploads).map((c) => [c.upload.videoId, c.selectedAs]);

  it('takes the newest, then the most viewed, then the most engaged of the rest', () => {
    const uploads = [
      upload('old-big', { publishedAt: '2026-05-01T00:00:00Z', views: 9000 }),
      upload('new', { publishedAt: '2026-09-01T00:00:00Z', views: 50 }),
      upload('mid-engaged', {
        publishedAt: '2026-07-01T00:00:00Z',
        views: 200,
        stats: { views: 200, likes: 100, comments: 20 },
      }),
      upload('mid-plain', { publishedAt: '2026-06-01T00:00:00Z', views: 300 }),
    ];
    expect(ids(uploads)).toEqual([
      ['new', 'newest'],
      ['old-big', 'most-viewed'],
      ['mid-engaged', 'most-engaged'],
    ]);
  });

  it('returns what it has when a channel has fewer than three comparable releases', () => {
    expect(ids([upload('only')])).toEqual([['only', 'newest']]);
    expect(ids([])).toEqual([]);
    expect(ids([upload('a'), upload('b', { publishedAt: '2026-07-01T00:00:00Z' })])).toEqual([
      ['a', 'newest'],
      ['b', 'most-viewed'],
    ]);
  });

  it('lets no release with a null statistic win that slot', () => {
    const uploads = [
      upload('new', { publishedAt: '2026-09-01T00:00:00Z' }),
      upload('blank', { publishedAt: '2026-08-01T00:00:00Z', views: null }),
    ];
    // Nothing else reports views, so only `new` qualifies and the blank one fills no slot.
    expect(ids(uploads)).toEqual([['new', 'newest']]);
  });

  it('cannot rank engagement without views, likes and comments', () => {
    const uploads = [
      upload('new', { publishedAt: '2026-09-01T00:00:00Z' }),
      upload('views-only', {
        publishedAt: '2026-08-01T00:00:00Z',
        stats: { views: 40, likes: null, comments: null },
      }),
      upload('zero', {
        publishedAt: '2026-07-01T00:00:00Z',
        stats: { views: 0, likes: 0, comments: 0 },
      }),
    ];
    expect(ids(uploads)).toEqual([
      ['new', 'newest'],
      ['views-only', 'most-viewed'],
    ]);
  });

  it('gives a tie to the newer release', () => {
    const uploads = [
      upload('newest', { publishedAt: '2026-09-01T00:00:00Z' }),
      upload('older', { publishedAt: '2026-06-01T00:00:00Z', views: 500 }),
      upload('newer', { publishedAt: '2026-07-01T00:00:00Z', views: 500 }),
    ];
    expect(ids(uploads)[1]).toEqual(['newer', 'most-viewed']);
    expect(ids([...uploads].reverse())[1]).toEqual(['newer', 'most-viewed']);
  });
});

// ---- the stage, through deliveries ----

type Video = {
  id: string;
  sec?: number | null;
  published?: string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
};
/** Uploads per playlist, newest first; a missing playlist is empty. */
let world: Record<string, Video[]>;
let reads: string[];
const fetchMock = vi.fn<typeof fetch>();

const iso = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function answer(failAt?: { playlist: string; reply: () => Response }) {
  fetchMock.mockImplementation((input) => {
    const url = new URL(String(input));
    if (url.hostname === 'cloudtasks.googleapis.com') return Promise.resolve(json({}));
    if (url.pathname.endsWith('/playlistItems')) {
      const playlist = url.searchParams.get('playlistId')!;
      reads.push(playlist);
      if (failAt?.playlist === playlist) return Promise.resolve(failAt.reply());
      const items = (world[playlist] ?? []).map((v) => ({ contentDetails: { videoId: v.id } }));
      return Promise.resolve(json({ items }));
    }
    if (url.pathname.endsWith('/videos')) {
      const wanted = url.searchParams.get('id')!.split(',');
      const all = Object.values(world).flat();
      const items = wanted.map((id) => {
        const v = all.find((x) => x.id === id)!;
        return {
          id,
          snippet: {
            title: `Title ${id}`,
            description: `Desc ${id} #synth #retro`,
            tags: ['synthwave'],
            publishedAt: v.published ?? iso(60),
          },
          statistics: {
            ...(v.views === null ? {} : { viewCount: String(v.views ?? 100) }),
            ...(v.likes === null ? {} : { likeCount: String(v.likes ?? 10) }),
            ...(v.comments === null ? {} : { commentCount: String(v.comments ?? 1) }),
          },
          contentDetails: v.sec === null ? {} : { duration: `PT${v.sec ?? UPLOAD_SEC}S` },
        };
      });
      return Promise.resolve(json({ items }));
    }
    throw new Error(`unexpected fetch ${url.href}`);
  });
}

const peer = (n: number): Peer => ({
  ref: `P${n}`,
  channelId: `UC${n}`,
  title: `Channel ${n}`,
  basis: 'heard',
  explanation: 'Alike.',
  stats,
  bracket: 1000,
  relation: 'next',
  secondary: false,
});
const candidate = (n: number): Candidate => ({
  channelId: `UC${n}`,
  title: `Channel ${n}`,
  description: '',
  uploadsPlaylist: `UU${n}`,
  stats,
  bracket: 1000,
  relation: 'next',
});

const store = (peers: Peer[], over: Partial<PeerEvidence> = {}) =>
  seed({
    jobResearch: [
      {
        runId: 'run-1',
        jobId: 'j1',
        retrievedAt: new Date(),
        evidence: {
          query: 'synthwave music',
          artist: { stats: null, bracket: 100 },
          candidates: peers.map((p) => candidate(Number(p.ref.slice(1)))),
          peers,
          releases: [],
          skipped: [],
          ...over,
        },
      },
    ],
  });
const runAt = () =>
  seed({
    researchRuns: [
      {
        jobId: 'j1',
        id: 'run-1',
        ownerUid: USER_A.uid,
        artistId: USER_A.artistId,
        stage: 'releases',
      },
    ],
  });
const storedRun = async () =>
  (await db().select().from(researchRuns).where(eq(researchRuns.jobId, 'j1')))[0]!;
const storedEvidence = async () =>
  (await db().select().from(jobResearch).where(eq(jobResearch.runId, 'run-1')))[0]!
    .evidence as PeerEvidence;

const ONLY_RELEASES: Stages = {
  learn: () => Promise.resolve({ done: 0, stage: 'discover', cursor: 0 }),
  discover: () => Promise.resolve({ done: 0, stage: 'match', cursor: 0 }),
  match: () => Promise.resolve({ done: 0, stage: 'releases', cursor: 0 }),
  releases,
};
const deliver = (seq: number) => runDelivery({ ...DELIVERY, seq }, ONLY_RELEASES);

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({
    ...A_JOB,
    id: 'j1',
    state: 'PICK',
    probe: { durationSec: UPLOAD_SEC, width: 1920, height: 1080, hasAudio: true },
  });
  await runAt();
  world = {};
  reads = [];
  fetchMock.mockReset();
  answer();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('YOUTUBE_API_KEY', 'yt-key');
  vi.stubEnv('RESEARCH_QUEUE', 'projects/p/locations/us-central1/queues/soundboard-research');
  vi.stubEnv('RESEARCH_TASK_URL', 'https://soundboard-1.us-central1.run.app/api/research/task');
  vi.stubEnv('RESEARCH_TASK_SA', 'research@p.iam.gserviceaccount.com');
  vi.mocked(Sentry.startSpan).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('releases: the stage', () => {
  it("reads each peer's ten newest uploads and keeps its comparable releases, then ends the run", async () => {
    world = {
      UU1: [
        { id: 'a-new', published: iso(30) },
        { id: 'a-mid', published: iso(90), views: 5000 },
        { id: 'a-old', published: iso(200), likes: 400, comments: 50, views: 800 },
      ],
      UU2: [{ id: 'b-new', published: iso(20) }],
    };
    await store([peer(1), peer(2)]);

    await deliver(0);

    expect(await storedRun()).toMatchObject({ stage: 'done', cursor: 0, seq: 1, wait: null });
    const url = new URL(
      String(fetchMock.mock.calls.find(([u]) => String(u).includes('playlistItems'))![0]),
    );
    expect(url.searchParams.get('maxResults')).toBe('10');
    const { releases: kept } = await storedEvidence();
    expect(kept.map((r) => [r.ref, r.peer, r.videoId, r.selectedAs])).toEqual([
      ['P1-R1', 'P1', 'a-new', 'newest'],
      ['P1-R2', 'P1', 'a-mid', 'most-viewed'],
      ['P1-R3', 'P1', 'a-old', 'most-engaged'],
      ['P2-R1', 'P2', 'b-new', 'newest'],
    ]);
    expect(kept[0]).toMatchObject({
      title: 'Title a-new',
      description: 'Desc a-new #synth #retro',
      tags: ['synthwave'],
      hashtags: ['#synth', '#retro'],
      durationSec: UPLOAD_SEC,
      stats: { views: 100, likes: 10, comments: 1 },
    });
  });

  it('leaves out releases of another length, too new, too old, or of unknown length', async () => {
    world = {
      UU1: [
        { id: 'short', sec: 150 },
        { id: 'a-short-side', sec: 179 },
        { id: 'unknown-length', sec: null },
        { id: 'too-new', published: iso(13) },
        { id: 'too-old', published: iso(3 * 365 + 5) },
        { id: 'ok', published: iso(40) },
      ],
    };
    await store([peer(1)]);
    await deliver(0);
    const { releases: kept } = await storedEvidence();
    // 150 s is within 60 s of 200 s but on the Short side of 180 s; 179 s is too.
    expect(kept.map((r) => r.videoId)).toEqual(['ok']);
  });

  it('keeps no release when the artist upload has no known length', async () => {
    await db().execute(sql`update jobs set data = data - 'probe' where id = 'j1'`);
    world = { UU1: [{ id: 'ok' }] };
    await store([peer(1)]);
    await deliver(0);
    expect((await storedEvidence()).releases).toEqual([]);
    expect(await storedRun()).toMatchObject({ stage: 'done' });
  });

  it('never compares releases across peers: each keeps its own slots', async () => {
    world = {
      UU1: [{ id: 'a1', published: iso(30), views: 10 }],
      UU2: [{ id: 'b1', published: iso(30), views: 9_000_000 }],
    };
    await store([peer(1), peer(2)]);
    await deliver(0);
    const { releases: kept } = await storedEvidence();
    expect(kept.map((r) => [r.peer, r.selectedAs])).toEqual([
      ['P1', 'newest'],
      ['P2', 'newest'],
    ]);
  });

  it('records a null-views release without letting it win most-viewed', async () => {
    world = {
      UU1: [
        { id: 'new', published: iso(30), views: 50 },
        { id: 'blank', published: iso(60), views: null, likes: null, comments: null },
      ],
    };
    await store([peer(1)]);
    await deliver(0);
    const { releases: kept } = await storedEvidence();
    expect(kept.map((r) => r.videoId)).toEqual(['new']);
  });

  it('gives a peer with no uploads playlist no releases', async () => {
    await store([peer(1)], {
      candidates: [{ ...candidate(1), uploadsPlaylist: null }],
    });
    await deliver(0);
    expect(reads).toEqual([]);
    expect((await storedEvidence()).releases).toEqual([]);
    expect(await storedRun()).toMatchObject({ stage: 'done' });
  });

  it('ends at once when the evidence is gone mid-run', async () => {
    const batch = await asA(async () =>
      releases({ run: await storedRun(), deadline: Date.now() + 110_000 }),
    );
    expect(batch).toEqual({ done: 1, stage: 'done', cursor: 0 });
    expect(reads).toEqual([]);
  });
});

describe('releases: batches, waits and redelivery', () => {
  it('spans several deliveries when the peers outlast one step', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Each peer takes 50 s of the 110 s step, so a delivery reads two.
    world = { UU1: [{ id: 'a' }], UU2: [{ id: 'b' }], UU3: [{ id: 'c' }] };
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).includes('playlistItems')) vi.setSystemTime(Date.now() + 50_000);
      return base(input, init);
    });
    await store([peer(1), peer(2), peer(3)]);

    await deliver(0);
    expect(await storedRun()).toMatchObject({ stage: 'releases', cursor: 2, seq: 1 });
    expect((await storedEvidence()).releases.map((r) => r.ref)).toEqual(['P1-R1', 'P2-R1']);

    await deliver(1);
    expect(await storedRun()).toMatchObject({ stage: 'done', cursor: 0, seq: 2 });
    expect((await storedEvidence()).releases.map((r) => r.ref)).toEqual([
      'P1-R1',
      'P2-R1',
      'P3-R1',
    ]);
  });

  it('keeps the peers read before a spent quota and resumes after them', async () => {
    world = { UU1: [{ id: 'a' }], UU2: [{ id: 'b' }] };
    answer({
      playlist: 'UU2',
      reply: () => json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }),
    });
    await store([peer(1), peer(2)]);

    await deliver(0);
    expect(await storedRun()).toMatchObject({
      stage: 'releases',
      cursor: 1,
      wait: 'waiting on YouTube',
      consecutiveFailures: 0,
    });
    expect((await storedEvidence()).releases.map((r) => r.ref)).toEqual(['P1-R1']);

    answer();
    await deliver(1);
    expect(await storedRun()).toMatchObject({ stage: 'done', wait: null });
    expect((await storedEvidence()).releases.map((r) => r.ref)).toEqual(['P1-R1', 'P2-R1']);
  });

  it('waits on a quota spent before the first peer without moving the cursor', async () => {
    answer({
      playlist: 'UU1',
      reply: () => json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }),
    });
    await store([peer(1)]);
    await deliver(0);
    expect(await storedRun()).toMatchObject({
      stage: 'releases',
      cursor: 0,
      wait: 'waiting on YouTube',
      consecutiveFailures: 0,
    });
  });

  it("replaces a peer's releases when its batch is read again, never adding to them", async () => {
    world = { UU1: [{ id: 'a' }] };
    const stale = {
      ref: 'P1-R1',
      peer: 'P1',
      videoId: 'stale',
      title: 'Stale',
      description: '',
      tags: [],
      hashtags: [],
      durationSec: UPLOAD_SEC,
      publishedAt: iso(30),
      stats: { views: 1, likes: 1, comments: 1 },
      selectedAs: 'newest' as const,
    };
    await store([peer(1)], { releases: [stale] });
    await deliver(0);
    expect((await storedEvidence()).releases.map((r) => r.videoId)).toEqual(['a']);
  });

  it('does not change the evidence when a finished delivery arrives again', async () => {
    world = { UU1: [{ id: 'a' }, { id: 'b', published: iso(90), views: 5000 }] };
    await store([peer(1)]);
    await deliver(0);
    const before = await storedEvidence();
    const readsBefore = reads.length;

    expect(await deliver(0)).toBe(200);

    expect(await storedEvidence()).toEqual(before);
    expect(reads).toHaveLength(readsBefore);
  });
});
