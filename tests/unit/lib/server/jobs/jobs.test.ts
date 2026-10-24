// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/core/db';
import { jobs } from '$lib/server/core/schema';
import {
  claimJob,
  createJob,
  createShort,
  fail,
  getJob,
  latestPick,
  listChunks,
  listJobs,
  listPicks,
  newJobDoc,
  newJobId,
  ok,
  outcomeUnknown,
  releaseJob,
  skipAndRepick,
  toPublic,
  transitionJob,
  type JobDoc,
  type NewJob,
} from '$lib/server/jobs/jobs';
import { jobSet, type JobPatch } from '$lib/server/jobs/rows';
import { saveAudience } from '$lib/server/jobs/audience';
import { SHORT_SOURCE_STATES, type Chunk, type Pick } from '$lib/types';
import { seed, truncate } from '../../../../helpers/db';
import { jobDoc, SESSION_URI, seedJob, USER_A, USER_B, USERS } from '../../../../helpers/pipeline';

const SOURCE_OBJECT = 'uploads/source.mp4';
const REFUSES_MISSING = 'refuses a missing job';
const SYNTHWAVE = '#synthwave';

const input: NewJob = {
  ownerUid: USER_B.uid,
  artistId: null,
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'peekaboo.mp4',
  contentType: 'video/mp4',
  object: null,
  trace: { sentryTrace: 't-s-1', baggage: 'b' },
};

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
  modelMs: 1,
});

const patch = (id: string, fields: JobPatch) =>
  db().transaction(async (tx) => {
    await tx.update(jobs).set(jobSet(fields)).where(eq(jobs.id, id));
    if (fields.audience) await saveAudience(tx, id, fields.audience);
  });
/** Stores picks 1..`count`, version v at index v - 1. */
const seedPicks = (jobId: string, count: number) =>
  db()
    .update(jobs)
    .set({ picks: Array.from({ length: count }, (_, i) => ({ ...pick(i + 1), skipped: false })) })
    .where(eq(jobs.id, jobId));
const claimRow = async (id: string) =>
  (
    await db()
      .select({ token: jobs.claimToken, until: jobs.claimUntil })
      .from(jobs)
      .where(eq(jobs.id, id))
  )[0]!;
/** Ages the claim past its 3 minutes, as if the step that holds it hung. */
const expireClaim = (id: string) =>
  db()
    .update(jobs)
    .set({ claimUntil: sql`now() - interval '1 second'` })
    .where(eq(jobs.id, id));
const exists = async (id: string) => (await getJob(id)) !== null;

beforeEach(async () => {
  await truncate();
  await seed(USERS);
});

describe('listJobs', () => {
  const at = (minute: number) => Date.UTC(2026, 9, 1, 12, minute);

  it("lists the user's own root jobs, newest first, with only the list fields", async () => {
    await seedJob({ id: 'old', songTitle: 'Old', state: 'VERIFIED', createdAt: at(1) });
    await seedJob({ id: 'new', songTitle: 'New', state: 'REVIEW', createdAt: at(2) });
    expect(await listJobs(USER_B.uid)).toEqual([
      { id: 'new', songTitle: 'New', state: 'REVIEW', createdAt: at(2) },
      { id: 'old', songTitle: 'Old', state: 'VERIFIED', createdAt: at(1) },
    ]);
  });

  it("leaves out other users' jobs and Shorts", async () => {
    await seedJob({ id: 'mine', createdAt: at(1) });
    await seedJob({ id: 'short', parentId: 'mine', createdAt: at(2) });
    await seedJob({ id: 'theirs', ownerUid: USER_A.uid, artistId: 'flr', createdAt: at(3) });
    expect((await listJobs(USER_B.uid)).map((j) => j.id)).toEqual(['mine']);
    expect((await listJobs(USER_A.uid)).map((j) => j.id)).toEqual(['theirs']);
  });

  it('keeps the newest 20', async () => {
    for (let i = 0; i < 22; i++) await seedJob({ id: `j${i}`, createdAt: at(i) });
    const listed = await listJobs(USER_B.uid);
    expect(listed).toHaveLength(20);
    expect([listed[0]!.id, listed.at(-1)!.id]).toEqual(['j21', 'j2']);
  });

  it('is empty for a user with no jobs or no account', async () => {
    expect(await listJobs(USER_B.uid)).toEqual([]);
    expect(await listJobs('ghost')).toEqual([]);
  });
});

describe('newJobId', () => {
  it('is 128 random bits in base64url', () => {
    const id = newJobId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newJobId()).not.toBe(id);
  });
});

describe('createJob / getJob', () => {
  const rawInsert = (id: string, state: string) =>
    db().execute(
      sql`insert into jobs (id, owner_uid, state, created_at, data) values (${id}, ${USER_A.uid}, ${state}, now(), '{}')`,
    );

  it('stores only known states', async () => {
    await rawInsert('ok', 'PREP');
    await expect(rawInsert('bogus', 'BOGUS')).rejects.toMatchObject({
      cause: { message: expect.stringContaining('jobs_state_check') },
    });
    expect(await getJob('bogus')).toBeNull();
  });

  it('waits for the browser upload when no object exists yet', async () => {
    const job = await createJob(input, 'job1');
    expect(job.state).toBe('AWAITING_UPLOAD');
    expect(job.object).toBe('uploads/job1');
    expect(await getJob('job1')).toEqual(job);
  });

  it('starts at PREP when the object already sits in the bucket', async () => {
    const job = await createJob({ ...input, object: SOURCE_OBJECT }, 'job2');
    expect(job.state).toBe('PREP');
    expect(job.object).toBe(SOURCE_OBJECT);
  });

  it('stores the owner, artist, destination and upload markers as columns', async () => {
    await seedJob({
      id: 'j',
      ownerUid: USER_A.uid,
      artistId: 'flr',
      destination: { channelId: 'UCflr', channelTitle: 'Flies Like Robots' },
      uploadStartedAt: 5,
      finalChunkAt: 6,
      videoId: 'vid1',
    });
    const [row] = await db().select().from(jobs).where(eq(jobs.id, 'j'));
    expect(row).toMatchObject({
      ownerUid: USER_A.uid,
      artistId: 'flr',
      parentId: null,
      destinationChannelId: 'UCflr',
      destinationChannelTitle: 'Flies Like Robots',
      uploadStartedAt: new Date(5),
      finalChunkAt: new Date(6),
      videoId: 'vid1',
    });
    expect(row!.data).not.toHaveProperty('ownerUid');
    expect(await getJob('j')).toMatchObject({
      destination: { channelId: 'UCflr', channelTitle: 'Flies Like Robots' },
      uploadStartedAt: 5,
      finalChunkAt: 6,
    });
  });

  it('refuses a job whose owner is not a user', async () => {
    await expect(createJob({ ...input, ownerUid: 'nobody' }, 'j')).rejects.toThrow();
  });

  it('returns null for a missing job', async () => {
    expect(await getJob('nope')).toBeNull();
  });
});

describe('claimJob / releaseJob', () => {
  it('hands out one claim at a time, with a fresh random token, for 3 minutes', async () => {
    await createJob(input, 'j');
    const claimed = await claimJob('j');
    expect(claimed?.token).toMatch(/^[0-9a-f]{32}$/);
    expect(await claimJob('j')).toBeNull();
    const { until } = await claimRow('j');
    expect(until!.getTime() - Date.now()).toBeGreaterThan(2.9 * 60 * 1000);
    expect(until!.getTime() - Date.now()).toBeLessThanOrEqual(3 * 60 * 1000);
  });

  it('frees the job once the claim lapses, with a new token', async () => {
    await createJob(input, 'j');
    const first = await claimJob('j');
    await expireClaim('j');
    const second = await claimJob('j');
    expect(second?.token).toBeTruthy();
    expect(second?.token).not.toBe(first?.token);
  });

  it('returns null for a missing job', async () => {
    expect(await claimJob('ghost')).toBeNull();
  });

  it('returns the job as the claim left it', async () => {
    await createJob({ ...input, object: SOURCE_OBJECT }, 'j');
    const claimed = await claimJob('j');
    expect(claimed?.job.state).toBe('PREP');
    expect(claimed?.job).not.toHaveProperty('claimToken');
  });

  it('applies the patch and output and clears the claim for the holder', async () => {
    await createJob(input, 'j');
    const { token } = (await claimJob('j'))!;
    const released = await releaseJob(
      'j',
      token,
      'AWAITING_UPLOAD',
      { state: 'PICK', chunkIndex: 1 },
      { pick: pick(1), chunk: chunk(0) },
    );
    expect(released).toBe(true);
    expect(await getJob('j')).toMatchObject({ state: 'PICK', chunkIndex: 1 });
    expect(await claimRow('j')).toEqual({ token: null, until: null });
    expect(await listPicks('j')).toEqual([{ ...pick(1), skipped: false }]);
    expect(await listChunks('j')).toEqual([chunk(0)]);
  });

  it('overwrites a retried chunk and pick instead of adding another', async () => {
    await createJob(input, 'j');
    const first = (await claimJob('j'))!;
    await releaseJob('j', first.token, 'AWAITING_UPLOAD', {}, { pick: pick(1), chunk: chunk(0) });
    const retry = (await claimJob('j'))!;
    const redone = { ...chunk(0), summary: 'redone' };
    await releaseJob(
      'j',
      retry.token,
      'AWAITING_UPLOAD',
      {},
      {
        pick: { ...pick(1), title: 'Redone' },
        chunk: redone,
      },
    );
    expect(await listChunks('j')).toEqual([redone]);
    expect(await listPicks('j')).toEqual([{ ...pick(1), title: 'Redone', skipped: false }]);
  });

  it('refuses a chunk or pick that would leave a gap, saving nothing', async () => {
    await createJob(input, 'j');
    const { token } = (await claimJob('j'))!;
    await expect(
      releaseJob('j', token, 'AWAITING_UPLOAD', { state: 'PICK' }, { chunk: chunk(1) }),
    ).rejects.toThrow('No chunks slot 1 on job j');
    await expect(
      releaseJob('j', token, 'AWAITING_UPLOAD', { state: 'PICK' }, { pick: pick(2) }),
    ).rejects.toThrow('No picks slot 1 on job j');
    expect((await getJob('j'))?.state).toBe('AWAITING_UPLOAD');
    expect(await listChunks('j')).toEqual([]);
    expect(await listPicks('j')).toEqual([]);
  });

  it('drops the patch but frees the job when an action moved it during the step', async () => {
    await createJob(input, 'j');
    const { token } = (await claimJob('j'))!;
    await patch('j', { state: 'DISCARDED' });
    expect(
      await releaseJob('j', token, 'AWAITING_UPLOAD', { state: 'PICK' }, { pick: pick(1) }),
    ).toBe(false);
    expect((await getJob('j'))?.state).toBe('DISCARDED');
    expect(await claimRow('j')).toEqual({ token: null, until: null });
    expect(await listPicks('j')).toEqual([]);
  });

  it('keeps the video ID and upload progress from a step that outlived a discard', async () => {
    await createJob(input, 'j');
    await patch('j', { state: 'PUBLISHING', notes: 'kept' });
    const { token } = (await claimJob('j'))!;
    await patch('j', { state: 'DISCARDED', notes: 'newer' });
    const upload = { sessionUri: 'https://upload.example/s1', total: 10 };
    const released = await releaseJob('j', token, 'PUBLISHING', {
      state: 'CLAIMED_COMPLETE',
      videoId: 'vid1',
      upload,
      uploadProgress: { sent: 10, total: 10 },
      notes: 'step',
      consecutiveFailures: 0,
    });
    expect(released).toBe(false);
    expect(await getJob('j')).toMatchObject({
      state: 'DISCARDED',
      videoId: 'vid1',
      upload,
      uploadProgress: { sent: 10, total: 10 },
      notes: 'newer',
    });
    expect(await claimRow('j')).toEqual({ token: null, until: null });
  });

  it('never replaces a saved video ID from a step that outlived a discard', async () => {
    await createJob(input, 'j');
    await patch('j', { state: 'CLAIMED_COMPLETE', videoId: 'first' });
    const { token } = (await claimJob('j'))!;
    await patch('j', { state: 'DISCARDED' });
    await releaseJob('j', token, 'CLAIMED_COMPLETE', { videoId: 'second' });
    expect(await getJob('j')).toMatchObject({ state: 'DISCARDED', videoId: 'first' });
  });

  it('lets a superseded token save no video ID after a discard', async () => {
    await createJob(input, 'j');
    await patch('j', { state: 'PUBLISHING' });
    const a = (await claimJob('j'))!;
    await expireClaim('j');
    const b = (await claimJob('j'))!;
    await patch('j', { state: 'DISCARDED' });
    expect(await releaseJob('j', a.token, 'PUBLISHING', { videoId: 'late' })).toBe(false);
    expect(await getJob('j')).toMatchObject({ state: 'DISCARDED', videoId: null });
    expect((await claimRow('j')).token).toBe(b.token);
  });

  it('refuses a stale token and leaves the live claim alone', async () => {
    await createJob(input, 'j');
    const { token } = (await claimJob('j'))!;
    expect(await releaseJob('j', 'stale', 'AWAITING_UPLOAD', { state: 'PICK' })).toBe(false);
    expect((await getJob('j'))?.state).toBe('AWAITING_UPLOAD');
    expect((await claimRow('j')).token).toBe(token);
  });

  it('lets a late step neither write nor clear the claim that replaced its own', async () => {
    await createJob({ ...input, object: SOURCE_OBJECT }, 'j');
    const a = (await claimJob('j'))!;
    await expireClaim('j');
    const b = (await claimJob('j'))!;

    const late = await releaseJob(
      'j',
      a.token,
      'PREP',
      { state: 'ANALYZE', chunkCount: 9 },
      { pick: pick(1), chunk: chunk(0) },
    );
    expect(late).toBe(false);
    expect(await getJob('j')).toMatchObject({ state: 'PREP', chunkCount: 0 });
    expect((await claimRow('j')).token).toBe(b.token);
    expect(await listPicks('j')).toEqual([]);
    expect(await listChunks('j')).toEqual([]);

    expect(await releaseJob('j', b.token, 'PREP', { state: 'ANALYZE', chunkCount: 2 })).toBe(true);
    expect(await getJob('j')).toMatchObject({ state: 'ANALYZE', chunkCount: 2 });
    expect(await claimRow('j')).toEqual({ token: null, until: null });
  });

  it(REFUSES_MISSING, async () => {
    expect(await releaseJob('ghost', 't', 'PREP')).toBe(false);
  });
});

describe('transitionJob', () => {
  it('moves the job only from an allowed state, keeping data it does not name', async () => {
    await createJob(input, 'j');
    expect(await transitionJob('j', ['REVIEW'], { state: 'DISCARDED' })).toBe(false);
    expect(await transitionJob('j', ['AWAITING_UPLOAD'], { state: 'PREP', error: 'x' })).toBe(true);
    expect(await getJob('j')).toMatchObject({ state: 'PREP', error: 'x', songTitle: 'PeekaBoo' });
  });

  it('bumps updatedAt', async () => {
    const job = await createJob(input, 'j');
    await new Promise((r) => setTimeout(r, 2));
    await transitionJob('j', ['AWAITING_UPLOAD'], { state: 'PREP' });
    expect((await getJob('j'))!.updatedAt).toBeGreaterThan(job.updatedAt);
  });

  it(REFUSES_MISSING, async () => {
    expect(await transitionJob('ghost', ['PREP'], { state: 'ANALYZE' })).toBe(false);
  });
});

describe('chunks and picks', () => {
  it('lists chunks in index order', async () => {
    await createJob(input, 'j');
    await db()
      .update(jobs)
      .set({ chunks: [0, 1, 2].map(chunk) })
      .where(eq(jobs.id, 'j'));
    expect((await listChunks('j')).map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('tracks pick versions and skips', async () => {
    await createJob(input, 'j');
    await patch('j', { state: 'REVIEW' });
    expect(await latestPick('j')).toBeNull();
    await seedPicks('j', 3);
    expect(await skipAndRepick('j', 3)).toBe(true);
    expect((await getJob('j'))?.state).toBe('PICK');
    expect(await skipAndRepick('j', 2)).toBe(false);
    const picks = await listPicks('j');
    expect(picks.map((p) => [p.version, p.skipped])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect((await latestPick('j'))?.version).toBe(3);
  });
});

describe('skipAndRepick', () => {
  it('queues a pick with nothing to skip', async () => {
    await createJob(input, 'j');
    await patch('j', { state: 'REVIEW', error: 'old' });
    expect(await skipAndRepick('j', null)).toBe(true);
    expect(await getJob('j')).toMatchObject({ state: 'PICK', error: null });
  });

  it('runs the extra write in the same transaction and rolls back with it', async () => {
    await createJob(input, 'j');
    await patch('j', { state: 'REVIEW' });
    await seedPicks('j', 1);
    const boom = skipAndRepick('j', 1, async () => {
      throw new Error('boom');
    });
    await expect(boom).rejects.toThrow('boom');
    expect((await getJob('j'))?.state).toBe('REVIEW');
    expect((await listPicks('j'))[0]!.skipped).toBe(false);
  });

  it(REFUSES_MISSING, async () => {
    expect(await skipAndRepick('ghost', 1)).toBe(false);
  });
});

describe('newJobDoc', () => {
  it('builds a video job with no parent, Short, destination or upload markers', () => {
    const doc = newJobDoc(input, 'j', 5);
    expect(doc).toMatchObject({
      id: 'j',
      state: 'AWAITING_UPLOAD',
      ownerUid: USER_B.uid,
      artistId: null,
      parentId: null,
      destination: null,
      object: 'uploads/j',
      shortId: null,
      short: null,
      sourceObject: null,
      uploadStartedAt: null,
      finalChunkAt: null,
      limitUntil: null,
      createdAt: 5,
      updatedAt: 5,
    });
  });
});

describe('createShort', () => {
  async function parent(fields: JobPatch = {}) {
    await createJob(
      { ...input, ownerUid: USER_A.uid, artistId: 'flr', object: SOURCE_OBJECT },
      'p',
    );
    await patch('p', {
      state: 'VERIFIED',
      probe: { durationSec: 180, width: 1920, height: 1080, hasAudio: true },
      hashtagCandidates: [SYNTHWAVE],
      audience: {
        retrievedAt: Date.now(),
        query: 'q',
        candidateLists: [
          {
            videoId: 'peer',
            title: 'Peer release',
            hashtags: [SYNTHWAVE],
            tags: [{ tag: 'synthwave' }],
          },
        ],
        top: [],
      },
      pickVersion: 3,
      ...fields,
    });
    await seedPicks('p', 3);
    return (await getJob('p'))!;
  }

  it('creates a HOOK job carrying the pick on screen, candidates, trace, owner and parent', async () => {
    await parent();
    // The parent's pinned channel stays with the parent; the Short pins its own on approval.
    await db()
      .update(jobs)
      .set({ destinationChannelId: 'UCflr', destinationChannelTitle: 'FLR' })
      .where(eq(jobs.id, 'p'));
    const job = (await getJob('p'))!;
    expect(job.destination).toEqual({ channelId: 'UCflr', channelTitle: 'FLR' });
    expect(await createShort(job, SHORT_SOURCE_STATES, 's1')).toEqual({ id: 's1' });
    const short = (await getJob('s1'))!;
    expect(short.audience?.retrievedAt).toBe(job.audience?.retrievedAt);
    expect(short).toMatchObject({
      state: 'HOOK',
      ownerUid: USER_A.uid,
      artistId: 'flr',
      parentId: 'p',
      destination: null,
      songTitle: 'PeekaBoo',
      filename: 'peekaboo (Short).mp4',
      contentType: 'video/mp4',
      object: 'uploads/s1',
      sourceObject: SOURCE_OBJECT,
      hashtagCandidates: [SYNTHWAVE],
      audience: { candidateLists: [{ videoId: 'peer', tags: [{ tag: 'synthwave' }] }] },
      pickVersion: 1,
      trace: { sentryTrace: 't-s-1', baggage: 'b' },
      shortId: null,
      short: {
        sourceDurationSec: 180,
        reframe: 'blur',
        hook: null,
        skipped: [],
        renders: 0,
        modelMs: 0,
      },
    });
    expect(await listPicks('s1')).toEqual([{ ...pick(3), version: 1, skipped: false }]);
    expect((await getJob('p'))!.shortId).toBe('s1');
  });

  it('returns the live Short instead of starting a second one', async () => {
    const job = await parent();
    await createShort(job, SHORT_SOURCE_STATES, 's1');
    expect(await createShort(job, SHORT_SOURCE_STATES, 's2')).toEqual({ id: 's1' });
    expect(await exists('s2')).toBe(false);
  });

  it('starts a new Short once the old one was discarded', async () => {
    const job = await parent();
    await createShort(job, SHORT_SOURCE_STATES, 's1');
    await patch('s1', { state: 'DISCARDED' });
    expect(await createShort(job, SHORT_SOURCE_STATES, 's2')).toEqual({ id: 's2' });
    expect((await getJob('p'))!.shortId).toBe('s2');
  });

  it('starts a new Short when the recorded one is gone', async () => {
    const job = await parent({ shortId: 'vanished' });
    expect(await createShort(job, SHORT_SOURCE_STATES, 's3')).toEqual({ id: 's3' });
  });

  it('refuses a parent outside the allowed states, or missing', async () => {
    const job = await parent({ state: 'DISCARDED' });
    expect(await createShort(job, SHORT_SOURCE_STATES, 's1')).toBeNull();
    expect(await exists('s1')).toBe(false);
    expect(await createShort({ ...job, id: 'ghost' }, SHORT_SOURCE_STATES)).toBeNull();
    // A video still in review has nothing approved to cut from.
    await patch('p', { state: 'REVIEW' });
    expect(await createShort(job, SHORT_SOURCE_STATES, 's1')).toBeNull();
  });

  it('starts from the approved fields over the pick, as read inside the transaction', async () => {
    const stale = await parent({ state: 'PUBLISHING' });
    const final = {
      title: 'Approved',
      description: 'Mine.',
      hashtags: [],
      tags: ['synthwave'],
    };
    await patch('p', { finalFields: final });
    expect(await createShort(stale, SHORT_SOURCE_STATES, 's1')).toEqual({ id: 's1' });
    expect(await listPicks('s1')).toEqual([{ ...pick(3), ...final, version: 1, skipped: false }]);
  });

  it('starts nothing when the video has no pick on screen', async () => {
    const none = await parent({ pickVersion: null });
    expect(await createShort(none, SHORT_SOURCE_STATES, 's1')).toEqual({ noPick: true });
    await db().delete(jobs).where(eq(jobs.id, 'p'));
    const gone = await parent({ pickVersion: 9 });
    expect(await createShort(gone, SHORT_SOURCE_STATES, 's2')).toEqual({ noPick: true });
    expect((await exists('s1')) || (await exists('s2'))).toBe(false);
    expect(await db().select({ picks: jobs.picks }).from(jobs).where(eq(jobs.id, 's2'))).toEqual(
      [],
    );
  });

  it('keeps a filename without an extension readable', async () => {
    const job = await parent({ filename: 'master take' });
    await createShort(job, SHORT_SOURCE_STATES, 's1');
    expect((await getJob('s1'))!.filename).toBe('master take (Short).mp4');
  });
});

describe('ok', () => {
  it('resets the failure streak and the shown error', () => {
    expect(ok({ state: 'RENDER' })).toEqual({
      state: 'RENDER',
      consecutiveFailures: 0,
      error: null,
    });
  });
});

describe('toPublic', () => {
  it('passes the Short link, parent, destination and approved fields through', async () => {
    const job = await createJob(input, 'j');
    const final = { title: 't', description: 'd', hashtags: [], tags: [] };
    const destination = { channelId: 'UCflr', channelTitle: null };
    const pub = toPublic({
      ...job,
      shortId: 's1',
      parentId: 'p',
      destination,
      finalFields: final,
      sourceObject: 'uploads/p',
    });
    expect(pub).toMatchObject({ shortId: 's1', parentId: 'p', destination, finalFields: final });
    expect(pub.short).toBeNull();
    expect(pub).not.toHaveProperty('sourceObject');
  });

  it('drops server-only fields', async () => {
    const job = await createJob(input, 'j');
    const pub = toPublic({
      ...job,
      upload: { sessionUri: 'secret', total: 1 },
      uploadStartedAt: 1,
      finalChunkAt: 2,
    });
    for (const field of [
      'upload',
      'ownerUid',
      'artistId',
      'trace',
      'uploadStartedAt',
      'finalChunkAt',
      'audience',
    ]) {
      expect(pub).not.toHaveProperty(field);
    }
    expect(pub.songTitle).toBe('PeekaBoo');
  });
});

describe('jobSet', () => {
  it('never replaces or clears a saved videoId', async () => {
    await createJob(input, 'j');
    await patch('j', { videoId: 'first' });
    await patch('j', { videoId: 'second' });
    await patch('j', { videoId: null });
    expect((await getJob('j'))!.videoId).toBe('first');
  });

  it('leaves the upload lock to its own statements', async () => {
    await seedJob({
      id: 'j',
      destination: { channelId: 'UCflr', channelTitle: 'FLR' },
      uploadStartedAt: 5,
    });
    // A widened patch, as a step's spread result could carry, still writes none of them.
    const widened = {
      id: 'other',
      ownerUid: USER_B.uid,
      createdAt: 1,
      artistId: null,
      parentId: 'p',
      destination: null,
      uploadStartedAt: null,
      finalChunkAt: 9,
      state: 'PREP',
    } as JobPatch;
    await patch('j', widened);
    expect(await getJob('j')).toMatchObject({
      id: 'j',
      parentId: null,
      state: 'PREP',
      destination: { channelId: 'UCflr', channelTitle: 'FLR' },
      uploadStartedAt: 5,
      finalChunkAt: null,
    });
    const [row] = await db().select().from(jobs).where(eq(jobs.id, 'j'));
    for (const key of [
      'id',
      'ownerUid',
      'createdAt',
      'artistId',
      'parentId',
      'destination',
      'uploadStartedAt',
      'finalChunkAt',
    ]) {
      expect(row!.data).not.toHaveProperty(key);
    }
  });
});

describe('fail', () => {
  it('records the failed state for a retry', () => {
    expect(fail('ANALYZE', 'boom')).toEqual({
      state: 'FAILED',
      failedState: 'ANALYZE',
      error: 'boom',
    });
  });
});

describe('outcomeUnknown', () => {
  const paused = jobDoc({ state: 'PUBLISHING', finalChunkAt: 5 });
  it('matches a publishing job whose session was lost after the final chunk', () => {
    expect(outcomeUnknown(paused)).toBe(true);
  });

  it('matches a paused job whose data has no upload key at all', () => {
    expect(outcomeUnknown({ ...paused, upload: undefined } as unknown as JobDoc)).toBe(true);
  });

  it.each<[string, Partial<JobDoc>]>([
    ['another state', { state: 'CLAIMED_COMPLETE' }],
    ['no final chunk', { finalChunkAt: null }],
    ['a live session', { upload: { sessionUri: SESSION_URI, total: 1 } }],
    ['a video ID', { videoId: 'v' }],
  ])('rejects a job with %s', (_label, patch) => {
    expect(outcomeUnknown({ ...paused, ...patch })).toBe(false);
  });
});
