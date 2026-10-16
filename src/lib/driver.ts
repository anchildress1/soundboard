import pRetry, { AbortError } from 'p-retry';
import { ApiError } from './api';
import { POLL_BACKOFF, Waiting } from './retry';
import { DRIVEN_STATES, type JobView } from './types';

export type DriverDeps = {
  step: () => Promise<JobView>;
  stopped: () => boolean;
  onView: (view: JobView) => void;
  onError: (message: string) => void;
};

const driven = (view: JobView) => DRIVEN_STATES.includes(view.job.state);
const jobGone = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || error.status === 403);

/**
 * Calls the next step until the job leaves the driven states. A wait or a request error backs off
 * and retries; a missing job, a stop, or a non-network TypeError ends the loop.
 */
export async function drive(initial: JobView, deps: DriverDeps): Promise<JobView> {
  let view = initial;
  while (!deps.stopped() && driven(view)) {
    try {
      await pRetry(
        async () => {
          if (deps.stopped()) throw new AbortError('stopped');
          view = await deps.step();
          deps.onView(view);
          if (view.wait && driven(view)) throw new Waiting(view.wait);
        },
        {
          ...POLL_BACKOFF,
          retries: Infinity,
          onFailedAttempt: ({ error }) => {
            if (!(error instanceof Waiting)) deps.onError(error.message);
          },
          shouldRetry: ({ error }) => !jobGone(error),
        },
      );
    } catch {
      break;
    }
  }
  return view;
}
