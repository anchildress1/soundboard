// One Cloud Tasks delivery runs one claimed batch of the run's stage (research R2 steps 2–7).
import { captureException, startSpan } from '@sentry/sveltekit';
import { scrubUrl } from '#lib/scrub.js';
import { stepDeadline } from '#lib/server/ai/model.js';
import { pgCode } from '#lib/server/core/errors.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { RESERVE_MS, RETRY_MS, waitFor, type Batch, type Stage } from './batch';
import { discover } from './discover';
import { learn } from './learn';
import { match } from './match';
import { enqueue } from './queue';
import { releases } from './releases';
import {
  claim,
  commit,
  release,
  type Delivery,
  type Release,
  type ResearchLimit,
  type ResearchRun,
  type RunStage,
} from './runs';

/** Consecutive failed batches that end the run. */
const MAX_FAILURES = 2;

export type Stages = Record<Exclude<RunStage, 'done' | 'failed'>, Stage>;

const STAGES: Stages = {
  learn,
  discover,
  match,
  releases,
};

type Outcome = { release: Release; at: number; writes?: NonNullable<Batch['writes']> };

const merged = (run: ResearchRun, limits: ResearchLimit[] = []) => [
  ...new Set([...run.limits, ...limits]),
];

/** A batch that finished items or moved stage resets the streak; one that did nothing counts. */
function batchOutcome(run: ResearchRun, batch: Batch, now: number): Outcome {
  const progressed = batch.done > 0 || batch.stage !== run.stage;
  const base = { cursor: batch.cursor, limits: merged(run, batch.limits), error: null };
  if (batch.wait) {
    // A wait never counts toward the streak, with or without progress (T057).
    const consecutiveFailures = progressed ? 0 : run.consecutiveFailures;
    return {
      release: { ...base, stage: batch.stage, wait: batch.wait.wait, consecutiveFailures },
      at: batch.wait.at,
      writes: batch.writes,
    };
  }
  if (!progressed) return failedOutcome(run, 'The batch finished nothing.', now);
  return {
    release: { ...base, stage: batch.stage, wait: null, consecutiveFailures: 0 },
    at: now,
    writes: batch.writes,
  };
}

function failedOutcome(run: ResearchRun, error: string, now: number): Outcome {
  const failures = run.consecutiveFailures + 1;
  return {
    release: {
      stage: failures >= MAX_FAILURES ? 'failed' : run.stage,
      cursor: run.cursor,
      wait: null,
      consecutiveFailures: failures,
      limits: run.limits,
      error,
    },
    at: now + RETRY_MS,
  };
}

async function runBatch(run: ResearchRun, deadline: number, stages: Stages): Promise<Outcome> {
  const now = () => Date.now();
  const stage = stages[run.stage as keyof Stages];
  try {
    return batchOutcome(run, await stage({ run, deadline }), now());
  } catch (error) {
    const wait = waitFor(error, now());
    if (wait) {
      const release = { ...stay(run), wait: wait.wait };
      return { release, at: wait.at };
    }
    captureException(error, { tags: { component: 'research', 'research.stage': run.stage } });
    return failedOutcome(
      run,
      scrubUrl(error instanceof Error ? error.message : String(error)),
      now(),
    );
  }
}

/** The release that keeps the run where it is: a wait leaves the streak and cursor alone. */
const stay = (run: ResearchRun) => ({
  stage: run.stage,
  cursor: run.cursor,
  consecutiveFailures: run.consecutiveFailures,
  limits: run.limits,
  error: run.error,
});

/** The HTTP status a delivery answers with (contract `POST /api/research/task`). */
export type DeliveryStatus = 200 | 500 | 503;

/**
 * Runs one delivery as its job's owner: claim, one batch, enqueue the next, commit. A stale delivery
 * answers 200, a held claim, early arrival or lost claim 503, and a failed enqueue 500 with nothing
 * written.
 */
export function runDelivery(delivery: Delivery, stages = STAGES): Promise<DeliveryStatus> {
  return withIdentity(delivery.uid, () => deliver(delivery, stages));
}

async function deliver(delivery: Delivery, stages: Stages): Promise<DeliveryStatus> {
  const claimed = await claim(delivery);
  if (claimed.kind === 'stale') return 200;
  if (claimed.kind === 'retry') return 503;
  const deadline = stepDeadline();
  const { run, token } = claimed;
  return await startSpan(
    {
      op: 'research.stage',
      name: `research ${run.stage}`,
      attributes: {
        'job.id': run.jobId,
        'research.stage': run.stage,
        'research.cursor': run.cursor,
      },
    },
    async () => {
      try {
        return await batchAndCommit(delivery, run, token, deadline, stages);
      } catch (error) {
        // Released, so the retry claims the run now rather than after the claim expires.
        await release(run, token);
        throw error;
      }
    },
  );
}

/** One batch under the claim, the next delivery enqueued, then the commit. */
async function batchAndCommit(
  delivery: Delivery,
  run: ResearchRun,
  token: string,
  deadline: number,
  stages: Stages,
): Promise<DeliveryStatus> {
  // The stage's I/O ends at its own deadline, so a slow read can't spend the enqueue and commit's.
  const outcome = await runBatch(run, deadline - RESERVE_MS, stages);
  const ends = outcome.release.stage === 'done' || outcome.release.stage === 'failed';
  // Enqueued before the commit, so no crash leaves a running run without a task.
  if (!ends) {
    try {
      await enqueue({ ...delivery, seq: delivery.seq + 1 }, outcome.at, deadline);
    } catch (error) {
      captureException(error, { tags: { component: 'research-queue' } });
      await release(run, token);
      return 500;
    }
  }
  const writes = outcome.writes;
  let committed: boolean;
  try {
    committed = await commit(run, token, outcome.release, writes && ((tx) => writes(tx, token)));
  } catch (error) {
    // 28000: the grant the batch read through changed before it saved (a disconnect, a
    // revocation or a reconnect). Its reports are dropped and the next delivery reads the
    // grant again; that is a wait, never a failure.
    if (pgCode(error) !== '28000') throw error;
    committed = await commit(run, token, { ...stay(run), wait: 'waiting on YouTube' });
  }
  // A lost claim wrote nothing and the next `seq` can't claim until this one commits, so this one
  // is redelivered: it reruns the batch, or finds a redelivery already committed and drops.
  return committed ? 200 : 503;
}
