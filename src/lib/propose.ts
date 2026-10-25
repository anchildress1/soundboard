import pRetry, { AbortError } from 'p-retry';
import { proposeGuide, type GuideBody } from './api';
import type { GuideKind, Proposal } from './brand';
import { POLL_BACKOFF, Waiting } from './retry';
import { WAIT_TEXT } from './status';
import type { Wait } from './types';

/** A wait that asking again can't end: a spent quota (until `limitUntil`) or a lost grant. */
export class GuideWait extends Error {
  constructor(
    readonly wait: Wait,
    readonly limitUntil: number | null,
  ) {
    super(WAIT_TEXT[wait]);
  }
}

const POLLED = new Set<Wait>(['model busy', 'waiting on YouTube']);

/**
 * Asks for a proposal until one comes back, calling again with `POLL_BACKOFF` while the model or
 * YouTube is busy and telling `onWait`. Throws `GuideWait` on any other wait and the API error on a
 * refusal; null once `stopped` says the page was left.
 */
export async function proposeUntilReady<K extends GuideKind>(
  kind: K,
  onWait: (wait: Wait) => void,
  stopped: () => boolean,
): Promise<Proposal<GuideBody[K]> | null> {
  try {
    return await pRetry(
      async () => {
        if (stopped()) throw new AbortError(new Waiting('stopped'));
        const result = await proposeGuide(kind);
        if ('proposal' in result) return result.proposal;
        if (!POLLED.has(result.wait)) {
          throw new AbortError(new GuideWait(result.wait, result.limitUntil ?? null));
        }
        onWait(result.wait);
        throw new Waiting(result.wait);
      },
      {
        ...POLL_BACKOFF,
        retries: Infinity,
        // A failed model call is not retried on its own: each try is a paid call.
        shouldRetry: ({ error }) => error instanceof Waiting,
      },
    );
  } catch (error) {
    if (error instanceof Waiting) return null;
    throw error;
  }
}
