// Peer evidence for the pick tests: three peers (next, same, two-up) with one release each.
import type { PeerEvidence } from '#lib/server/research/evidence.js';

const stats = (subscribers: number | null, hidden = false) => ({
  subscribers,
  hidden,
  videos: 40,
  views: 90_000,
});

export const PEER_TITLE = 'Neon Harbor';
export const COPIED = 'the static of a basement tape machine';

/** `P1` next-range and heard, `P2` same-range and heard, `P3` two-up, metadata-only and secondary. */
export function evidence(over: Partial<PeerEvidence> = {}): PeerEvidence {
  const peer = (n: number, title: string, relation: 'next' | 'same' | 'two-up') => ({
    ref: `P${n}`,
    channelId: `UC-peer-${n}`,
    title,
    basis: n === 3 ? ('metadata-only' as const) : ('heard' as const),
    explanation: `Same palette as the song, number ${n}.`,
    stats: stats(relation === 'next' ? 1200 : relation === 'same' ? 300 : 52_000),
    bracket:
      relation === 'next'
        ? (1000 as const)
        : relation === 'same'
          ? (100 as const)
          : (10000 as const),
    relation,
    secondary: relation === 'two-up',
  });
  const release = (n: number, title: string, description: string) => ({
    ref: `P${n}-R1`,
    peer: `P${n}`,
    videoId: `video-${n}`,
    title,
    description,
    tags: [`peer${n}tag`, 'synthwave'],
    hashtags: [`#peer${n}`],
    durationSec: 200,
    publishedAt: '2026-08-01T00:00:00.000Z',
    stats: { views: 1000, likes: 50, comments: 50 },
    selectedAs: 'newest' as const,
  });
  return {
    query: 'synthwave music',
    artist: { stats: stats(300), bracket: 100 },
    candidates: [1, 2, 3].map((n) => ({
      channelId: `UC-peer-${n}`,
      title: n === 1 ? PEER_TITLE : `Peer ${n}`,
      description: `Channel ${n} makes retro music.`,
      uploadsPlaylist: `UU-peer-${n}`,
      stats: stats(1000),
      bracket: 1000 as const,
      relation: 'next' as const,
    })),
    peers: [
      peer(1, PEER_TITLE, 'next'),
      peer(2, 'Velvet Static', 'same'),
      peer(3, 'Moonline Ghosts', 'two-up'),
    ],
    releases: [
      release(1, 'Night Drive', `Recorded in ${COPIED}. Out now.`),
      release(2, 'Glass Hours', 'Slow synth patterns for late evenings.'),
      release(3, 'Orbit Lines', 'A short instrumental sketch.'),
    ],
    skipped: [],
    ...over,
  };
}
