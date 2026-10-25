// Subscriber-count ranges (research R7): decade ranges, the same boundaries for the artist and every
// peer. A bracket is a pure function of the reported count, so a single viral release can't move it.

export const BRACKETS = [0, 100, 1000, 10000, 100000, 1000000] as const;

/** The lower bound of a decade range: [0,100) [100,1k) [1k,10k) [10k,100k) [100k,1M) [1M,∞). */
export type Bracket = (typeof BRACKETS)[number];

/** A peer's range against the artist's: the same, one up, or two up. */
export type Relation = 'same' | 'next' | 'two-up';

export const MAX_PEERS = 5;
const MIN_PEERS = 3;
const MAX_SECONDARY = 2;

/** The range a reported subscriber count falls in; null when hidden or missing. */
export function bracketOf(subscribers: number | null): Bracket | null {
  if (subscribers === null || !Number.isFinite(subscribers) || subscribers < 0) return null;
  return BRACKETS.findLast((low) => subscribers >= low)!;
}

/** How `peer`'s range sits against the `artist`'s; null when either is unknown. */
export function relation(artist: Bracket | null, peer: Bracket | null): Relation | 'other' | null {
  if (artist === null || peer === null) return null;
  const steps = BRACKETS.indexOf(peer) - BRACKETS.indexOf(artist);
  if (steps === 0) return 'same';
  if (steps === 1) return 'next';
  if (steps === 2) return 'two-up';
  return 'other';
}

/** The next range up from `artist`'s, for review's target; null at the top or when unknown. */
export function nextBracket(artist: Bracket | null): Bracket | null {
  if (artist === null) return null;
  return BRACKETS[BRACKETS.indexOf(artist) + 1] ?? null;
}

/**
 * The peers a pick learns from, in order: next-range first, up to 5. Under 3 of those, same-range
 * peers fill to 3 (`same-range-fallback`). Then up to 2 two-up peers as `secondary`, within 5.
 * Without the artist's range every relation is null, and the first 5 stand as they are.
 */
export function selectPeers<T extends { relation: Relation | null }>(
  kept: T[],
): { selected: (T & { secondary: boolean })[]; limits: string[] } {
  const primary = (peer: T) => ({ ...peer, secondary: false });
  if (kept.every((peer) => peer.relation === null)) {
    return { selected: kept.slice(0, MAX_PEERS).map(primary), limits: [] };
  }
  const of = (r: Relation) => kept.filter((peer) => peer.relation === r);
  const selected = of('next').slice(0, MAX_PEERS).map(primary);
  const limits: string[] = [];
  if (selected.length < MIN_PEERS) {
    const same = of('same').slice(0, MIN_PEERS - selected.length);
    if (same.length > 0) limits.push('same-range-fallback');
    selected.push(...same.map(primary));
  }
  const room = Math.min(MAX_SECONDARY, MAX_PEERS - selected.length);
  selected.push(
    ...of('two-up')
      .slice(0, room)
      .map((peer) => ({ ...peer, secondary: true })),
  );
  return { selected, limits };
}

/** The peer a `P<n>` or `P<n>-R<m>` ref names. */
export const peerOf = (ref: string): string => ref.split('-')[0]!;

/**
 * Whether a recommendation's evidence rests only on secondary (two-up) peers: every ref is one of
 * theirs. Two-up evidence may support a recommendation, never carry it alone.
 */
export function soleSecondary(
  evidence: string[],
  peers: { ref: string; secondary: boolean }[],
): boolean {
  const secondary = new Set(peers.filter((peer) => peer.secondary).map((peer) => peer.ref));
  return evidence.length > 0 && evidence.every((ref) => secondary.has(peerOf(ref)));
}
