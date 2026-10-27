// Research deliveries go through one Cloud Tasks queue to `POST /api/research/task` (research R2).
// The queue only delivers requests: each one runs a claimed batch in the app, like a page step.
import { captureException } from '@sentry/sveltekit';
import { GoogleAuth } from 'google-auth-library';
import { researchQueue } from '#lib/server/core/env.js';
import { budgetSignal, DeadlineSpent, outOfTime } from '#lib/server/platforms/youtube/index.js';
import type { Delivery } from './runs';

const TASKS_API = 'https://cloudtasks.googleapis.com/v2';
/** Under the 3-minute claim, so a delivery Cloud Tasks gave up on can't outlive its claim. */
const DISPATCH_DEADLINE = '180s';

let auth: GoogleAuth | undefined;

/** Resolves `work` or throws `DeadlineSpent` once `signal` aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DeadlineSpent());
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** The task name for one delivery: a retried enqueue of the same `seq` is deduplicated. */
const taskName = (queue: string, delivery: Delivery) =>
  `${queue}/tasks/${delivery.runId}-${delivery.seq}`;

/**
 * Schedules `delivery` for `at` (epoch ms; now or earlier means as soon as possible). The token
 * fetch and the request both end at the caller's step `deadline` (`DeadlineSpent`). An existing task
 * of the same name counts as enqueued. With no queue configured, dev runs the delivery in-process
 * and any other build throws.
 */
export async function enqueue(delivery: Delivery, at: number, deadline: number): Promise<void> {
  const config = researchQueue();
  if (!config) {
    if (!import.meta.env.DEV) throw new Error('RESEARCH_QUEUE is not configured.');
    inProcess(delivery, at);
    return;
  }
  const signal = budgetSignal(deadline);
  auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const token = await untilAborted(auth.getAccessToken(), signal);
  if (!token) throw new Error('No access token for Cloud Tasks.');
  const task = {
    name: taskName(config.queue, delivery),
    ...(at > Date.now() ? { scheduleTime: new Date(at).toISOString() } : {}),
    dispatchDeadline: DISPATCH_DEADLINE,
    httpRequest: {
      httpMethod: 'POST',
      url: config.url,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(delivery)).toString('base64'),
      oidcToken: { serviceAccountEmail: config.serviceAccount, audience: config.url },
    },
  };
  let response: Response;
  try {
    response = await fetch(`${TASKS_API}/${config.queue}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
      signal,
    });
  } catch (error) {
    throw outOfTime(error) ? new DeadlineSpent() : error;
  }
  if (response.ok || response.status === 409) return;
  throw new Error(`Cloud Tasks ${response.status}`);
}

/** Dev only: between in-process attempts, like the queue's backoff but short. */
const DEV_RETRY_MS = 1_000;
const DEV_ATTEMPTS = 20;

/**
 * Dev only: the delivery runs in this process after its delay, without the OIDC check. Anything but
 * a 200, a throw included, is retried as the queue would: the next `seq` can arrive before the
 * commit it follows.
 */
function inProcess(delivery: Delivery, at: number, attempt = 1): void {
  const retry = () => {
    if (attempt < DEV_ATTEMPTS) inProcess(delivery, Date.now() + DEV_RETRY_MS, attempt + 1);
  };
  setTimeout(
    () => {
      import('./delivery')
        .then(async ({ runDelivery }) => {
          if ((await runDelivery(delivery)) !== 200) retry();
        })
        .catch((error: unknown) => {
          captureException(error, { tags: { component: 'research' } });
          retry();
        });
    },
    Math.max(0, at - Date.now()),
  );
}
