// Jobs the E2E server starts with. Each test owns its job IDs, so parallel tests and both
// Playwright projects never share mutable state.
import type { JobDoc } from '$lib/server/jobs';
import type { Chunk, Pick, Short } from '$lib/types';

const PROBE = { durationSec: 140, width: 1920, height: 1080, hasAudio: true };

const PICK: Pick = {
  version: 1,
  title: 'PeekaBoo (Official Video)',
  description: 'Night drive in a borrowed car.\n\n#synthwave #retrowave',
  hashtags: ['#synthwave', '#retrowave'],
  tags: ['synthwave', 'Flies Like Robots'],
  flags: [],
  brandCheck: '',
  why: { title: 'Matches the genre.', description: 'Plain.', tags: 'Genre first.' },
  bandcamp: { about: 'A night drive.', credits: 'Written by Flies Like Robots.' },
  modelMs: 12_000,
};

const chunk = (index: number): Chunk => ({
  index,
  startSec: index * 29.5,
  durationSec: 29.5,
  measurements: {
    integratedLufs: -14,
    truePeakDbtp: -1.2,
    peakLevelDb: -1.2,
    clippedSamples: 0,
    silences: [],
  },
  analysis: {
    visual: 'Neon streets at night.',
    music: {
      genre: ['synthwave'],
      tempoFeel: 'driving',
      instrumentation: ['analog synth'],
      vocals: 'male lead',
      mood: ['nostalgic'],
    },
    qualityFlags: [],
  },
  raw: null,
  modelMs: 4000,
});

function job(id: string, patch: Partial<JobDoc> = {}): JobDoc {
  return {
    id,
    state: 'REVIEW',
    owner: 'visitor',
    channel: null,
    songTitle: 'PeekaBoo',
    notes: '',
    filename: 'peekaboo.mp4',
    contentType: 'video/mp4',
    sampleId: null,
    liveVideoId: null,
    object: `uploads/${id}`,
    ipHash: 'e2e-ip',
    probe: PROBE,
    measurements: null,
    chunkCount: 5,
    chunkIndex: 5,
    failedState: null,
    error: null,
    uploadProgress: null,
    videoId: null,
    payload: null,
    consecutiveFailures: 0,
    claim: null,
    trace: null,
    hashtagCandidates: ['#synthwave', '#retrowave'],
    audience: {
      query: 'synthwave music video',
      hashtags: ['#synthwave', '#retrowave'],
      tags: [{ tag: 'synthwave', usedBy: 3 }],
      top: [],
    },
    upload: null,
    finalFields: null,
    pickVersion: 1,
    verifyAttempts: 0,
    shortId: null,
    short: null,
    sourceObject: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const SHORT: Short = {
  parentId: 'e2e-cut',
  sourceDurationSec: 140,
  reframe: 'blur',
  hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'The chorus lands with the full band.' },
  skipped: [],
  renders: 1,
  modelMs: 6000,
};

/** A video in review with its chunks and pick, ready for a Short. */
const reviewed = (id: string) => [job(id), PICK, [0, 1, 2, 3, 4].map(chunk)] as const;

export const SEED: { job: JobDoc; pick: Pick | null; chunks: Chunk[] }[] = [
  ...['e2e-tabs', 'e2e-make-chromium', 'e2e-make-mobile'].map((id) => {
    const [doc, pick, chunks] = reviewed(id);
    return { job: doc, pick, chunks: [...chunks] };
  }),
  {
    job: job('e2e-cut', { shortId: 'e2e-cut-short' }),
    pick: PICK,
    chunks: [0, 1, 2, 3, 4].map(chunk),
  },
  {
    job: job('e2e-cut-short', {
      filename: 'peekaboo (Short).mp4',
      object: 'uploads/e2e-cut-short-1',
      probe: { durationSec: 30, width: 1080, height: 1920, hasAudio: true },
      chunkCount: 0,
      chunkIndex: 0,
      sourceObject: 'uploads/e2e-cut',
      short: SHORT,
    }),
    pick: PICK,
    chunks: [],
  },
  {
    job: job('e2e-analyzing', { state: 'ANALYZE', chunkIndex: 1, pickVersion: null }),
    pick: null,
    chunks: [chunk(0)],
  },
];
