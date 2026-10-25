// @vitest-environment node
import * as Sentry from '@sentry/sveltekit';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBusy, ModelQuotaSpent } from '#lib/server/ai/model.js';
import { db } from '#lib/server/core/db.js';
import { quotaResetAt } from '#lib/server/core/quota.js';
import { jobResearch, researchRuns } from '#lib/server/core/schema.js';
import { DeadlineSpent, YouTubeError } from '#lib/server/platforms/youtube/youtube.js';
import {
  RETRY_MS,
  hasTime,
  runDelivery,
  type Batch,
  type Stage,
  type Stages,
} from '#lib/server/research/delivery.js';
import { seed, truncate } from '../../../../helpers/db';
import { A_JOB, seedJob, USERS, USER_A } from '../../../../helpers/pipeline';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = async () => 'ya29.token';
  },
}));

const QUEUE = 'projects/p/locations/us-central1/queues/soundboard-research';
const DELIVERY = { jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 };
const fetchMock = vi.fn<typeof fetch>();

const runRow = (patch: Partial<typeof researchRuns.$inferInsert> = {}) => ({
  jobId: 'j1',
  id: 'run-1',
  ownerUid: USER_A.uid,
  artistId: USER_A.artistId,
  stage: 'learn' as const,
  ...patch,
});
const stored = async () =>
  (await db().select().from(researchRuns).where(eq(researchRuns.jobId, 'j1')))[0];

/** The tasks the delivery created, decoded. */
const tasks = () =>
  fetchMock.mock.calls.map(([, init]) => {
    const { task } = JSON.parse(String(init!.body)) as {
      task: { name: string; scheduleTime?: string; httpRequest: { body: string } };
    };
    return {
      name: task.name,
      at: task.scheduleTime ? Date.parse(task.scheduleTime) : null,
      delivery: JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString()) as unknown,
    };
  });

/** Stages where `learn` is `stage`; the rest end the run. */
const with_ = (stage: Stage): Stages => ({
  learn: stage,
  discover: async () => ({ done: 0, stage: 'done', cursor: 0 }),
  match: async () => ({ done: 0, stage: 'done', cursor: 0 }),
  releases: async () => ({ done: 0, stage: 'done', cursor: 0 }),
});
const returning = (batch: Batch) => with_(async () => batch);
const throwing = (error: unknown) =>
  with_(async () => {
    throw error;
  });

const saveEvidence =
  (query: string): Batch['writes'] =>
  async (tx, token) => {
    await tx.execute(
      sql`select public.soundboard_save_research('run-1', ${token}, now(), ${JSON.stringify({ query })}::jsonb)`,
    );
  };

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
  await seed({ researchRuns: [runRow()] });
  fetchMock.mockReset().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('RESEARCH_QUEUE', QUEUE);
  vi.stubEnv('RESEARCH_TASK_URL', 'https://soundboard-1.us-central1.run.app/api/research/task');
  vi.stubEnv('RESEARCH_TASK_SA', 'research@p.iam.gserviceaccount.com');
  vi.mocked(Sentry.startSpan).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('runDelivery', () => {
  it('runs the placeholder stages to done with their limits', async () => {
    expect(await runDelivery(DELIVERY)).toBe(200);
    expect(await stored()).toMatchObject({ stage: 'discover', seq: 1, claimToken: null });
    expect(tasks()).toEqual([
      { name: `${QUEUE}/tasks/run-1-1`, at: null, delivery: { ...DELIVERY, seq: 1 } },
    ]);
    expect(await runDelivery({ ...DELIVERY, seq: 1 })).toBe(200);
    expect(await stored()).toMatchObject({
      stage: 'done',
      seq: 2,
      limits: ['analytics-not-shared', 'no-peers'],
    });
    expect((await stored())?.finishedAt).toBeInstanceOf(Date);
    // A finished run enqueues nothing more.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records one research.stage span with the job, stage and cursor, and no token', async () => {
    await runDelivery(DELIVERY);
    expect(Sentry.startSpan).toHaveBeenCalledTimes(1);
    const [options] = vi.mocked(Sentry.startSpan).mock.calls[0]!;
    expect(options).toEqual({
      op: 'research.stage',
      name: 'research learn',
      attributes: { 'job.id': 'j1', 'research.stage': 'learn', 'research.cursor': 0 },
    });
  });

  it('hands the stage one deadline, started at the claim', async () => {
    const seen: number[] = [];
    const before = Date.now();
    await runDelivery(
      DELIVERY,
      with_(async ({ deadline }) => {
        seen.push(deadline);
        return { done: 1, stage: 'learn', cursor: 1 };
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]! - before).toBeGreaterThanOrEqual(110_000);
    expect(seen[0]! - Date.now()).toBeLessThanOrEqual(110_000);
  });

  it('answers a stale delivery 200 and changes nothing', async () => {
    const before = await stored();
    expect(await runDelivery({ ...DELIVERY, runId: 'run-0' })).toBe(200);
    expect(await stored()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 503 while the claim is held', async () => {
    await db()
      .update(researchRuns)
      .set({ claimToken: 't', claimUntil: new Date(Date.now() + 60_000) });
    expect(await runDelivery(DELIVERY)).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('commits the writes and the cursor of a batch that keeps its stage', async () => {
    const status = await runDelivery(
      DELIVERY,
      returning({ done: 3, stage: 'learn', cursor: 3, writes: saveEvidence('q') }),
    );
    expect(status).toBe(200);
    expect(await stored()).toMatchObject({ stage: 'learn', cursor: 3, seq: 1 });
    expect(await db().select().from(jobResearch)).toHaveLength(1);
    expect(tasks()[0]?.at).toBeNull();
  });

  it('answers 500 with nothing written or advanced when the next enqueue fails', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    const status = await runDelivery(
      DELIVERY,
      returning({ done: 3, stage: 'learn', cursor: 3, writes: saveEvidence('q') }),
    );
    expect(status).toBe(500);
    expect(await stored()).toMatchObject({ stage: 'learn', cursor: 0, seq: 0, claimToken: null });
    expect(await db().select().from(jobResearch)).toEqual([]);
  });

  it('keeps the progress of a batch that stopped on a wait, and schedules at the wait', async () => {
    const at = Date.now() + RETRY_MS;
    await runDelivery(
      DELIVERY,
      returning({
        done: 2,
        stage: 'learn',
        cursor: 2,
        wait: { wait: 'model busy', at },
        writes: saveEvidence('q'),
      }),
    );
    expect(await stored()).toMatchObject({ cursor: 2, wait: 'model busy', seq: 1 });
    expect(await db().select().from(jobResearch)).toHaveLength(1);
    expect(tasks()[0]?.at).toBe(at);
  });

  describe('waits', () => {
    beforeEach(() => db().update(researchRuns).set({ consecutiveFailures: 1, cursor: 4 }));

    const quota = new YouTubeError(403, 'quota', 'quotaExceeded');
    it.each([
      ['ModelBusy', new ModelBusy('busy'), 'model busy', () => Date.now() + RETRY_MS],
      [
        'ModelQuotaSpent',
        new ModelQuotaSpent('spent', Date.UTC(2030, 0, 1)),
        'model quota spent',
        () => Date.UTC(2030, 0, 1),
      ],
      ['YouTube quota', quota, 'waiting on YouTube', () => quotaResetAt(Date.now())],
      [
        'YouTube busy',
        new YouTubeError(503, 'down'),
        'waiting on YouTube',
        () => Date.now() + RETRY_MS,
      ],
      ['DeadlineSpent', new DeadlineSpent(), 'waiting on YouTube', () => Date.now() + RETRY_MS],
    ])('a %s is a wait: streak and cursor unchanged', async (_name, error, wait, at) => {
      expect(await runDelivery(DELIVERY, throwing(error))).toBe(200);
      expect(await stored()).toMatchObject({
        stage: 'learn',
        seq: 1,
        cursor: 4,
        consecutiveFailures: 1,
        wait,
      });
      expect(Math.abs(tasks()[0]!.at! - at())).toBeLessThan(2_000);
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('consecutive zero-progress waits never fail the run', async () => {
      await runDelivery(DELIVERY, throwing(new ModelBusy('429')));
      await runDelivery({ ...DELIVERY, seq: 1 }, throwing(new YouTubeError(503, 'down')));
      await runDelivery(
        { ...DELIVERY, seq: 2 },
        returning({ done: 0, stage: 'learn', cursor: 4, wait: { wait: 'model busy', at: 0 } }),
      );
      expect(await stored()).toMatchObject({ stage: 'learn', seq: 3, consecutiveFailures: 1 });
    });
  });

  describe('failures', () => {
    it('counts an error toward the streak, reports it scrubbed, and retries after a minute', async () => {
      const status = await runDelivery(
        DELIVERY,
        throwing(new Error('boom at https://x.example/a?sig=secret')),
      );
      expect(status).toBe(200);
      const row = await stored();
      expect(row).toMatchObject({ stage: 'learn', seq: 1, consecutiveFailures: 1 });
      expect(row?.error).not.toContain('secret');
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Math.abs(tasks()[0]!.at! - (Date.now() + RETRY_MS))).toBeLessThan(2_000);
    });

    it('counts a batch that finished nothing toward the streak', async () => {
      await runDelivery(DELIVERY, returning({ done: 0, stage: 'learn', cursor: 0 }));
      expect(await stored()).toMatchObject({
        consecutiveFailures: 1,
        error: 'The batch finished nothing.',
      });
    });

    it('ends the run failed at the second failure and enqueues nothing', async () => {
      await runDelivery(DELIVERY, throwing(new Error('one')));
      await runDelivery({ ...DELIVERY, seq: 1 }, returning({ done: 0, stage: 'learn', cursor: 0 }));
      expect(await stored()).toMatchObject({ stage: 'failed', consecutiveFailures: 2, seq: 2 });
      expect((await stored())?.finishedAt).toBeInstanceOf(Date);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('resets the streak after a batch that progressed', async () => {
      await runDelivery(DELIVERY, throwing(new Error('one')));
      await runDelivery({ ...DELIVERY, seq: 1 }, returning({ done: 1, stage: 'learn', cursor: 1 }));
      expect(await stored()).toMatchObject({ consecutiveFailures: 0, error: null });
    });
  });
});

describe('hasTime', () => {
  it('keeps the reserve plus the item estimate', () => {
    expect(hasTime(10_000 + 8_001, 10_000, 0)).toBe(true);
    expect(hasTime(10_000 + 8_000, 10_000, 0)).toBe(false);
  });
});
