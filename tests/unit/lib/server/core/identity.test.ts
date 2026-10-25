// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { currentIdentity, withIdentity } from '#lib/server/core/identity.js';

describe('identity', () => {
  it('has no identity outside an operation', () => {
    expect(currentIdentity()).toBeUndefined();
  });

  it('returns the operation result and restores the surrounding identity', () => {
    expect(withIdentity('alice', () => currentIdentity())).toBe('alice');
    expect(currentIdentity()).toBeUndefined();
  });

  it('preserves identity across asynchronous boundaries', async () => {
    const result = await withIdentity('alice', async () => {
      await Promise.resolve();
      return currentIdentity();
    });

    expect(result).toBe('alice');
    expect(currentIdentity()).toBeUndefined();
  });

  it('restores the parent after nested identities and signed-out operations', () => {
    withIdentity('alice', () => {
      expect(withIdentity('bob', () => currentIdentity())).toBe('bob');
      expect(currentIdentity()).toBe('alice');
      expect(withIdentity(undefined, () => currentIdentity())).toBeUndefined();
      expect(currentIdentity()).toBe('alice');
    });

    expect(currentIdentity()).toBeUndefined();
  });

  it('restores identity after a synchronous exception', () => {
    const error = new Error('operation failed');

    expect(() =>
      withIdentity('alice', () => {
        throw error;
      }),
    ).toThrow(error);
    expect(currentIdentity()).toBeUndefined();
  });

  it('restores identity after an asynchronous rejection', async () => {
    const error = new Error('operation failed');

    await expect(
      withIdentity('alice', async () => {
        await Promise.resolve();
        throw error;
      }),
    ).rejects.toBe(error);
    expect(currentIdentity()).toBeUndefined();
  });

  it('keeps overlapping operations isolated when they finish in reverse order', async () => {
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    const alice = withIdentity('alice', async () => {
      await paused;
      return currentIdentity();
    });

    const bob = await withIdentity('bob', async () => {
      await Promise.resolve();
      return currentIdentity();
    });
    resume();

    expect(bob).toBe('bob');
    expect(await alice).toBe('alice');
    expect(currentIdentity()).toBeUndefined();
  });
});
