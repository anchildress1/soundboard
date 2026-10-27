import { describe, expect, it } from 'vitest';
import {
  bracketOf,
  nextBracket,
  peerOf,
  relation,
  selectPeers,
  soleSecondary,
  type Relation,
} from '#lib/server/research/brackets.js';

describe('bracketOf', () => {
  it.each([
    [0, 0],
    [99, 0],
    [100, 100],
    [999, 100],
    [1000, 1000],
    [9999, 1000],
    [10000, 10000],
    [100000, 100000],
    [999999, 100000],
    [1000000, 1000000],
    [50000000, 1000000],
  ])('puts %i in the range from %i', (count, low) => {
    expect(bracketOf(count)).toBe(low);
  });

  it.each([null, -1, Number.NaN])('is unknown for %s', (count) => {
    expect(bracketOf(count)).toBeNull();
  });

  it("can't move on one viral release: only the count decides", () => {
    // The same reported count gives the same range, whatever a single release did.
    expect(bracketOf(950)).toBe(bracketOf(950));
    expect(bracketOf(950)).toBe(100);
  });
});

describe('relation', () => {
  it.each([
    [100, 100, 'same'],
    [100, 1000, 'next'],
    [100, 10000, 'two-up'],
    [100, 100000, 'other'],
    [1000, 100, 'other'],
  ] as const)('artist %i, peer %i → %s', (artist, peer, expected) => {
    expect(relation(artist, peer)).toBe(expected);
  });

  it('is unknown when either range is', () => {
    expect(relation(null, 100)).toBeNull();
    expect(relation(100, null)).toBeNull();
  });

  it('names the target range, none past the top', () => {
    expect(nextBracket(100)).toBe(1000);
    expect(nextBracket(1000000)).toBeNull();
    expect(nextBracket(null)).toBeNull();
  });
});

describe('selectPeers', () => {
  const peers = (...relations: (Relation | null)[]) =>
    relations.map((r, i) => ({ id: `${r}-${i}`, relation: r }));
  const ids = (result: ReturnType<typeof selectPeers<{ id: string; relation: Relation | null }>>) =>
    result.selected.map((p) => [p.id, p.secondary]);

  it('takes next-range peers first, up to 5, and no same-range ones then', () => {
    const result = selectPeers(peers('same', 'next', 'next', 'next', 'next', 'next', 'next'));
    expect(ids(result)).toEqual([1, 2, 3, 4, 5].map((i) => [`next-${i}`, false]));
    expect(result.limits).toEqual([]);
  });

  it('fills to 3 from the same range with the fallback limit: 2 next + 4 same → 3 peers', () => {
    const result = selectPeers(peers('same', 'next', 'same', 'next', 'same', 'same'));
    expect(ids(result)).toEqual([
      ['next-1', false],
      ['next-3', false],
      ['same-0', false],
    ]);
    expect(result.limits).toEqual(['same-range-fallback']);
  });

  it('adds up to 2 two-up peers as secondary within 5', () => {
    const result = selectPeers(peers('two-up', 'next', 'next', 'next', 'two-up', 'two-up'));
    expect(ids(result)).toEqual([
      ['next-1', false],
      ['next-2', false],
      ['next-3', false],
      ['two-up-0', true],
      ['two-up-4', true],
    ]);
    const full = selectPeers(peers('next', 'next', 'next', 'next', 'two-up', 'two-up'));
    expect(full.selected.filter((p) => p.secondary)).toHaveLength(1);
  });

  it('keeps search order without the artist range', () => {
    const result = selectPeers(peers(null, null, null, null, null, null));
    expect(result.selected).toHaveLength(5);
    expect(result.selected.every((p) => !p.secondary)).toBe(true);
    expect(result.limits).toEqual([]);
  });

  it('selects nothing from nothing, and no fallback without same-range peers', () => {
    expect(selectPeers([])).toEqual({ selected: [], limits: [] });
    expect(selectPeers(peers('next')).limits).toEqual([]);
  });
});

describe('soleSecondary', () => {
  const PEERS = [
    { ref: 'P1', secondary: false },
    { ref: 'P2', secondary: true },
  ];

  it('is true only when every ref is a secondary peer or its release', () => {
    expect(soleSecondary(['P2', 'P2-R1'], PEERS)).toBe(true);
    expect(soleSecondary(['P2', 'P1-R1'], PEERS)).toBe(false);
    expect(soleSecondary(['P2', 'A1'], PEERS)).toBe(false);
    expect(soleSecondary([], PEERS)).toBe(false);
  });

  it('reads the peer from a release ref', () => {
    expect(peerOf('P3-R2')).toBe('P3');
    expect(peerOf('P3')).toBe('P3');
  });
});
