// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { jobAudience, jobAudienceFresh, jobs } from '#lib/server/core/schema.js';
import { deleteExpiredAudience, readAudience, saveAudience } from '#lib/server/jobs/audience.js';
import { claimJob, getJob, latestPick, releaseJob, transitionJob } from '#lib/server/jobs/jobs.js';
import { jobRow } from '#lib/server/jobs/rows.js';
import type { AudienceEvidence } from '#lib/server/pipeline/hashtags.js';
import type { Pick } from '#lib/types.js';
import { seed, truncate } from '../../../../helpers/db';
import { jobDoc, USERS } from '../../../../helpers/pipeline';

const DAY_MS = 24 * 60 * 60 * 1000;
const evidence = (retrievedAt = Date.now()): AudienceEvidence => ({
  retrievedAt,
  query: 'synthwave music video',
  candidateLists: [
    {
      videoId: 'peer',
      title: 'A peer release',
      hashtags: ['#synthwave'],
      tags: [{ tag: 'synthwave' }],
    },
  ],
  top: [{ title: 'A peer release', description: 'Peer copy.', tags: ['synthwave'], views: 42 }],
});

const draft: Pick = {
  version: 1,
  title: 'PeekaBoo',
  description: 'A new song. #synthwave',
  hashtags: ['#synthwave'],
  tags: ['synthwave'],
  flags: [],
  brandCheck: '',
  why: { title: '', description: '', tags: '' },
  bandcamp: { about: 'A new song.', credits: 'Written by Nathan.' },
  modelMs: 1,
};

beforeEach(async () => {
  await truncate();
  await seed({ ...USERS, jobs: [jobRow(jobDoc({ state: 'PICK' }))] });
});

describe('readAudience', () => {
  it('returns null when the job has no stored research', async () => {
    expect(await readAudience('j1')).toBeNull();
    expect(await readAudience('missing')).toBeNull();
  });

  it.each([
    { age: 29, visible: true },
    { age: 30, visible: false },
    { age: 31, visible: false },
  ])('uses the database clock for research aged $age days', async ({ age, visible }) => {
    const stored = evidence(Date.now() - age * DAY_MS);

    await db().transaction(async (tx) => {
      await tx.insert(jobAudience).values({
        jobId: 'j1',
        retrievedAt: sql`now() - ${age} * interval '1 day'`,
        evidence: stored,
      });

      expect(await readAudience('j1', tx)).toEqual(visible ? stored : null);
      expect(
        await tx.select({ evidence: jobAudienceFresh.evidence }).from(jobAudienceFresh),
      ).toEqual(visible ? [{ evidence: stored }] : []);
      expect(await tx.select().from(jobAudience)).toHaveLength(1);
    });
  });
});

describe('saveAudience', () => {
  it('retains the original retrieval time when the same research is saved again', async () => {
    const stored = evidence(Date.now() - 29 * DAY_MS);

    await db().transaction(async (tx) => {
      await saveAudience(tx, 'j1', stored);
      await saveAudience(tx, 'j1', stored);
    });

    const [row] = await db().select().from(jobAudience);
    expect(row).toMatchObject({ jobId: 'j1', evidence: stored });
    expect(row!.retrievedAt.getTime()).toBe(stored.retrievedAt);
    expect(await readAudience('j1')).toEqual(stored);
  });

  it('accepts newer research and rejects later writes carrying older or equal retrieval times', async () => {
    const older = evidence(Date.now() - DAY_MS);
    const newer = { ...evidence(), query: 'newer research' };

    await db().transaction(async (tx) => {
      await saveAudience(tx, 'j1', older);
      await saveAudience(tx, 'j1', newer);
      await saveAudience(tx, 'j1', older);
      await saveAudience(tx, 'j1', { ...newer, query: 'same timestamp, different data' });
    });

    expect(await readAudience('j1')).toEqual(newer);
    const [row] = await db().select().from(jobAudience);
    expect(row!.retrievedAt.getTime()).toBe(newer.retrievedAt);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined])(
    'rejects invalid retrieval time %s without storing research',
    async (retrievedAt) => {
      const invalid = { ...evidence(), retrievedAt } as AudienceEvidence;

      await expect(db().transaction((tx) => saveAudience(tx, 'j1', invalid))).rejects.toThrow(
        'Missing research retrieval time.',
      );
      expect(await db().select().from(jobAudience)).toEqual([]);
    },
  );

  it('propagates a foreign-key failure without retaining orphan research', async () => {
    await expect(
      db().transaction((tx) => saveAudience(tx, 'missing', evidence())),
    ).rejects.toThrow();
    expect(await db().select().from(jobAudience)).toEqual([]);
  });
});

describe('deleteExpiredAudience', () => {
  it('deletes the exact cutoff and older rows, preserves fresh rows, and is idempotent', async () => {
    await seed({ jobs: ['fresh', 'cutoff', 'old'].map((id) => jobRow(jobDoc({ id }))) });

    await db().transaction(async (tx) => {
      for (const [jobId, age] of [
        ['fresh', 29],
        ['cutoff', 30],
        ['old', 31],
      ] as const) {
        await tx.insert(jobAudience).values({
          jobId,
          retrievedAt: sql`now() - ${age} * interval '1 day'`,
          evidence: evidence(),
        });
      }

      expect(await tx.select({ id: jobAudienceFresh.jobId }).from(jobAudienceFresh)).toEqual([
        { id: 'fresh' },
      ]);
      expect(await tx.select().from(jobAudience)).toHaveLength(3);

      expect(await deleteExpiredAudience(tx)).toBe(2);
      expect(await deleteExpiredAudience(tx)).toBe(0);
      expect(await tx.select({ id: jobAudience.jobId }).from(jobAudience)).toEqual([
        { id: 'fresh' },
      ]);
      expect(await tx.select({ id: jobs.id }).from(jobs)).toHaveLength(4);
    });
  });

  it('hides expired research and preserves the latest draft before and after deletion', async () => {
    await db()
      .update(jobs)
      .set({ picks: [{ ...draft, skipped: false }] })
      .where(eq(jobs.id, 'j1'));
    await db().transaction((tx) => saveAudience(tx, 'j1', evidence(Date.now() - 31 * DAY_MS)));

    expect(await getJob('j1')).toMatchObject({ audience: null, hashtagCandidates: draft.hashtags });
    expect(await latestPick('j1')).toEqual({ ...draft, skipped: false });
    expect(await deleteExpiredAudience()).toBe(1);
    expect(await getJob('j1')).toMatchObject({ audience: null, hashtagCandidates: draft.hashtags });
    expect(await latestPick('j1')).toEqual({ ...draft, skipped: false });
    const [row] = await db().select().from(jobs).where(eq(jobs.id, 'j1'));
    expect(row!.data).not.toHaveProperty('audience');
  });
});

describe('claim-bound research persistence', () => {
  it('saves research with the matching claim without embedding it in the job', async () => {
    const { token } = (await claimJob('j1'))!;
    const stored = evidence();

    expect(await releaseJob('j1', token, 'PICK', { audience: stored })).toBe(true);
    expect(await readAudience('j1')).toEqual(stored);
    const [row] = await db().select().from(jobs).where(eq(jobs.id, 'j1'));
    expect(row!.data).not.toHaveProperty('audience');
  });

  it.each(['wrong token', 'changed state'])(
    'does not save research after a %s',
    async (condition) => {
      const { token } = (await claimJob('j1'))!;
      if (condition === 'changed state') {
        await transitionJob('j1', ['PICK'], { state: 'DISCARDED' });
      }

      const released = await releaseJob(
        'j1',
        condition === 'wrong token' ? 'stale' : token,
        'PICK',
        {
          audience: evidence(),
        },
      );

      expect(released).toBe(false);
      expect(await db().select().from(jobAudience)).toEqual([]);
    },
  );
});
