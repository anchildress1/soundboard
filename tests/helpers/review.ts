// A review's evidence as the page receives it, for the component and page tests.
import type { ReviewData, ReviewPeer } from '#lib/review.js';

export const PEER: ReviewPeer = {
  ref: 'P1',
  title: 'Neon Harbor',
  basis: 'heard',
  secondary: false,
  explanation: 'Same analog synth palette and driving tempo.',
  relation: 'next',
  stats: { subscribers: 1200, videos: 40, views: 90_000 },
  retrievedAt: '2026-10-20T12:00:00.000Z',
  releases: [
    {
      ref: 'P1-R1',
      title: 'Night Drive',
      url: 'https://www.youtube.com/watch?v=v-1',
      selectedAs: 'most-engaged',
      stats: { views: 1000, likes: 50, comments: 50 },
      engagement: { value: 0.1, calculated: true },
      publishedAt: '2026-08-01T00:00:00.000Z',
    },
  ],
};

export const SECOND_PEER: ReviewPeer = {
  ref: 'P2',
  title: 'Quiet Signal',
  basis: 'metadata-only',
  secondary: true,
  explanation: 'Similar tags.',
  relation: 'two-up',
  stats: { subscribers: 'hidden', videos: null, views: 4 },
  retrievedAt: '2026-10-20T12:00:00.000Z',
  releases: [],
};

export const REVIEW: ReviewData = {
  version: 1,
  recommendation: {
    approach: 'Open on the chorus.',
    intendedOutcome: 'More listeners reach the second minute.',
    follows: 'both',
    followsWhy: 'Your last release and two peers agree.',
    evidence: ['A1', 'P1'],
    limits: ['analytics-not-shared', 'something-new'],
  },
  evidence: [
    { ref: 'A1', label: 'Your result: Last Light' },
    { ref: 'P1', label: 'P1 · Neon Harbor' },
  ],
  influence: { sound: 1, feel: 0, wording: 0, discovery: 4, structure: 4 },
  influenceWarning: null,
  limits: ['analytics-not-shared', 'something-new'],
  ranges: { current: 100, target: 1000 },
  peers: [PEER, SECOND_PEER],
  evidenceExpiresAt: '2026-11-20T00:00:00.000Z',
  results: [
    {
      ref: 'A1',
      title: 'Last Light',
      requested: { start: '2026-08-31', end: '2026-09-27' },
      coverage: 'open',
      metrics: { views: 900, subscribersGained: 12, subscribersLost: 2 },
      net: { value: 10, calculated: true },
    },
  ],
  sources: {
    title: [{ ref: 'P1-R1', label: 'P1-R1 · Night Drive' }],
    description: [{ ref: 'voice', label: 'Your voice guide' }],
    tags: [{ ref: 'P1', expired: true, kind: 'peer', expiresAt: '2026-11-20T00:00:00.000Z' }],
  },
};
