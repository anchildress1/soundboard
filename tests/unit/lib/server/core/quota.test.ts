import { describe, expect, it } from 'vitest';
import { quotaResetAt } from '#lib/server/core/quota.js';

describe('quotaResetAt', () => {
  it.each([
    ['a winter afternoon', '2026-01-15T20:00:00Z', '2026-01-16T08:00:00Z'],
    ['a summer afternoon', '2026-07-15T19:00:00Z', '2026-07-16T07:00:00Z'],
    ['the day clocks spring forward', '2026-03-08T19:00:00Z', '2026-03-09T07:00:00Z'],
    ['the day before they spring forward', '2026-03-07T20:00:00Z', '2026-03-08T08:00:00Z'],
    ['the day clocks fall back', '2026-11-01T20:00:00Z', '2026-11-02T08:00:00Z'],
    ['the day before they fall back', '2026-10-31T19:00:00Z', '2026-11-01T07:00:00Z'],
    ['Pacific midnight itself', '2026-10-18T07:00:00Z', '2026-10-19T07:00:00Z'],
    ['the last second of a Pacific day', '2026-10-19T06:59:59.999Z', '2026-10-19T07:00:00Z'],
    ['a UTC date ahead of the Pacific one', '2026-12-31T23:30:00Z', '2027-01-01T08:00:00Z'],
  ])('resets at the next Pacific midnight on %s', (_label, now, reset) => {
    expect(new Date(quotaResetAt(Date.parse(now))).toISOString()).toBe(
      new Date(reset).toISOString(),
    );
  });
});
