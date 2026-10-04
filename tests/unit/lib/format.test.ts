import { describe, expect, it } from 'vitest';
import { ago, percent, resolution, timecode } from '$lib/format';

describe('timecode', () => {
  it('formats hours, minutes, and seconds', () => {
    expect(timecode(0)).toBe('00:00:00');
    expect(timecode(59.9)).toBe('00:00:59');
    expect(timecode(3725)).toBe('01:02:05');
    expect(timecode(36_000)).toBe('10:00:00');
  });

  it('clamps negative and non-finite input to zero', () => {
    expect(timecode(-4)).toBe('00:00:00');
    expect(timecode(Number.NaN)).toBe('00:00:00');
    expect(timecode(Number.POSITIVE_INFINITY)).toBe('00:00:00');
  });

  it('keeps counting hours past 99', () => {
    expect(timecode(100 * 3600)).toBe('100:00:00');
  });
});

describe('ago', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const daysBefore = (d: number) => new Date(now - d * 86_400_000).toISOString();

  it('buckets by day, week, and year', () => {
    expect(ago(daysBefore(0.5), now)).toBe('today');
    expect(ago(daysBefore(1), now)).toBe('1d ago');
    expect(ago(daysBefore(13), now)).toBe('13d ago');
    expect(ago(daysBefore(14), now)).toBe('2w ago');
    expect(ago(daysBefore(364), now)).toBe('52w ago');
    expect(ago(daysBefore(365), now)).toBe('1y ago');
    expect(ago(daysBefore(800), now)).toBe('2y ago');
  });

  it('calls a future date today', () => {
    expect(ago(daysBefore(-3), now)).toBe('today');
  });

  it('returns an empty string for missing or unparseable dates', () => {
    expect(ago(null, now)).toBe('');
    expect(ago('', now)).toBe('');
    expect(ago('not a date', now)).toBe('');
  });

  it('defaults to the current time', () => {
    expect(ago(new Date().toISOString())).toBe('today');
  });
});

describe('resolution', () => {
  it('labels the short side', () => {
    expect(resolution(1920, 1080)).toBe('1080p');
    expect(resolution(1080, 1080)).toBe('1080p');
  });

  it('marks a taller-than-wide video vertical', () => {
    expect(resolution(720, 1280)).toBe('720p · vertical');
  });

  it('falls back to the height without a width', () => {
    expect(resolution(null, 1080)).toBe('1080p');
  });

  it('is empty for missing or zero height', () => {
    expect(resolution(1920, null)).toBe('');
    expect(resolution(undefined, undefined)).toBe('');
    expect(resolution(0, 0)).toBe('');
  });
});

describe('percent', () => {
  it('rounds to a whole percent', () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(2, 3)).toBe(67);
  });

  it('caps at 100', () => {
    expect(percent(150, 100)).toBe(100);
  });

  it('is zero when the whole is zero or negative', () => {
    expect(percent(5, 0)).toBe(0);
    expect(percent(5, -1)).toBe(0);
  });
});
