import { ApiError } from './api';
import { DRIVEN_STATES, type JobView, type Wait } from './types';

export const WAIT_MS: Record<Wait, number> = {
  'waking model': 5000,
  'waiting on another run': 4000,
  'step running in another tab': 4000,
  'waiting on YouTube': 5000,
};
export const ERROR_BACKOFF_MS = 5000;

export type DriverDeps = {
  step: () => Promise<JobView>;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
  onView: (view: JobView) => void;
  onError: (message: string) => void;
};

/**
 * Calls the next step until the job leaves the driven states. Waits sleep for their named interval;
 * request errors back off and retry, except a missing job, which ends the loop.
 */
export async function drive(initial: JobView, deps: DriverDeps): Promise<JobView> {
  let view = initial;
  while (!deps.stopped() && DRIVEN_STATES.includes(view.job.state)) {
    try {
      view = await deps.step();
      deps.onView(view);
      if (view.wait) await deps.sleep(WAIT_MS[view.wait]);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        deps.onError(error.message);
        break;
      }
      deps.onError(error instanceof Error ? error.message : 'Step failed');
      await deps.sleep(ERROR_BACKOFF_MS);
    }
  }
  return view;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
