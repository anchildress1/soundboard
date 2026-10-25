/** Thrown when a bounded call outlives its deadline. The message never names the call's target. */
export class DeadlineExceeded extends Error {
  constructor(what: string, ms: number) {
    super(`${what} took longer than ${ms} ms`);
  }
}

/** Milliseconds left for a call: `ms`, or less when the step's `deadline` (epoch ms) comes first. */
export const budget = (ms: number, deadline?: number): number =>
  Math.max(0, deadline === undefined ? ms : Math.min(ms, deadline - Date.now()));

/**
 * Settles with `work`, or rejects once `ms` pass. Google's SDKs retry for up to 600 s by default,
 * past any request, so every storage and KMS call on a request path goes through this.
 */
export async function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(what, ms)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
