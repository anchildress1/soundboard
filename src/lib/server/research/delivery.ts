// One Cloud Tasks delivery runs one claimed batch of the run's stage (research R2 steps 2–7).
import { captureException, startSpan } from '@sentry/sveltekit';
import { scrubUrl } from '#lib/scrub.js';
import { ModelBusy, ModelQuotaSpent, stepDeadline } from '#lib/server/ai/model.js';
import type { Tx } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { quotaResetAt } from '#lib/server/core/quota.js';
import { identityFailure, outOfTime, quotaSpent } from '#lib/server/platforms/youtube/index.js';
import { enqueue } from './queue';
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

/** Held back at the end of every delivery for the enqueue and the commit. */
export const RESERVE_MS = 8_000;
/** A busy provider, a spent step or a batch that did nothing tries again after this. */
export const RETRY_MS = 60_000;
/** Consecutive failed batches that end the run. */
const MAX_FAILURES = 2;

export type StageContext = { run: ResearchRun; deadline: number };

/** One batch's result, kept in memory until the commit. */
export type Batch = {
  /** Items finished this delivery. */
  done: number;
  /** Where the run goes next; the same stage while items remain. */
  stage: RunStage;
  cursor: number;
  limits?: ResearchLimit[];
  /** Set when the batch stopped on a wait after finishing `done` items. */
  wait?: Wait;
  /** Claim-checked writes for the commit; `token` is the delivery's claim. */
  writes?: (tx: Tx, token: string) => Promise<void>;
};

export type Stage = (context: StageContext) => Promise<Batch>;

type Wait = { wait: string; at: number };

/** Whether a stage can take one more item that takes about `estimateMs`. */
export const hasTime = (deadline: number, estimateMs: number, now = Date.now()) =>
  deadline - now > RESERVE_MS + estimateMs;

export type Stages = Record<Exclude<RunStage, 'done' | 'failed'>, Stage>;

// Placeholders until the learn (T037) and discover (T019) stages land.
const STAGES: Stages = {
  learn: async () => ({ done: 0, stage: 'discover', cursor: 0, limits: ['analytics-not-shared'] }),
  discover: async () => ({ done: 0, stage: 'done', cursor: 0, limits: ['no-peers'] }),
  match: async () => ({ done: 0, stage: 'done', cursor: 0 }),
  releases: async () => ({ done: 0, stage: 'done', cursor: 0 }),
};

/** A recognized wait, which never counts as a failure (constitution III), or null. */
function waitFor(error: unknown, now: number): Wait | null {
  if (error instanceof ModelQuotaSpent) return { wait: 'model quota spent', at: error.until };
  if (error instanceof ModelBusy) return { wait: 'model busy', at: now + RETRY_MS };
  // The YouTube quota is project-wide and daily: nothing gets through before it resets.
  if (quotaSpent(error)) return { wait: 'waiting on YouTube', at: quotaResetAt(now) };
  if (outOfTime(error) || identityFailure(error) === 'busy') {
    return { wait: 'waiting on YouTube', at: now + RETRY_MS };
  }
  return null;
}

type Outcome = { release: Release; at: number; writes?: Batch['writes'] };

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
 * answers 200, a held claim or early arrival 503, and a failed enqueue 500 with nothing written.
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
      const outcome = await runBatch(run, deadline, stages);
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
      await commit(run, token, outcome.release, writes && ((tx) => writes(tx, token)));
      return 200;
    },
  );
}
