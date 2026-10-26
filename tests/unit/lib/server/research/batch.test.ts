// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ModelBusy } from '#lib/server/ai/model.js';
import { eachItem, hasTime, RETRY_MS } from '#lib/server/research/batch.js';

const later = () => Date.now() + 110_000;
const ok = () => Promise.resolve(undefined);
/** Work that fails on `failing` with `error` and passes every other item. */
const failOn =
  (failing: number, error: Error) =>
  (item: number): Promise<undefined> =>
    item === failing ? Promise.reject(error) : ok();

describe('hasTime', () => {
  it('needs more than the item estimate before the stage deadline', () => {
    expect(hasTime(10_001, 10_000, 0)).toBe(true);
    expect(hasTime(10_000, 10_000, 0)).toBe(false);
  });
});

describe('eachItem', () => {
  it('works from `from` to the end', async () => {
    const seen: number[] = [];
    const items = await eachItem(['a', 'b', 'c'], 1, later(), 1_000, (_item, index) => {
      seen.push(index);
      return ok();
    });
    expect(seen).toEqual([1, 2]);
    expect(items).toEqual({ done: 2, next: 3, stopped: false });
  });

  it('ends early on stop, counting the item that stopped it', async () => {
    const items = await eachItem([1, 2, 3], 0, later(), 1_000, (item) =>
      Promise.resolve(item === 2 ? 'stop' : undefined),
    );
    expect(items).toEqual({ done: 2, next: 2, stopped: true });
  });

  it('takes nothing when the stage has no time for one more', async () => {
    const items = await eachItem([1], 0, Date.now() + 1_000, 1_000, ok);
    expect(items).toEqual({ done: 0, next: 0, stopped: false });
  });

  it('keeps the progress before a wait', async () => {
    const before = Date.now();
    const items = await eachItem([1, 2], 0, later(), 1_000, failOn(2, new ModelBusy('429')));
    expect(items).toMatchObject({ done: 1, next: 1, stopped: false, wait: { wait: 'model busy' } });
    expect(items.wait!.at).toBeGreaterThanOrEqual(before + RETRY_MS);
  });

  it('throws a wait that comes before any progress', async () => {
    await expect(
      eachItem([1], 0, later(), 1_000, failOn(1, new ModelBusy('429'))),
    ).rejects.toBeInstanceOf(ModelBusy);
  });

  it('throws an error that is not a wait, even after progress', async () => {
    await expect(eachItem([1, 2], 0, later(), 1_000, failOn(2, new Error('boom')))).rejects.toThrow(
      'boom',
    );
  });
});
