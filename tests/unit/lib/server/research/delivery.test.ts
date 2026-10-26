// @vitest-environment node
import * as Sentry from '@sentry/sveltekit';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBusy, ModelQuotaSpent } from '#lib/server/ai/model.js';
import { db } from '#lib/server/core/db.js';
import { quotaResetAt } from '#lib/server/core/quota.js';
import {
  artistGuides,
  artistOutcomes,
  connections,
  jobResearch,
  peerRejections,
  researchRuns,
} from '#lib/server/core/schema.js';
import { DeadlineSpent, YouTubeError } from '#lib/server/platforms/youtube/youtube.js';
import { RETRY_MS, type Batch, type Stage } from '#lib/server/research/batch.js';
import { runDelivery, type Stages } from '#lib/server/research/delivery.js';
import { seed, truncate } from '../../../../helpers/db';
import { A_JOB, seedJob, USERS, USER_A } from '../../../../helpers/pipeline';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = () => Promise.resolve('tasks-access-token');
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
  discover: () => Promise.resolve({ done: 0, stage: 'done', cursor: 0 }),
  match: () => Promise.resolve({ done: 0, stage: 'done', cursor: 0 }),
  releases: () => Promise.resolve({ done: 0, stage: 'done', cursor: 0 }),
});
const returning = (batch: Batch) => with_(() => Promise.resolve(batch));
const throwing = (error: Error) => with_(() => Promise.reject(error));

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
  it('runs stage after stage until done, keeping each limit, then enqueues nothing', async () => {
    const stages: Stages = {
      ...with_(() =>
        Promise.resolve({
          done: 0,
          stage: 'discover',
          cursor: 0,
          limits: ['analytics-not-shared'],
        }),
      ),
      discover: () => Promise.resolve({ done: 1, stage: 'done', cursor: 0, limits: ['no-peers'] }),
    };
    expect(await runDelivery(DELIVERY, stages)).toBe(200);
    expect(await stored()).toMatchObject({ stage: 'discover', seq: 1, claimToken: null });
    expect(tasks()).toEqual([
      { name: `${QUEUE}/tasks/run-1-1`, at: null, delivery: { ...DELIVERY, seq: 1 } },
    ]);
    expect(await runDelivery({ ...DELIVERY, seq: 1 }, stages)).toBe(200);
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
      with_(({ deadline }) => {
        seen.push(deadline);
        return Promise.resolve({ done: 1, stage: 'learn', cursor: 1 });
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

describe('continuity and idempotency', () => {
  const ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
  const OUTCOME_ROW = {
    videoId: 'v1',
    publishedAt: '2026-09-01T00:00:00Z',
    requestedStart: '2026-08-31',
    requestedEnd: '2026-09-27',
    coverage: 'complete',
    metrics: { views: 5, subscribersGained: 1, subscribersLost: 0 },
    live: { title: 'Song', description: 'Out now.', tags: [] },
    differsFromApproved: null,
  };

  /** Every stage writes what its real counterpart does, under the run's claim. */
  const stages: Stages = {
    learn: async ({ run }) => {
      const [grant] = await db()
        .select({ at: connections.updatedAt })
        .from(connections)
        .where(eq(connections.uid, run.ownerUid));
      return {
        done: 1,
        stage: 'discover',
        cursor: 0,
        writes: async (tx, token) => {
          await tx.execute(
            sql`select public.soundboard_save_outcomes('run-1', ${token}, ${grant!.at.toISOString()}::timestamptz, ${JSON.stringify([OUTCOME_ROW])}::jsonb)`,
          );
        },
      };
    },
    discover: () =>
      Promise.resolve({ done: 1, stage: 'match', cursor: 0, writes: saveEvidence('found') }),
    match: () =>
      Promise.resolve({
        done: 1,
        stage: 'releases',
        cursor: 0,
        writes: async (tx, token) => {
          await tx.execute(
            sql`select public.soundboard_refresh_rejections('run-1', ${token}, array['UCx'], array[]::text[])`,
          );
        },
      }),
    releases: () =>
      Promise.resolve({ done: 1, stage: 'done', cursor: 0, writes: saveEvidence('releases') }),
  };

  const contents = async () => ({
    research: await db().select().from(jobResearch),
    outcomes: await db().select().from(artistOutcomes),
    rejections: await db().select().from(peerRejections),
    guides: await db().select().from(artistGuides),
    run: await stored(),
  });

  /** The delivery a delivery enqueued, or null when it enqueued none. */
  const nextOf = (before: number) =>
    fetchMock.mock.calls.length > before ? (tasks().at(-1)!.delivery as typeof DELIVERY) : null;

  beforeEach(async () => {
    await db()
      .update(connections)
      .set({ scopes: ['openid', 'email', ANALYTICS] })
      .where(eq(connections.uid, USER_A.uid));
    await seed({
      peerRejections: [
        { artistId: USER_A.artistId, channelId: 'UCx', retrievedAt: new Date(Date.now() - 864e5) },
      ],
    });
  });

  it('completes every stage from deliveries alone, each writing once', async () => {
    let next: typeof DELIVERY | null = DELIVERY;
    const stagesSeen: string[] = [];
    while (next) {
      stagesSeen.push((await stored())!.stage);
      const before = fetchMock.mock.calls.length;
      expect(await runDelivery(next, stages)).toBe(200);
      next = nextOf(before);
    }
    expect(stagesSeen).toEqual(['learn', 'discover', 'match', 'releases']);
    expect(await stored()).toMatchObject({ stage: 'done', seq: 4, claimToken: null });
    const now = await contents();
    expect(now.research).toHaveLength(1);
    expect(now.outcomes).toHaveLength(1);
    expect(now.rejections).toHaveLength(1);
    expect(now.research[0]!.evidence).toEqual({ query: 'releases' });
  });

  it('leaves the stored contents unchanged when a delivery is redelivered twice', async () => {
    let next: typeof DELIVERY | null = DELIVERY;
    while (next) {
      const before = fetchMock.mock.calls.length;
      const delivered = next;
      expect(await runDelivery(delivered, stages)).toBe(200);
      const after = await contents();
      const sent = fetchMock.mock.calls.length;
      for (let again = 0; again < 2; again += 1) {
        expect(await runDelivery(delivered, stages)).toBe(200);
      }
      expect(await contents()).toEqual(after);
      expect(fetchMock.mock.calls).toHaveLength(sent);
      next = nextOf(before);
    }
    expect((await stored())?.stage).toBe('done');
  });

  it('keeps the first retrieval time through the stages that save evidence again', async () => {
    let next: typeof DELIVERY | null = DELIVERY;
    const times: number[] = [];
    while (next) {
      const before = fetchMock.mock.calls.length;
      await runDelivery(next, stages);
      const [row] = await db().select().from(jobResearch);
      if (row) times.push(row.retrievedAt.getTime());
      next = nextOf(before);
    }
    expect(times).toHaveLength(3);
    expect(new Set(times).size).toBe(1);
  });

  it('re-runs a batch once when the process died after the enqueue and before the commit', async () => {
    let runs = 0;
    const dying: Stages = {
      ...stages,
      learn: () => {
        runs += 1;
        return Promise.resolve({
          done: 1,
          stage: 'discover',
          cursor: 0,
          writes: () => Promise.reject(new Error('process died')),
        });
      },
    };
    const survived: Stages = {
      ...stages,
      learn: (context) => {
        runs += 1;
        return stages.learn(context);
      },
    };
    await expect(runDelivery(DELIVERY, dying)).rejects.toThrow('process died');
    expect(runs).toBe(1);
    // The next task was already created; a throw releases the claim, and a real crash can't.
    expect(tasks().map((task) => task.name)).toEqual([`${QUEUE}/tasks/run-1-1`]);
    expect(await stored()).toMatchObject({ seq: 0, stage: 'learn', claimToken: null });
    expect(await db().select().from(artistOutcomes)).toEqual([]);
    await db()
      .update(researchRuns)
      .set({ claimToken: 'crashed', claimUntil: new Date(Date.now() + 180_000) });

    // Both the next task and the original wait on the held claim.
    expect(await runDelivery({ ...DELIVERY, seq: 1 }, survived)).toBe(503);
    expect(await runDelivery(DELIVERY, survived)).toBe(503);
    expect(runs).toBe(1);

    // Once the claim lapses, the original runs the batch again, and only once.
    await db()
      .update(researchRuns)
      .set({ claimUntil: new Date(Date.now() - 1_000) });
    expect(await runDelivery(DELIVERY, survived)).toBe(200);
    expect(runs).toBe(2);
    expect(await runDelivery(DELIVERY, survived)).toBe(200);
    expect(runs).toBe(2);
    expect(await stored()).toMatchObject({ seq: 1, stage: 'discover' });
    expect(await db().select().from(artistOutcomes)).toHaveLength(1);
    // The re-enqueue names the same task, which Cloud Tasks dedupes.
    expect(new Set(tasks().map((task) => task.name))).toEqual(new Set([`${QUEUE}/tasks/run-1-1`]));
  });

  it('writes nothing for a worker whose claim lapsed and was taken by a redelivery', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Stages = {
      ...stages,
      learn: async (context) => {
        await gate;
        return stages.learn(context);
      },
    };
    const first = runDelivery(DELIVERY, slow);
    await vi.waitFor(async () => expect((await stored())?.claimToken).not.toBeNull());
    await db()
      .update(researchRuns)
      .set({ claimUntil: new Date(Date.now() - 1_000) });
    expect(await runDelivery(DELIVERY, stages)).toBe(200);
    const after = await contents();
    release();
    // Redelivered, it finds the redelivery already committed and drops.
    expect(await first).toBe(503);
    expect(await contents()).toEqual(after);
    expect(await runDelivery(DELIVERY, stages)).toBe(200);
    expect(await contents()).toEqual(after);
  });

  it('answers 503 for a lapsed claim no one took, and its redelivery advances the run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Stages = {
      ...stages,
      learn: async (context) => {
        await gate;
        return stages.learn(context);
      },
    };
    const first = runDelivery(DELIVERY, slow);
    await vi.waitFor(async () => expect((await stored())?.claimToken).not.toBeNull());
    await db()
      .update(researchRuns)
      .set({ claimUntil: new Date(Date.now() - 1_000) });
    release();
    expect(await first).toBe(503);
    expect((await stored())?.seq).toBe(0);
    expect(await runDelivery(DELIVERY, stages)).toBe(200);
    expect((await stored())?.seq).toBe(1);
  });

  it('drops a delivery whose owner was relinked to another artist mid-run', async () => {
    await db().execute(sql`insert into artists (id, name) values ('artist-new', 'New Artist')`);
    await db().execute(sql`update users set artist_id = 'artist-new' where uid = ${USER_A.uid}`);
    expect(await runDelivery(DELIVERY, stages)).toBe(200);
    expect((await stored())?.seq).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('leaves the artist’s guides unchanged through a full run', async () => {
    const before = await db().select().from(artistGuides);
    expect(before.length).toBeGreaterThan(0);
    let next: typeof DELIVERY | null = DELIVERY;
    while (next) {
      const sent = fetchMock.mock.calls.length;
      await runDelivery(next, stages);
      next = nextOf(sent);
    }
    expect(await db().select().from(artistGuides)).toEqual(before);
  });
});
