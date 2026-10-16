import type { Options } from 'p-retry';

/** Every client poll backs off the same way: 2 s, doubling, capped at 30 s between calls. */
export const POLL_BACKOFF = {
  minTimeout: 2000,
  factor: 2,
  maxTimeout: 30_000,
} as const satisfies Options;

/** A bad model reply is asked again at once, one time: waiting doesn't change what it writes. */
export const REASK_ONCE = { retries: 1, minTimeout: 0 } as const satisfies Options;

/** Thrown by a poll whose answer is "not yet", so p-retry backs off and asks again. */
export class Waiting extends Error {}
