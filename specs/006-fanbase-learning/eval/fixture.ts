// One fixed evidence set for the evaluation (research R15): three peers with distinct writing, their
// releases, and the artist's own results. Invented text; no real channel is named.
import { DEFAULT_INFLUENCE, type Influence } from '#lib/influence.js';
import type { PickContext, PickOutcome } from '#lib/server/ai/smart-pick.js';
import type { PeerEvidence } from '#lib/server/research/evidence.js';
import { releaseList, type CandidateList } from '#lib/server/pipeline/hashtags.js';
import type { Chunk } from '#lib/types.js';

const stats = (subscribers: number) => ({ subscribers, hidden: false, videos: 30, views: 80_000 });

const release = (
  n: number,
  title: string,
  description: string,
  tags: string[],
  hashtags: string[],
  [views, likes, comments]: [number, number, number],
) => ({
  ref: `P${n}-R1`,
  peer: `P${n}`,
  videoId: `video-${n}`,
  title,
  description,
  tags,
  hashtags,
  durationSec: 200,
  publishedAt: '2026-08-01T00:00:00.000Z',
  selectedAs: 'newest' as const,
  stats: { views, likes, comments },
});

export const EVIDENCE: PeerEvidence = {
  query: 'synthwave music',
  artist: { stats: stats(300), bracket: 100 },
  candidates: [
    ['UC-a', 'Harbor Lights', 'Slow synth music for night drives.'],
    ['UC-b', 'Velvet Static', 'Warm, hazy electronic sketches made at home.'],
    ['UC-c', 'Orbit Lines', 'Short instrumental pieces. New one every month.'],
  ].map(([channelId, title, description]) => ({
    channelId: channelId!,
    title: title!,
    description: description!,
    uploadsPlaylist: null,
    stats: stats(1500),
    bracket: 1000 as const,
    relation: 'next' as const,
  })),
  peers: [
    ['UC-a', 'Harbor Lights', 'next', false],
    ['UC-b', 'Velvet Static', 'next', false],
    ['UC-c', 'Orbit Lines', 'same', false],
  ].map(([channelId, title, relation, secondary], index) => ({
    ref: `P${index + 1}`,
    channelId: channelId as string,
    title: title as string,
    basis: 'metadata-only' as const,
    explanation: 'Analog synth leads over a steady drum machine, similar tempo.',
    stats: stats(1500),
    bracket: 1000 as const,
    relation: relation as 'next' | 'same',
    secondary: secondary as boolean,
  })),
  releases: [
    release(
      1,
      'Night Drive',
      'night drive. no vocals. just synth.\nrecorded in one take.\nfor the long road home.',
      ['synthwave', 'night drive', 'instrumental'],
      ['#synthwave', '#nightdrive'],
      [4200, 210, 30],
    ),
    release(
      2,
      'Glass Hours (Official Video)',
      'This one started as a loop I made on a rainy Sunday, and it slowly grew into something I did not expect. I hope it keeps you company on a quiet evening.\n\nMade with an old analog synth and a lot of patience.',
      ['electronic', 'ambient synth', 'analog synth'],
      ['#electronic', '#analogsynth'],
      [3100, 150, 44],
    ),
    release(
      3,
      'Orbit Lines #3',
      'Orbit Lines #3. Out now on all platforms. Link in the first comment.\n\n#instrumental #retro',
      ['instrumental', 'retro', 'synthwave'],
      ['#instrumental', '#retro'],
      [900, 40, 5],
    ),
  ],
  skipped: [],
};

const GENRE: CandidateList = {
  source: 'genre',
  ref: 'G1',
  videoId: 'genre-1',
  title: 'Retro synth mix',
  hashtags: ['#synthwave', '#retrowave', '#darksynth'],
  tags: ['synthwave', 'retrowave', 'darksynth', 'outrun'].map((tag) => ({ tag })),
};

export const CHUNK: Chunk = {
  index: 0,
  startSec: 0,
  durationSec: 59,
  measurements: {
    integratedLufs: -14,
    truePeakDbtp: -2,
    peakLevelDb: -2,
    clippedSamples: 0,
    silences: [],
  },
  analysis: {
    visual: 'A car driving through a neon-lit city at night.',
    music: {
      genre: ['synthwave'],
      tempoFeel: 'driving',
      instrumentation: ['analog synth', 'drum machine'],
      vocals: 'none',
      mood: ['nostalgic'],
    },
    qualityFlags: [],
  },
  raw: null,
  modelMs: 1,
};

const OUTCOME: PickOutcome = {
  ref: 'A1',
  videoId: 'own-1',
  suggested: {
    approach: 'Keep the title to the song name only.',
    intendedOutcome: 'More returning listeners.',
  },
  published: {
    title: 'Last Light',
    description: 'A slow one for the end of the day.',
    hashtags: ['#synthwave'],
    tags: ['synthwave'],
  },
  editedBeforeApproval: false,
  differsFromApproved: false,
  coverage: 'complete',
  window: { start: '2026-09-01', end: '2026-09-28' },
  metrics: { views: 900, subscribersGained: 12, subscribersLost: 2 },
  net: { value: 10, calculated: true },
  live: {
    title: 'Last Light',
    description: 'A slow one for the end of the day.',
    tags: ['synthwave'],
  },
};

/** Results that disagree with the peers: the peers use long titles, this one did well on a short title. */
const CONFLICTING: PickOutcome = {
  ...OUTCOME,
  suggested: {
    approach: 'Use a long descriptive title like the peers do.',
    intendedOutcome: 'More reach.',
  },
  published: {
    title: 'Last Light (Official Video)',
    description: 'A slow one for the end of the day.',
    hashtags: ['#synthwave'],
    tags: ['synthwave'],
  },
  editedBeforeApproval: true,
  metrics: { views: 200, subscribersGained: 1, subscribersLost: 3 },
  net: { value: -2, calculated: true },
};

export type Scenario = {
  name: string;
  influence: Influence;
  outcomes: PickOutcome[];
  limits: string[];
};

export const SCENARIOS: Scenario[] = [
  {
    name: 'every role at 0, results missing',
    influence: { sound: 0, feel: 0, wording: 0, discovery: 0, structure: 0 },
    outcomes: [],
    limits: ['analytics-not-shared'],
  },
  {
    name: 'every role at 2, results that conflict with the peers',
    influence: { sound: 2, feel: 2, wording: 2, discovery: 2, structure: 2 },
    outcomes: [CONFLICTING],
    limits: [],
  },
  {
    name: 'every role at 4, one successful adopted release',
    influence: { sound: 4, feel: 4, wording: 4, discovery: 4, structure: 4 },
    outcomes: [OUTCOME],
    limits: [],
  },
];

export function context(scenario: Scenario): PickContext {
  return {
    artist: { name: 'Test Artist', contactLine: null },
    songTitle: 'Last Exit',
    notes: 'Instrumental, recorded live in one take.',
    chunks: [CHUNK],
    measurements: null,
    probe: null,
    recent: [],
    candidateLists: [GENRE, ...EVIDENCE.releases.map(releaseList)],
    audience: [],
    facts: [{ key: 'artist-name', value: 'Test Artist', kind: 'FACT', public: true }],
    feedback: [],
    skipped: [],
    voice: null,
    brand: null,
    influence: scenario.influence ?? DEFAULT_INFLUENCE,
    evidence: EVIDENCE,
    outcomes: scenario.outcomes,
    limits: scenario.limits,
  };
}
