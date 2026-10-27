import { describe, expect, it } from 'vitest';
import {
  citationText,
  countLabel,
  dateLabel,
  limitText,
  netLabel,
  rangeLabel,
  rateLabel,
  sourceLabel,
} from '#lib/review.js';

describe('sourceLabel', () => {
  it.each([
    ['analysis', 'Song analysis'],
    ['voice', 'Your voice guide'],
    ['edits', 'Your past edits'],
    ['identity', 'Your recent uploads'],
    ['G3', 'Genre search G3'],
    ['mystery', 'mystery'],
  ])('names %s', (ref, label) => expect(sourceLabel(ref)).toBe(label));
});

describe('citationText', () => {
  it('shows a live source by its label', () => {
    expect(citationText({ ref: 'P1', label: 'P1 · Peer' })).toBe('P1 · Peer');
  });

  it('dates an expired peer by the expiry the pick recorded', () => {
    expect(
      citationText({
        ref: 'P1',
        expired: true,
        kind: 'peer',
        expiresAt: '2026-11-20T00:00:00.000Z',
      }),
    ).toBe('Peer evidence expired on Nov 20, 2026');
  });

  it('has no date to give when the pick recorded none', () => {
    expect(citationText({ ref: 'P1', expired: true, kind: 'peer', expiresAt: null })).toBe(
      'Peer evidence expired',
    );
  });

  it('says a result is no longer stored', () => {
    expect(citationText({ ref: 'A1', expired: true, kind: 'result', expiresAt: null })).toBe(
      'Result no longer stored',
    );
  });
});

describe('rangeLabel', () => {
  it.each([
    [0, '0–99'],
    [100, '100–999'],
    [1000, '1,000–9,999'],
    [10000, '10,000–99,999'],
    [100000, '100,000–999,999'],
    [1000000, '1,000,000 or more'],
  ] as const)('labels %i', (range, label) => expect(rangeLabel(range)).toBe(label));
});

describe('number labels', () => {
  it('shows reported counts, hidden counts and missing ones plainly', () => {
    expect(countLabel(12345)).toBe('12,345');
    expect(countLabel(0)).toBe('0');
    expect(countLabel('hidden')).toBe('hidden');
    expect(countLabel(null)).toBe('not reported');
  });

  it('shows a rate as a percentage and an unknown one as unknown', () => {
    expect(rateLabel({ value: 0.1, calculated: true })).toBe('10.0%');
    expect(rateLabel({ value: null, calculated: true })).toBe('unknown');
  });

  it('signs a net and keeps unknown unknown', () => {
    expect(netLabel({ value: 10, calculated: true })).toBe('+10');
    expect(netLabel({ value: -3, calculated: true })).toBe('-3');
    expect(netLabel({ value: 0, calculated: true })).toBe('0');
    expect(netLabel({ value: null, calculated: true })).toBe('unknown');
  });
});

describe('limitText', () => {
  it('turns a recorded code into a sentence', () => {
    expect(limitText('secondary-only')).toBe(
      'No recommendation: only secondary evidence supported it.',
    );
  });

  it('shows an unknown code as it is', () => {
    expect(limitText('something-new')).toBe('something-new');
  });
});

describe('dateLabel', () => {
  it('uses the stored UTC date', () => {
    expect(dateLabel('2026-11-20T23:30:00.000Z')).toBe('Nov 20, 2026');
  });
});
