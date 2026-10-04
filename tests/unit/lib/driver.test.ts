import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api';
import { drive, ERROR_BACKOFF_MS, sleep, WAIT_MS, type DriverDeps } from '$lib/driver';
import type { JobState, JobView, Wait } from '$lib/types';

const view = (state: JobState, wait?: Wait): JobView => ({
  job: {
    state,
    id: 'j1',
    owner: 'visitor',
    channel: null,
    songTitle: 'PeekaBoo',
    notes: '',
    filename: 'peekaboo.mp4',
    sampleId: null,
    probe: null,
    measurements: null,
    chunkCount: 0,
    chunkIndex: 0,
    failedState: null,
    error: null,
    uploadProgress: null,
    videoId: null,
    payload: null,
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
    sleep: vi.fn(async () => {}),
    stopped: vi.fn(stopped),
    onView: vi.fn(),
    onError: vi.fn(),
  } satisfies DriverDeps;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('drive', () => {
  it('steps until the job leaves the driven states', async () => {
    const d = deps([view('ANALYZE'), view('PICK'), view('REVIEW')]);
    const final = await drive(view('PREP'), d);
    expect(final.job.state).toBe('REVIEW');
    expect(d.step).toHaveBeenCalledTimes(3);
    expect(d.onView).toHaveBeenCalledTimes(3);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('does not step a job that is not in a driven state', async () => {
    const d = deps([]);
    const initial = view('REVIEW');
    expect(await drive(initial, d)).toBe(initial);
    expect(d.step).not.toHaveBeenCalled();
  });

  it('sleeps for the named wait interval', async () => {
    const d = deps([
      view('ANALYZE', 'waking model'),
      view('PUBLISHING', 'waiting on YouTube'),
      view('VERIFIED'),
    ]);
    await drive(view('ANALYZE'), d);
    expect(d.sleep.mock.calls).toEqual([
      [WAIT_MS['waking model']],
      [WAIT_MS['waiting on YouTube']],
    ]);
  });

  it('backs off and retries after a request error', async () => {
    const d = deps([new ApiError(500, 'Internal'), new Error('offline'), view('REVIEW')]);
    const final = await drive(view('PICK'), d);
    expect(final.job.state).toBe('REVIEW');
    expect(d.onError.mock.calls).toEqual([['Internal'], ['offline']]);
    expect(d.sleep.mock.calls).toEqual([[ERROR_BACKOFF_MS], [ERROR_BACKOFF_MS]]);
  });

  it('reports a generic message for non-Error throws', async () => {
    const d = deps(['weird', view('REVIEW')]);
    await drive(view('PICK'), d);
    expect(d.onError).toHaveBeenCalledWith('Step failed');
  });

  it.each([404, 403])('stops on a %i without backing off', async (status) => {
    const d = deps([new ApiError(status, 'Job not found')]);
    const initial = view('ANALYZE');
    expect(await drive(initial, d)).toBe(initial);
    expect(d.onError).toHaveBeenCalledWith('Job not found');
    expect(d.sleep).not.toHaveBeenCalled();
    expect(d.step).toHaveBeenCalledTimes(1);
  });

  it('stops when the caller says so', async () => {
    let calls = 0;
    const d = deps([view('ANALYZE'), view('ANALYZE'), view('ANALYZE')], () => {
      calls += 1;
      return calls > 2;
    });
    const final = await drive(view('ANALYZE'), d);
    expect(d.step).toHaveBeenCalledTimes(2);
    expect(final.job.state).toBe('ANALYZE');
  });

  it('has an interval for every wait reason', () => {
    expect(Object.values(WAIT_MS).every((ms) => ms > 0)).toBe(true);
  });
});

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = sleep(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });
});
