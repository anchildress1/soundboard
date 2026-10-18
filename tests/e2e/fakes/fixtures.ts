// Users and jobs the E2E server starts with: user A (linked to FLR, YouTube connected) owns every
// job but `e2e-b-review`; user B is invited and unlinked. Each test owns its job IDs, so parallel tests and both
// Playwright projects never share mutable state.
import type { JobDoc } from '$lib/server/jobs/jobs';
import { jobRow } from '$lib/server/jobs/rows';
import type { Chunk, Pick, Short } from '$lib/types';
import type { Seed } from '../../helpers/db';
import { A_JOB, jobDoc, USER_B, USERS } from '../../helpers/pipeline';

const SYNTHWAVE = '#synthwave';
const RETROWAVE = '#retrowave';

const PROBE = { durationSec: 140, width: 1920, height: 1080, hasAudio: true };

const PICK: Pick = {
  version: 1,
  title: 'PeekaBoo (Official Video)',
  description: 'Night drive in a borrowed car.\n\n#synthwave #retrowave',
  hashtags: [SYNTHWAVE, RETROWAVE],
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
  return jobDoc({
    id,
    ...A_JOB,
    state: 'REVIEW',
    object: `uploads/${id}`,
    probe: PROBE,
    chunkCount: 5,
    chunkIndex: 5,
    consecutiveFailures: 0,
    hashtagCandidates: [SYNTHWAVE, RETROWAVE],
    audience: {
      query: 'synthwave music video',
      hashtags: [SYNTHWAVE, RETROWAVE],
      tags: [{ tag: 'synthwave', usedBy: 3 }],
      top: [],
    },
    pickVersion: 1,
    ...patch,
  });
}

const SHORT: Short = {
  sourceDurationSec: 140,
  reframe: 'blur',
  hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'The chorus lands with the full band.' },
  skipped: [],
  renders: 1,
  modelMs: 6000,
};

/** A video in review with its chunks and pick, ready for a Short. */
const reviewed = (id: string) => ({ job: job(id), pick: PICK, chunks: [0, 1, 2, 3, 4].map(chunk) });

const JOBS: { job: JobDoc; pick: Pick | null; chunks: Chunk[] }[] = [
  ...['e2e-tabs', 'e2e-make-chromium', 'e2e-make-mobile'].map(reviewed),
  { ...reviewed('e2e-cut'), job: job('e2e-cut', { shortId: 'e2e-cut-short' }) },
  {
    job: job('e2e-cut-short', {
      parentId: 'e2e-cut',
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
    job: job('e2e-b-review', { ownerUid: USER_B.uid, artistId: null, songTitle: 'Vaporgram' }),
    pick: { ...PICK, title: 'Vaporgram', tags: ['synthwave'] },
    chunks: [0, 1, 2, 3, 4].map(chunk),
  },
  {
    job: job('e2e-analyzing', { state: 'ANALYZE', chunkIndex: 1, pickVersion: null }),
    pick: null,
    chunks: [chunk(0)],
  },
];

/** Every row the E2E database starts with, in `seed()` order. */
export const SEED: Seed = {
  ...USERS,
  jobs: JOBS.map(({ job }) => jobRow(job)),
  jobPicks: JOBS.flatMap(({ job, pick }) =>
    pick ? [{ jobId: job.id, version: pick.version, data: { ...pick, skipped: false } }] : [],
  ),
  jobChunks: JOBS.flatMap(({ job, chunks }) =>
    chunks.map((c) => ({ jobId: job.id, index: c.index, data: c })),
  ),
};
