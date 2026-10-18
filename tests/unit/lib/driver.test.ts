import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api';
import { drive, type DriverDeps } from '$lib/driver';
import { POLL_BACKOFF } from '$lib/retry';
import type { JobState, JobView, Wait } from '$lib/types';

const view = (state: JobState, wait?: Wait): JobView => ({
  job: {
    state,
    id: 'j1',
    parentId: null,
    destination: null,
    songTitle: 'PeekaBoo',
    notes: '',
    filename: 'peekaboo.mp4',
    probe: null,
    measurements: null,
    chunkCount: 0,
    chunkIndex: 0,
    failedState: null,
    error: null,
    uploadProgress: null,
    videoId: null,
    finalFields: null,
    hashtagCandidates: null,
    shortId: null,
    short: null,
    createdAt: 0,
  },
  chunks: [],
  pick: null,
  ...(wait ? { wait } : {}),
});

function deps(steps: (JobView | Error | string)[], stopped = () => false) {
  const queue = [...steps];
  return {
    step: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('no more steps');
      if (typeof next === 'string' || next instanceof Error) throw next;
      return next;
    }),
    stopped: vi.fn(stopped),
    onView: vi.fn(),
    onError: vi.fn(),
    signedOut: vi.fn(),
  } satisfies DriverDeps;
}

/** Runs the drive to completion under fake timers, returning the ms of backoff it slept. */
async function run(initial: JobView, d: DriverDeps) {
  const started = Date.now();
  const done = drive(initial, d);
  await vi.runAllTimersAsync();
  return { final: await done, slept: Date.now() - started };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('drive', () => {
  it('steps until the job leaves the driven states, without backing off', async () => {
    const d = deps([view('ANALYZE'), view('PICK'), view('REVIEW')]);
    const { final, slept } = await run(view('PREP'), d);
    expect(final.job.state).toBe('REVIEW');
    expect(d.step).toHaveBeenCalledTimes(3);
    expect(d.onView).toHaveBeenCalledTimes(3);
    expect(slept).toBe(0);
  });

  it('does not step a job that is not in a driven state', async () => {
    const d = deps([]);
    const initial = view('REVIEW');
    expect((await run(initial, d)).final).toBe(initial);
    expect(d.step).not.toHaveBeenCalled();
  });

  it('backs off exponentially through a run of waits without reporting an error', async () => {
    const d = deps([
      view('ANALYZE', 'waking model'),
      view('ANALYZE', 'waking model'),
      view('ANALYZE', 'waking model'),
      view('REVIEW'),
    ]);
    const { final, slept } = await run(view('ANALYZE'), d);
    expect(final.job.state).toBe('REVIEW');
    const { minTimeout, factor } = POLL_BACKOFF;
    expect(slept).toBe(minTimeout + minTimeout * factor + minTimeout * factor ** 2);
    expect(d.onView).toHaveBeenCalledTimes(4);
    expect(d.onError).not.toHaveBeenCalled();
  });

  it('caps the delay between calls during a long wait', async () => {
    const waits = Array.from({ length: 12 }, () => view('ANALYZE', 'waking model'));
    const d = deps([...waits, view('REVIEW')]);
    const done = drive(view('ANALYZE'), d);
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF.maxTimeout * 20);
    await done;
    expect(d.step).toHaveBeenCalledTimes(13);
  });

  it('starts the backoff over after a step makes progress', async () => {
    const d = deps([
      view('ANALYZE', 'waking model'),
      view('PICK'),
      view('PICK', 'waiting on another run'),
      view('REVIEW'),
    ]);
    const { slept } = await run(view('ANALYZE'), d);
    expect(slept).toBe(POLL_BACKOFF.minTimeout * 2);
  });

  it('does not back off on a wait that left the driven states', async () => {
    const d = deps([view('REVIEW', 'waiting on YouTube')]);
    const { final, slept } = await run(view('PUBLISHING'), d);
    expect(final.job.state).toBe('REVIEW');
    expect(slept).toBe(0);
  });

  it('reports request errors and retries them with backoff', async () => {
    const d = deps([new ApiError(500, 'Internal'), new Error('offline'), view('REVIEW')]);
    const { final, slept } = await run(view('PICK'), d);
    expect(final.job.state).toBe('REVIEW');
    expect(d.onError.mock.calls).toEqual([['Internal'], ['offline']]);
    expect(slept).toBe(POLL_BACKOFF.minTimeout * (1 + POLL_BACKOFF.factor));
  });

  it('retries a network failure', async () => {
    const d = deps([new TypeError('Failed to fetch'), view('REVIEW')]);
    expect((await run(view('PICK'), d)).final.job.state).toBe('REVIEW');
    expect(d.onError).toHaveBeenCalledWith('Failed to fetch');
  });

  it('reports and stops on a TypeError that is not a network failure', async () => {
    const d = deps([new TypeError('view.job is undefined'), view('REVIEW')]);
    const initial = view('PICK');
    const { final, slept } = await run(initial, d);
    expect(final).toBe(initial);
    expect(d.onError).toHaveBeenCalledWith('view.job is undefined');
    expect(d.step).toHaveBeenCalledTimes(1);
    expect(slept).toBe(0);
  });

  it.each([404, 403])('stops on a %i without backing off', async (status) => {
    const d = deps([new ApiError(status, 'Job not found')]);
    const initial = view('ANALYZE');
    const { final, slept } = await run(initial, d);
    expect(final).toBe(initial);
    expect(d.onError).toHaveBeenCalledWith('Job not found');
    expect(slept).toBe(0);
    expect(d.step).toHaveBeenCalledTimes(1);
    expect(d.signedOut).not.toHaveBeenCalled();
  });

  it('stops on a 401 at once and hands the page back to sign-in', async () => {
    const d = deps([new ApiError(401, 'Sign in first.')]);
    const { slept } = await run(view('ANALYZE'), d);
    expect(d.step).toHaveBeenCalledTimes(1);
    expect(d.signedOut).toHaveBeenCalledTimes(1);
    expect(slept).toBe(0);
  });

  it('signs out after earlier waits once a step 401s', async () => {
    const d = deps([view('ANALYZE', 'waking model'), new ApiError(401, 'Sign in first.')]);
    await run(view('ANALYZE'), d);
    expect(d.step).toHaveBeenCalledTimes(2);
    expect(d.signedOut).toHaveBeenCalledTimes(1);
  });

  it('stops when the caller says so between steps', async () => {
    let calls = 0;
    const d = deps([view('ANALYZE'), view('ANALYZE'), view('ANALYZE')], () => {
      calls += 1;
      return calls > 3;
    });
    const { final } = await run(view('ANALYZE'), d);
    expect(d.step).toHaveBeenCalledTimes(1);
    expect(final.job.state).toBe('ANALYZE');
  });

  it('stops during a wait without another step', async () => {
    let stop = false;
    const d = deps([view('ANALYZE', 'waking model'), view('REVIEW')], () => stop);
    const done = drive(view('ANALYZE'), d);
    await vi.advanceTimersByTimeAsync(0);
    stop = true;
    await vi.runAllTimersAsync();
    expect((await done).job.state).toBe('ANALYZE');
    expect(d.step).toHaveBeenCalledTimes(1);
    expect(d.onError).not.toHaveBeenCalled();
  });
});
