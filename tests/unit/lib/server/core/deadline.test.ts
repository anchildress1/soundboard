// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { budget, DeadlineExceeded, within } from '#lib/server/core/deadline.js';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('budget', () => {
  it('is the call budget without a deadline', () => {
    expect(budget(5000)).toBe(5000);
  });

  it('is what the deadline leaves when that is smaller', () => {
    expect(budget(5000, NOW + 2000)).toBe(2000);
    expect(budget(5000, NOW + 9000)).toBe(5000);
  });

  it('never goes negative past the deadline', () => {
    expect(budget(5000, NOW - 10)).toBe(0);
  });
});

describe('within', () => {
  it('settles with the work', async () => {
    await expect(within(1000, Promise.resolve('ok'), 'Work')).resolves.toBe('ok');
  });

  it('passes the work’s own rejection on', async () => {
    await expect(within(1000, Promise.reject(new Error('boom')), 'Work')).rejects.toThrow('boom');
  });

  it('rejects at the deadline with only the label in the message', async () => {
    const pending = within(1000, new Promise(() => {}), 'Reading the upload').catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;
    expect(error).toBeInstanceOf(DeadlineExceeded);
    expect((error as Error).message).toBe('Reading the upload took longer than 1000 ms');
  });

  it('leaves no timer behind once the work settles', async () => {
    await within(1000, Promise.resolve(1), 'Work');
    expect(vi.getTimerCount()).toBe(0);
  });
});
