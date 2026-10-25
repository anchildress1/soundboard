// What a research stage returns, and the helpers every stage shares (research R2 "Batches").
import { ModelBusy, ModelQuotaSpent } from '#lib/server/ai/model.js';
import type { Tx } from '#lib/server/core/db.js';
import { quotaResetAt } from '#lib/server/core/quota.js';
import { identityFailure, outOfTime, quotaSpent } from '#lib/server/platforms/youtube/index.js';
import type { ResearchLimit, ResearchRun, RunStage } from './runs';

/** Held back at the end of every delivery for the enqueue and the commit. */
export const RESERVE_MS = 8_000;
/** A busy provider, a spent step or a batch that did nothing tries again after this. */
export const RETRY_MS = 60_000;
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

export type Wait = { wait: string; at: number };

/** Whether a stage can take one more item that takes about `estimateMs`. */
export const hasTime = (deadline: number, estimateMs: number, now = Date.now()) =>
  deadline - now > RESERVE_MS + estimateMs;

export type Items = { done: number; next: number; stopped: boolean; wait?: Wait };

/**
 * Runs `work` on `items` from index `from` while the step has time for one more. `work` returns
 * `'stop'` to end early. A wait after at least one item keeps the progress; before any, it throws
 * so the delivery records the wait.
 */
export async function eachItem<T>(
  items: T[],
  from: number,
  deadline: number,
  estimateMs: number,
  work: (item: T, index: number) => Promise<'stop' | undefined>,
): Promise<Items> {
  let next = from;
  while (next < items.length && hasTime(deadline, estimateMs)) {
    try {
      const result = await work(items[next]!, next);
      next += 1;
      if (result === 'stop') return { done: next - from, next, stopped: true };
    } catch (error) {
      const wait = next > from ? waitFor(error, Date.now()) : null;
      if (!wait) throw error;
      return { done: next - from, next, stopped: false, wait };
    }
  }
  return { done: next - from, next, stopped: false };
}

/** A recognized wait, which never counts as a failure (constitution III), or null. */
export function waitFor(error: unknown, now: number): Wait | null {
  if (error instanceof ModelQuotaSpent) return { wait: 'model quota spent', at: error.until };
  if (error instanceof ModelBusy) return { wait: 'model busy', at: now + RETRY_MS };
  // The YouTube quota is project-wide and daily: nothing gets through before it resets.
  if (quotaSpent(error)) return { wait: 'waiting on YouTube', at: quotaResetAt(now) };
  if (outOfTime(error) || identityFailure(error) === 'busy') {
    return { wait: 'waiting on YouTube', at: now + RETRY_MS };
  }
  return null;
}
