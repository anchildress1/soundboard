import { describe, expect, it } from 'vitest';
import { engagementRate, netSubscribers } from '#lib/server/research/calculated.js';

describe('netSubscribers', () => {
  it('is gained minus lost, labeled calculated', () => {
    expect(netSubscribers({ subscribersGained: 12, subscribersLost: 3 })).toEqual({
      value: 9,
      calculated: true,
    });
    expect(netSubscribers({ subscribersGained: 0, subscribersLost: 2 }).value).toBe(-2);
  });

  it.each([
    [null, 3],
    [12, null],
    [null, null],
  ])('is unknown when gained is %s or lost is %s', (gained, lost) => {
    expect(netSubscribers({ subscribersGained: gained, subscribersLost: lost })).toEqual({
      value: null,
      calculated: true,
    });
  });
});

describe('engagementRate', () => {
  it('is likes plus comments over views for one release', () => {
    expect(engagementRate({ views: 200, likes: 15, comments: 5 })).toEqual({
      value: 0.1,
      calculated: true,
    });
  });

  it.each([
    { views: 0, likes: 1, comments: 1 },
    { views: null, likes: 1, comments: 1 },
    { views: 10, likes: null, comments: 1 },
    { views: 10, likes: 1, comments: null },
  ])('is unknown for %o', (stats) => {
    expect(engagementRate(stats).value).toBeNull();
  });
});
