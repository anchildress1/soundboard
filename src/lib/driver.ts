import pRetry, { AbortError } from 'p-retry';
import { ApiError } from './api';
import { POLL_BACKOFF, Waiting } from './retry';
import { DRIVEN_STATES, type JobView } from './types';

export type DriverDeps = {
  step: () => Promise<JobView>;
  stopped: () => boolean;
  onView: (view: JobView) => void;
  onError: (message: string) => void;
  /** The session ended mid-run; the caller leaves the page for sign-in. */
  signedOut: () => void;
};

const driven = (view: JobView) => DRIVEN_STATES.includes(view.job.state);
const final = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);

/**
 * Calls the next step until the job leaves the driven states. A wait or a request error backs off
 * and retries; a missing job, a stop, or a non-network TypeError ends the loop. A 401 also hands
 * the page back to sign-in.
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
          shouldRetry: ({ error }) => !final(error),
        },
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) deps.signedOut();
      break;
    }
  }
  return view;
}
