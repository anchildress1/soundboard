import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuideWait, proposeUntilReady } from '#lib/propose.js';
import { POLL_BACKOFF } from '#lib/retry.js';

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROPOSAL = {
  id: 1,
  body: { rules: ['r'] },
  sources: { uploads: [], drafts: [], edits: 1, approvals: 0, thin: true },
  proposedAt: '2026-10-25T00:00:00.000Z',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('proposeUntilReady', () => {
  it('asks again after each busy wait, telling onWait, until the proposal comes back', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ wait: 'model busy' }))
      .mockResolvedValueOnce(json({ wait: 'waiting on YouTube' }))
      .mockResolvedValueOnce(json({ proposal: PROPOSAL }));
    const onWait = vi.fn();
    const result = proposeUntilReady('voice', onWait, () => false);
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF.minTimeout * 3);
    expect(await result).toEqual(PROPOSAL);
    expect(onWait.mock.calls).toEqual([['model busy'], ['waiting on YouTube']]);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(
      Array(3).fill('/api/guides/voice/propose'),
    );
  });

  it.each([
    [{ wait: 'model quota spent', limitUntil: 99 }, 'model quota spent', 99],
    [{ wait: 'reconnect YouTube' }, 'reconnect YouTube', null],
  ])('stops on a wait asking again cannot end (%j)', async (answer, wait, limitUntil) => {
    fetchMock.mockResolvedValue(json(answer));
    const error = await proposeUntilReady('brand', vi.fn(), () => false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuideWait);
    expect(error).toMatchObject({ wait, limitUntil });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws a refusal at once, never paying for a second model call', async () => {
    fetchMock.mockResolvedValue(json({ message: 'The model reply did not parse.' }, 502));
    await expect(proposeUntilReady('voice', vi.fn(), () => false)).rejects.toMatchObject({
      status: 502,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('answers null once the page is left mid-wait, with no further call', async () => {
    let stopped = false;
    fetchMock.mockResolvedValue(json({ wait: 'model busy' }));
    const result = proposeUntilReady('voice', vi.fn(), () => stopped);
    await vi.advanceTimersByTimeAsync(0);
    stopped = true;
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF.minTimeout);
    expect(await result).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
