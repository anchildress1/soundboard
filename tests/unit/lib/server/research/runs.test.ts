// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, query } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { jobResearch, jobs, researchRuns, users } from '#lib/server/core/schema.js';
import {
  claim,
  clearFailedRun,
  commit,
  expired,
  failRun,
  getRun,
  release,
  RUN_EXPIRY_MS,
  startRun,
  type Release,
} from '#lib/server/research/runs.js';
import { seed, truncate } from '../../../../helpers/db';
import { A_JOB, C_JOB, seedJob, USERS, USER_A, USER_C } from '../../../../helpers/pipeline';

const asA = <T>(operation: () => Promise<T>) => withIdentity(USER_A.uid, operation);
const asC = <T>(operation: () => Promise<T>) => withIdentity(USER_C.uid, operation);

const runRow = (patch: Partial<typeof researchRuns.$inferInsert> = {}) => ({
  jobId: 'j1',
  id: 'run-1',
  ownerUid: USER_A.uid,
  artistId: USER_A.artistId,
  stage: 'learn' as const,
  ...patch,
});
const DELIVERY = { jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 };
const NEXT: Release = {
  stage: 'discover',
  cursor: 0,
  wait: null,
  consecutiveFailures: 0,
  limits: ['analytics-not-shared'],
  error: null,
};

const stored = async (jobId = 'j1') =>
  (await db().select().from(researchRuns).where(eq(researchRuns.jobId, jobId)))[0];

const saveEvidence = (runId: string, token: string, evidence: unknown) =>
  sql`select public.soundboard_save_research(${runId}, ${token}, now(), ${JSON.stringify(evidence)}::jsonb)`;

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
});

describe('startRun', () => {
  it('starts the job at learn with seq 0 and a random id', async () => {
    const run = await asA(() => startRun({ id: 'j1', ownerUid: USER_A.uid }, USER_A.artistId));
    expect(run).toMatchObject({ jobId: 'j1', stage: 'learn', seq: 0, cursor: 0, limits: [] });
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replaces an earlier run with a new id, seq 0 and nothing carried over', async () => {
    await seed({
      researchRuns: [
        runRow({
          stage: 'failed',
          seq: 4,
          cursor: 3,
          consecutiveFailures: 2,
          error: 'boom',
          limits: ['no-peers'],
          startedAt: new Date(Date.now() - RUN_EXPIRY_MS),
          finishedAt: new Date(),
        }),
      ],
    });
    const run = await asA(() => startRun({ id: 'j1', ownerUid: USER_A.uid }, USER_A.artistId));
    expect(run.id).not.toBe('run-1');
    expect(run).toMatchObject({
      stage: 'learn',
      seq: 0,
      cursor: 0,
      consecutiveFailures: 0,
      error: null,
      limits: [],
      finishedAt: null,
    });
    expect(expired(run)).toBe(false);
  });

  it("refuses a run on another user's job", async () => {
    await expect(
      asC(() => startRun({ id: 'j1', ownerUid: USER_C.uid }, USER_C.artistId)),
    ).rejects.toThrow();
    expect(await stored()).toBeUndefined();
  });

  it("refuses a run under an artist that isn't the caller's", async () => {
    await expect(
      asA(() => startRun({ id: 'j1', ownerUid: USER_A.uid }, USER_C.artistId)),
    ).rejects.toThrow();
  });
});

describe('getRun and expired', () => {
  it("returns the owner's run and hides it from everyone else", async () => {
    await seed({ researchRuns: [runRow()] });
    expect(await asA(() => getRun('j1'))).toMatchObject({ id: 'run-1' });
    expect(await asC(() => getRun('j1'))).toBeNull();
    expect(await asA(() => getRun('missing'))).toBeNull();
  });

  it('treats 29 days as expired and a minute less as fresh', async () => {
    const now = Date.now();
    const at = (ms: number) => ({ startedAt: new Date(now - ms) }) as never;
    expect(expired(at(RUN_EXPIRY_MS), now)).toBe(true);
    expect(expired(at(RUN_EXPIRY_MS - 60_000), now)).toBe(false);
  });
});

describe('claim', () => {
  it('claims a matching delivery with a fresh token and a 3-minute expiry', async () => {
    await seed({ researchRuns: [runRow()] });
    const claimed = await asA(() => claim(DELIVERY));
    expect(claimed.kind).toBe('claimed');
    const row = await stored();
    expect(row?.claimToken).toMatch(/^[0-9a-f]{32}$/);
    const ttl = row!.claimUntil!.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(170_000);
    expect(ttl).toBeLessThanOrEqual(180_000);
  });

  it.each([
    ['another runId', { runId: 'run-0' }],
    ['another jobId', { jobId: 'j2' }],
    ['a lower seq', { seq: 0 }],
  ])('drops a delivery with %s as stale', async (_name, patch) => {
    await seed({ researchRuns: [runRow({ seq: 1 })] });
    expect(await asA(() => claim({ ...DELIVERY, seq: 1, ...patch }))).toEqual({ kind: 'stale' });
    expect((await stored())?.claimToken).toBeNull();
  });

  it("drops a delivery naming another user's uid as stale", async () => {
    await seed({ researchRuns: [runRow()] });
    expect(await asC(() => claim({ ...DELIVERY, uid: USER_C.uid }))).toEqual({ kind: 'stale' });
    expect(await asA(() => claim({ ...DELIVERY, uid: USER_C.uid }))).toEqual({ kind: 'stale' });
  });

  it.each(['done', 'failed'] as const)('drops a delivery for a %s run as stale', async (stage) => {
    await seed({ researchRuns: [runRow({ stage })] });
    expect(await asA(() => claim(DELIVERY))).toEqual({ kind: 'stale' });
  });

  it('drops a delivery for a discarded job as stale', async () => {
    await seed({ researchRuns: [runRow()] });
    await db().update(jobs).set({ state: 'DISCARDED' }).where(eq(jobs.id, 'j1'));
    expect(await asA(() => claim(DELIVERY))).toEqual({ kind: 'stale' });
  });

  it('drops a delivery for an inactive owner as stale', async () => {
    await seed({ researchRuns: [runRow()] });
    await db().update(users).set({ active: false }).where(eq(users.uid, USER_A.uid));
    expect(await asA(() => claim(DELIVERY))).toEqual({ kind: 'stale' });
  });

  it('asks for a retry while another delivery holds the claim', async () => {
    await seed({
      researchRuns: [runRow({ claimToken: 't', claimUntil: new Date(Date.now() + 60_000) })],
    });
    expect(await asA(() => claim(DELIVERY))).toEqual({ kind: 'retry' });
    expect((await stored())?.claimToken).toBe('t');
  });

  it('asks for a retry when the delivery is ahead of the row', async () => {
    await seed({ researchRuns: [runRow()] });
    expect(await asA(() => claim({ ...DELIVERY, seq: 1 }))).toEqual({ kind: 'retry' });
  });

  it('takes over a claim that has expired', async () => {
    await seed({
      researchRuns: [runRow({ claimToken: 't', claimUntil: new Date(Date.now() - 1) })],
    });
    const claimed = await asA(() => claim(DELIVERY));
    expect(claimed.kind).toBe('claimed');
    expect((await stored())?.claimToken).not.toBe('t');
  });
});

describe('commit', () => {
  const claimedRun = async () => {
    const claimed = await asA(() => claim(DELIVERY));
    if (claimed.kind !== 'claimed') throw new Error('not claimed');
    return claimed;
  };

  beforeEach(() => seed({ researchRuns: [runRow()] }));

  it('writes the batch, then advances seq and releases the claim', async () => {
    const { run, token } = await claimedRun();
    const ok = await asA(() =>
      commit(run, token, NEXT, async (tx) => {
        await tx.execute(saveEvidence(run.id, token, { query: 'q' }));
      }),
    );
    expect(ok).toBe(true);
    expect(await stored()).toMatchObject({
      stage: 'discover',
      seq: 1,
      claimToken: null,
      claimUntil: null,
      limits: ['analytics-not-shared'],
      finishedAt: null,
    });
    const [evidence] = await db().select().from(jobResearch);
    expect(evidence).toMatchObject({ runId: 'run-1', jobId: 'j1', evidence: { query: 'q' } });
  });

  it('stamps finished_at when the run ends', async () => {
    const { run, token } = await claimedRun();
    await asA(() => commit(run, token, { ...NEXT, stage: 'done' }));
    expect((await stored())?.finishedAt).toBeInstanceOf(Date);
  });

  it("writes nothing for a stale worker whose claim was retaken, and keeps the other's evidence", async () => {
    const stale = await claimedRun();
    await db()
      .update(researchRuns)
      .set({ claimUntil: new Date(Date.now() - 1) })
      .where(eq(researchRuns.id, 'run-1'));
    const fresh = await claimedRun();
    await asA(() =>
      commit(fresh.run, fresh.token, { ...NEXT, stage: 'learn' }, async (tx) => {
        await tx.execute(saveEvidence('run-1', fresh.token, { query: 'kept' }));
      }),
    );
    const before = await db().select().from(jobResearch);
    const afterFresh = await stored();

    const ok = await asA(() =>
      commit(stale.run, stale.token, NEXT, async (tx) => {
        await tx.execute(saveEvidence('run-1', stale.token, { query: 'stale' }));
      }),
    );
    expect(ok).toBe(false);
    expect(await db().select().from(jobResearch)).toEqual(before);
    expect(await stored()).toEqual(afterFresh);
  });

  it('rolls back the writes when only the release finds the claim gone', async () => {
    const { run, token } = await claimedRun();
    const ok = await asA(() =>
      commit(run, token, NEXT, async (tx) => {
        await tx.execute(saveEvidence(run.id, token, { query: 'q' }));
        // The claim lapses between the write and the release.
        await tx.execute(
          sql`update research_runs set claim_until = now() - interval '1 second' where id = ${run.id}`,
        );
      }),
    );
    expect(ok).toBe(false);
    expect(await db().select().from(jobResearch)).toEqual([]);
    expect(await stored()).toMatchObject({ stage: 'learn', seq: 0 });
  });

  it('passes on any other write error', async () => {
    const { run, token } = await claimedRun();
    await expect(
      asA(() =>
        commit(run, token, NEXT, async () => {
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(await stored()).toMatchObject({ seq: 0, claimToken: token });
  });
});

describe('release', () => {
  beforeEach(() => seed({ researchRuns: [runRow()] }));

  it('gives the claim back with nothing advanced', async () => {
    const claimed = await asA(() => claim(DELIVERY));
    if (claimed.kind !== 'claimed') throw new Error('not claimed');
    await asA(() => release(claimed.run, claimed.token));
    expect(await stored()).toMatchObject({ seq: 0, stage: 'learn', claimToken: null });
  });

  it("leaves another worker's claim alone", async () => {
    const claimed = await asA(() => claim(DELIVERY));
    if (claimed.kind !== 'claimed') throw new Error('not claimed');
    await asA(() => release(claimed.run, 'other'));
    expect((await stored())?.claimToken).toBe(claimed.token);
  });
});

describe('failRun and clearFailedRun', () => {
  it('ends a running run as failed with the limit, clearing its claim', async () => {
    await seed({
      researchRuns: [
        runRow({ claimToken: 't', claimUntil: new Date(Date.now() + 60_000), limits: ['x'] }),
      ],
    });
    await asA(() => failRun('j1', 'research-unavailable', 'research-unavailable'));
    expect(await stored()).toMatchObject({
      stage: 'failed',
      error: 'research-unavailable',
      limits: ['x', 'research-unavailable'],
      claimToken: null,
      claimUntil: null,
    });
    expect((await stored())?.finishedAt).toBeInstanceOf(Date);
  });

  it("joins the caller's transaction and adds no limit when given none", async () => {
    await seed({ researchRuns: [runRow()] });
    await asA(() => query((tx) => failRun('j1', 'discarded', null, tx)));
    expect(await stored()).toMatchObject({ stage: 'failed', error: 'discarded', limits: [] });
  });

  it('leaves a finished run as it ended', async () => {
    await seed({ researchRuns: [runRow({ stage: 'done' })] });
    await asA(() => failRun('j1', 'discarded', null));
    expect(await stored()).toMatchObject({ stage: 'done', error: null });
  });

  it("leaves another job's run untouched", async () => {
    await seedJob({ ...C_JOB, id: 'j2', state: 'PICK' });
    await seed({
      researchRuns: [
        runRow(),
        runRow({ jobId: 'j2', id: 'run-2', ownerUid: USER_C.uid, artistId: USER_C.artistId }),
      ],
    });
    await asA(() => failRun('j1', 'discarded', null));
    expect((await stored('j2'))?.stage).toBe('learn');
  });

  it('deletes only a failed run', async () => {
    await seed({ researchRuns: [runRow({ stage: 'done' })] });
    await asA(() => query((tx) => clearFailedRun(tx, 'j1')));
    expect(await stored()).toBeDefined();
    await db().update(researchRuns).set({ stage: 'failed' });
    await asA(() => query((tx) => clearFailedRun(tx, 'j1')));
    expect(await stored()).toBeUndefined();
  });
});
