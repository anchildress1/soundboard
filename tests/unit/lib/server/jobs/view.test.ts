// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import {
  artistOutcomes,
  connections,
  jobResearch,
  jobs,
  peerRejections,
} from '#lib/server/core/schema.js';
import { createJob, listChunks, type NewJob } from '#lib/server/jobs/jobs.js';
import { authorizedJob, buildView, mediaExpired, reviewData } from '#lib/server/jobs/view.js';
import type { PeerEvidence } from '#lib/server/research/evidence.js';
import type { Chunk, JobState, Pick, Short } from '#lib/types.js';
import { seed, truncate } from '../../../../helpers/db';
import { A_JOB, jobDoc, seedJob, USER_A, USER_B, USERS } from '../../../../helpers/pipeline';

const stored = vi.hoisted(() => ({ objects: new Set<string>() }));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (object: string) => ({
          getSignedUrl: async () => [`https://storage.googleapis.com/${name}/${object}?sig=read`],
          exists: async () => [stored.objects.has(object)],
          getMetadata: async () => [{ size: '10', contentType: 'video/mp4' }],
        }),
      };
    }
  },
}));

const SHORT: Short = {
  sourceDurationSec: 180,
  reframe: 'blur',
  hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'x' },
  skipped: [],
  renders: 1,
  modelMs: 1,
};

const input = (ownerUid: string = USER_B.uid): NewJob => ({
  ownerUid,
  artistId: null,
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'peekaboo.mp4',
  contentType: 'video/mp4',
  object: null,
  trace: { sentryTrace: 't', baggage: 'b' },
});

const chunk = (index: number): Chunk => ({
  index,
  startSec: index * 29.5,
  durationSec: 29.5,
  measurements: {
    integratedLufs: -14,
    truePeakDbtp: -1,
    peakLevelDb: -1,
    clippedSamples: 0,
    silences: [],
  },
  analysis: null,
  raw: 'x',
  modelMs: 10,
});

const pick = (version: number): Pick => ({
  version,
  title: `T${version}`,
  description: 'd',
  hashtags: [],
  tags: [],
  flags: [],
  brandCheck: '',
  why: { title: '', description: '', tags: '' },
  bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
  artistName: null,
  modelMs: 1,
});

/** Stores chunks 0..`count` - 1, chunk i at index i. */
const seedChunks = (jobId: string, count: number) =>
  db()
    .update(jobs)
    .set({ chunks: Array.from({ length: count }, (_, i) => chunk(i)) })
    .where(eq(jobs.id, jobId));
/** Stores picks 1..`count`, version v at index v - 1. */
const seedPicks = (jobId: string, count: number) =>
  db()
    .update(jobs)
    .set({ picks: Array.from({ length: count }, (_, i) => ({ ...pick(i + 1), skipped: false })) })
    .where(eq(jobs.id, jobId));

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetClients();
  await truncate();
  await seed(USERS);
});

async function status(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isHttpError(error) ? error.status : -1;
  }
}

describe('authorizedJob', () => {
  it('returns the job to its owner', async () => {
    await createJob(input(USER_A.uid), 'a');
    expect((await authorizedJob('a', USER_A.uid)).ownerUid).toBe(USER_A.uid);
  });

  it("reads another user's job as missing", async () => {
    await createJob(input(USER_A.uid), 'a');
    expect(await status(authorizedJob('a', USER_B.uid))).toBe(404);
  });

  it('reads every job as missing when signed out', async () => {
    await createJob(input(USER_A.uid), 'a');
    expect(await status(authorizedJob('a', undefined))).toBe(404);
  });

  it('404s an unknown job', async () => {
    expect(await status(authorizedJob('ghost', USER_A.uid))).toBe(404);
  });
});

describe('buildView', () => {
  it('bundles the public job, its chunks, and the latest pick', async () => {
    const job = await createJob(input(), 'v');
    await seedChunks('v', 2);
    await seedPicks('v', 2);
    const view = await buildView(job);
    expect(view.job.id).toBe('v');
    expect(view.job).not.toHaveProperty('trace');
    expect(view.job).not.toHaveProperty('ownerUid');
    expect(view.chunks.map((c) => c.index)).toEqual([0, 1]);
    expect(view.pick?.version).toBe(2);
    expect(view).not.toHaveProperty('wait');
  });

  it('carries a wait reason when given one', async () => {
    const job = await createJob(input(), 'v');
    const view = await buildView(job, 'model busy');
    expect(view.wait).toBe('model busy');
    expect(view.pick).toBeNull();
    expect(view.chunks).toEqual([]);
  });

  it('names the configured analyst while windows are analyzed, the picker after', async () => {
    const job = await createJob(input(), 'v');
    expect((await buildView({ ...job, state: 'ANALYZE' })).model).toBe('gemini-3.8-flash');
    expect((await buildView({ ...job, state: 'REVIEW' })).model).toBe('gemini-4-argon');
    const failed = { ...job, state: 'FAILED' as const };
    expect((await buildView({ ...failed, failedState: 'PREP' })).model).toBe('gemini-3.8-flash');
    expect((await buildView({ ...failed, failedState: 'PICK' })).model).toBe('gemini-4-argon');
    expect((await buildView({ ...job, state: 'HOOK', short: SHORT })).model).toBe('gemini-4-argon');
  });

  it('reads the model config on every view, even for an earlier result', async () => {
    const job = await createJob(input(), 'v');
    await seedPicks('v', 1);
    const done = { ...job, state: 'REVIEW' as const };
    vi.stubEnv('GEMINI_PICK_MODEL', 'gemini-4-argon-next');
    expect((await buildView(done)).model).toBe('gemini-4-argon-next');
    vi.stubEnv('GEMINI_PICK_MODEL', undefined);
    expect((await buildView(done)).model).toBe('gemini-4-argon');
  });

  it('reads only the job it was given', async () => {
    const job = await createJob(input(), 'v');
    await createJob(input(), 'other');
    await seedChunks('other', 1);
    expect((await buildView(job)).chunks).toEqual([]);
    expect(await listChunks('other')).toHaveLength(1);
  });
});

describe('buildView for a Short', () => {
  it.each(['REVIEW', 'PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED'] as JobState[])(
    'signs playback of the rendered object in %s',
    async (state) => {
      stored.objects.add('uploads/s-1');
      const job = await createJob(input(), 's');
      const view = await buildView({ ...job, state, object: 'uploads/s-1', short: SHORT });
      expect(view.playbackUrl).toBe('https://storage.googleapis.com/bkt/uploads/s-1?sig=read');
    },
  );

  it('signs no playback once storage dropped the render', async () => {
    stored.objects.clear();
    const job = await createJob(input(), 's');
    const view = await buildView({ ...job, state: 'REVIEW', object: 'uploads/s-1', short: SHORT });
    expect(view).not.toHaveProperty('playbackUrl');
  });

  it.each(['HOOK', 'RENDER', 'FAILED'] as JobState[])(
    'leaves playback out while the Short is %s',
    async (state) => {
      const job = await createJob(input(), 's');
      expect(await buildView({ ...job, state, short: SHORT })).not.toHaveProperty('playbackUrl');
    },
  );

  it('leaves playback out before the first render', async () => {
    const job = await createJob(input(), 's');
    const view = await buildView({ ...job, state: 'REVIEW', short: { ...SHORT, renders: 0 } });
    expect(view).not.toHaveProperty('playbackUrl');
  });

  it('never signs playback for a video job', async () => {
    const job = await createJob(input(), 'v');
    expect(await buildView({ ...job, state: 'REVIEW' })).not.toHaveProperty('playbackUrl');
  });
});

describe('mediaExpired', () => {
  beforeEach(() => stored.objects.clear());

  it.each(['PREP', 'ANALYZE', 'PICK', 'HOOK', 'RENDER', 'REVIEW', 'PUBLISHING'] as JobState[])(
    'is true in %s once the object is gone',
    async (state) => {
      expect(await mediaExpired(jobDoc({ state }))).toBe(true);
    },
  );

  it.each([
    ['the step it failed at needs media', 'ANALYZE', true],
    ['it failed uploading', 'PUBLISHING', true],
    ['no failed state was recorded, so retry starts at PREP', null, true],
    ['it failed verifying, which needs no media', 'CLAIMED_COMPLETE', false],
  ] as const)('is %s for a FAILED job when %s', async (_label, failedState, expired) => {
    expect(await mediaExpired(jobDoc({ state: 'FAILED', failedState }))).toBe(expired);
  });

  it.each(['HOOK', 'RENDER'] as JobState[])(
    "checks a Short's source video in %s, not its render",
    async (state) => {
      const short = jobDoc({
        state,
        short: SHORT,
        object: 'uploads/s-1',
        sourceObject: 'uploads/v',
      });
      stored.objects.add('uploads/s-1');
      expect(await mediaExpired(short)).toBe(true);
      stored.objects.add('uploads/v');
      stored.objects.delete('uploads/s-1');
      expect(await mediaExpired(short)).toBe(false);
    },
  );

  it.each(['REVIEW', 'PUBLISHING'] as JobState[])(
    "checks a Short's render in %s, not its source video",
    async (state) => {
      const short = jobDoc({
        state,
        short: SHORT,
        object: 'uploads/s-1',
        sourceObject: 'uploads/v',
      });
      stored.objects.add('uploads/v');
      expect(await mediaExpired(short)).toBe(true);
      stored.objects.add('uploads/s-1');
      expect(await mediaExpired(short)).toBe(false);
    },
  );

  it('checks a failed Short against the step it failed at', async () => {
    const short = jobDoc({
      state: 'FAILED',
      failedState: 'RENDER',
      short: SHORT,
      object: 'uploads/s-1',
      sourceObject: 'uploads/v',
    });
    stored.objects.add('uploads/s-1');
    expect(await mediaExpired(short)).toBe(true);
  });

  it('is false while the object is still stored', async () => {
    stored.objects.add('uploads/j1');
    expect(await mediaExpired(jobDoc({ state: 'REVIEW' }))).toBe(false);
  });

  it.each(['AWAITING_UPLOAD', 'CLAIMED_COMPLETE', 'VERIFIED', 'DISCARDED'] as JobState[])(
    'is false in %s, whose remaining work needs no media',
    async (state) => {
      expect(await mediaExpired(jobDoc({ state }))).toBe(false);
    },
  );
});

describe('reviewData', () => {
  const asA = <T>(operation: () => Promise<T>) => withIdentity(USER_A.uid, operation);
  const DAY = 24 * 60 * 60_000;
  const EXPIRES = '2026-11-20T00:00:00.000Z';
  const ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';

  const peer = (n: number, patch: Partial<PeerEvidence['peers'][number]> = {}) => ({
    ref: `P${n}`,
    channelId: `UC${n}`,
    title: `Peer ${n}`,
    basis: 'heard' as const,
    explanation: 'Same synth palette.',
    stats: { subscribers: 1200, hidden: false, videos: 40, views: 90_000 },
    bracket: 1000 as const,
    relation: 'next' as const,
    secondary: false,
    ...patch,
  });
  const release = (ref: string, peerRef: string, title: string) => ({
    ref,
    peer: peerRef,
    videoId: `v-${ref}`,
    title,
    description: '',
    tags: [],
    hashtags: [],
    durationSec: 200,
    publishedAt: '2026-08-01T00:00:00.000Z',
    stats: { views: 1000, likes: 50, comments: 50 },
    selectedAs: 'newest' as const,
  });
  const evidence = (patch: Partial<PeerEvidence> = {}): PeerEvidence => ({
    query: 'synthwave music',
    artist: { stats: null, bracket: 100 },
    candidates: [],
    peers: [peer(1), peer(2, { stats: { subscribers: null, hidden: true, videos: 3, views: 4 } })],
    releases: [release('P1-R1', 'P1', 'Night Drive'), release('P2-R1', 'P2', 'Other Song')],
    skipped: [],
    ...patch,
  });
  const cited = {
    sound: ['analysis', 'P1'],
    feel: ['voice'],
    wording: ['P1-R1', 'edits'],
    discovery: ['G1', 'P1-R1'],
    structure: ['P2-R1'],
  };
  const stored = (patch: Record<string, unknown> = {}): Pick => ({
    ...pick(1),
    influence: { sound: 1, feel: 0, wording: 0, discovery: 4, structure: 4 },
    citations: cited,
    recommendation: {
      approach: 'Try a shorter intro.',
      intendedOutcome: 'More listeners finish the first minute.',
      follows: 'peers',
      followsWhy: 'Two peers open fast.',
      evidence: ['P1', 'P9'],
      limits: ['no-peers'],
    },
    influenceWarning: null,
    researchRunId: 'run-1',
    evidenceExpiresAt: EXPIRES,
    outcomeRefs: {},
    ...patch,
  });

  beforeEach(async () => {
    await seedJob({ ...A_JOB, id: 'j1', state: 'REVIEW' });
  });

  const saveEvidence = (body: PeerEvidence = evidence(), runId = 'run-1', ageDays = 1) =>
    db()
      .insert(jobResearch)
      .values({
        runId,
        jobId: 'j1',
        retrievedAt: new Date(Date.now() - ageDays * DAY),
        evidence: body,
      });

  it('is null without a pick, and for a pick made before fanbase learning', async () => {
    expect(await asA(() => reviewData(null))).toBeNull();
    expect(await asA(() => reviewData(pick(1)))).toBeNull();
  });

  it("shows the pick's peers in selection order, each with its own releases", async () => {
    await saveEvidence();
    const data = await asA(() => reviewData(stored()));
    expect(data?.peers?.map((p) => p.ref)).toEqual(['P1', 'P2']);
    expect(data?.peers?.[0]).toMatchObject({
      title: 'Peer 1',
      basis: 'heard',
      stats: { subscribers: 1200, videos: 40, views: 90_000 },
      releases: [
        {
          ref: 'P1-R1',
          url: 'https://www.youtube.com/watch?v=v-P1-R1',
          engagement: { value: 0.1, calculated: true },
        },
      ],
    });
    expect(data?.peers?.[1]?.releases.map((r) => r.ref)).toEqual(['P2-R1']);
  });

  it('shows a hidden subscriber count as hidden', async () => {
    await saveEvidence();
    const data = await asA(() => reviewData(stored()));
    expect(data?.peers?.[1]?.stats.subscribers).toBe('hidden');
  });

  it('totals nothing across peers', async () => {
    await saveEvidence();
    const data = await asA(() => reviewData(stored()));
    expect(Object.keys(data ?? {}).sort()).toEqual([
      'evidence',
      'evidenceExpiresAt',
      'influence',
      'influenceWarning',
      'limits',
      'peers',
      'ranges',
      'recommendation',
      'results',
      'sources',
      'version',
    ]);
  });

  it("gives the artist's range and the next one up", async () => {
    await saveEvidence();
    expect((await asA(() => reviewData(stored())))?.ranges).toEqual({ current: 100, target: 1000 });
  });

  it("has no ranges when the artist's count is hidden", async () => {
    await saveEvidence(evidence({ artist: { stats: null, bracket: null } }));
    expect((await asA(() => reviewData(stored())))?.ranges).toBeNull();
  });

  it('resolves each field’s sources from the roles that shape it', async () => {
    await saveEvidence();
    const data = await asA(() => reviewData(stored()));
    expect(data?.sources.title.map((c) => c.ref)).toEqual(['P1-R1', 'edits', 'voice', 'P2-R1']);
    expect(data?.sources.title).toContainEqual({ ref: 'P1-R1', label: 'P1-R1 · Night Drive' });
    expect(data?.sources.title).toContainEqual({ ref: 'edits', label: 'Your past edits' });
    expect(data?.sources.tags).toEqual([
      { ref: 'G1', label: 'Genre search G1' },
      { ref: 'P1-R1', label: 'P1-R1 · Night Drive' },
      { ref: 'analysis', label: 'Song analysis' },
      { ref: 'P1', label: 'P1 · Peer 1' },
    ]);
  });

  it('resolves the recommendation’s evidence, an unknown peer ref as expired', async () => {
    await saveEvidence();
    const data = await asA(() => reviewData(stored()));
    expect(data?.evidence).toEqual([
      { ref: 'P1', label: 'P1 · Peer 1' },
      { ref: 'P9', expired: true, kind: 'peer', expiresAt: EXPIRES },
    ]);
  });

  it('keeps the recommendation, influence and warning as stored', async () => {
    await saveEvidence();
    const data = await asA(() =>
      reviewData(stored({ influenceWarning: 'Influence settings not met' })),
    );
    expect(data).toMatchObject({
      recommendation: { approach: 'Try a shorter intro.', limits: ['no-peers'] },
      influence: { wording: 0, structure: 4 },
      influenceWarning: 'Influence settings not met',
      evidenceExpiresAt: EXPIRES,
    });
  });

  it('has a null recommendation when the pick has none', async () => {
    await saveEvidence();
    const data = await asA(() => reviewData(stored({ recommendation: null })));
    expect(data).toMatchObject({ recommendation: null, evidence: [] });
  });

  it('carries the pick’s limits, which say why there is no recommendation', async () => {
    await saveEvidence();
    const data = await asA(() =>
      reviewData(
        stored({ recommendation: null, limits: ['analytics-not-shared', 'secondary-only'] }),
      ),
    );
    expect(data?.limits).toEqual(['analytics-not-shared', 'secondary-only']);
  });

  it('reads expired evidence as expired, with the date the pick recorded', async () => {
    await saveEvidence(evidence(), 'run-1', 29);
    const data = await asA(() => reviewData(stored()));
    expect(data?.peers).toBeNull();
    expect(data?.ranges).toBeNull();
    expect(data?.sources.tags).toContainEqual({
      ref: 'P1',
      expired: true,
      kind: 'peer',
      expiresAt: EXPIRES,
    });
  });

  it('reads a pick with no run as having no peers', async () => {
    const data = await asA(() => reviewData(stored({ researchRunId: null })));
    expect(data?.peers).toBeNull();
  });

  it("resolves an old pick against its own run, not a newer run's", async () => {
    await saveEvidence(evidence(), 'run-old');
    await saveEvidence(evidence({ peers: [peer(1, { title: 'New Peer' })] }), 'run-new');
    const data = await asA(() => reviewData(stored({ researchRunId: 'run-old' })));
    expect(data?.peers?.[0]?.title).toBe('Peer 1');
  });

  it("leaves out a channel the artist marked 'Not a peer', with its releases", async () => {
    await saveEvidence();
    await db()
      .insert(peerRejections)
      .values({ artistId: USER_A.artistId, channelId: 'UC1', retrievedAt: new Date() });
    const data = await asA(() => reviewData(stored()));
    expect(data?.peers?.map((p) => p.ref)).toEqual(['P2']);
    expect(data?.sources.title.map((c) => c.ref)).toContain('P2-R1');
    expect(data?.sources.tags).toContainEqual(
      expect.objectContaining({ ref: 'P1', expired: true }),
    );
  });

  describe('the artist’s own results', () => {
    const row = {
      artistId: USER_A.artistId,
      videoId: 'vid-1',
      retrievedAt: new Date(),
      publishedAt: new Date('2026-09-01T00:00:00Z'),
      requestedStart: '2026-08-31',
      requestedEnd: '2026-09-27',
      coverage: 'open' as const,
      metrics: { views: 900, subscribersGained: 12, subscribersLost: 2 },
      live: { title: 'Live title', description: '', tags: [] },
      differsFromApproved: null,
    };
    const withResult = stored({
      outcomeRefs: { A1: 'vid-1' },
      citations: { ...cited, feel: ['A1'] },
    });

    const share = () =>
      db()
        .update(connections)
        .set({ scopes: ['openid', 'email', ANALYTICS] })
        .where(eq(connections.uid, USER_A.uid));

    it('shows a fresh, shared result with its calculated net', async () => {
      await saveEvidence();
      await db().insert(artistOutcomes).values(row);
      await share();
      const data = await asA(() => reviewData(withResult));
      expect(data?.results).toEqual([
        {
          ref: 'A1',
          title: 'Live title',
          requested: { start: '2026-08-31', end: '2026-09-27' },
          coverage: 'open',
          metrics: row.metrics,
          net: { value: 10, calculated: true },
        },
      ]);
      expect(data?.sources.title).toContainEqual({ ref: 'A1', label: 'Your result: Live title' });
    });

    it('keeps an unknown metric unknown, never zero', async () => {
      await saveEvidence();
      await db()
        .insert(artistOutcomes)
        .values({ ...row, metrics: { views: null, subscribersGained: null, subscribersLost: 2 } });
      await share();
      const data = await asA(() => reviewData(withResult));
      expect(data?.results[0]).toMatchObject({
        metrics: { views: null },
        net: { value: null, calculated: true },
      });
    });

    it('reads a result as no longer stored once sharing stopped', async () => {
      await saveEvidence();
      await db().insert(artistOutcomes).values(row);
      const data = await asA(() => reviewData(withResult));
      expect(data?.results).toEqual([]);
      expect(data?.sources.title).toContainEqual({
        ref: 'A1',
        expired: true,
        kind: 'result',
        expiresAt: null,
      });
    });

    it('reads a deleted or expired result as no longer stored', async () => {
      await saveEvidence();
      await share();
      const data = await asA(() => reviewData(withResult));
      expect(data?.results).toEqual([]);
      await db()
        .insert(artistOutcomes)
        .values({ ...row, retrievedAt: new Date(Date.now() - 29 * DAY) });
      expect((await asA(() => reviewData(withResult)))?.results).toEqual([]);
    });
  });
});
