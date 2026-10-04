/** Pipeline states. `CLAIMED_COMPLETE` comes from the insert response; only read-back sets `VERIFIED`. */
export type JobState =
  | 'AWAITING_UPLOAD'
  | 'PREP'
  | 'ANALYZE'
  | 'PICK'
  | 'REVIEW'
  | 'PUBLISHING'
  | 'CLAIMED_COMPLETE'
  | 'VERIFIED'
  | 'PAYLOAD'
  | 'FAILED'
  | 'DISCARDED';

/** Steps the status page drives with `POST /api/jobs/{id}/step`. */
export const DRIVEN_STATES: readonly JobState[] = [
  'PREP',
  'ANALYZE',
  'PICK',
  'PUBLISHING',
  'CLAIMED_COMPLETE',
];

/**
 * Who the job belongs to: allowlisted sessions own `nathan` jobs, demo sessions own `demo` jobs
 * (Nathan's memory read-only, sandbox channel), and everything else is a visitor job.
 */
export type JobOwner = 'nathan' | 'demo' | 'visitor';

/** Upload target: Nathan's channel, the throwaway sandbox channel, or none (ends at the would-be payload). */
export type Channel = 'nathan' | 'sandbox' | null;

export type Measurements = {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  peakLevelDb: number | null;
  clippedSamples: number;
  silences: { start: number; end: number }[];
};

export type Probe = {
  durationSec: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
};

export type ChunkAnalysis = {
  visual: string;
  music: {
    genre: string[];
    tempoFeel: string;
    instrumentation: string[];
    vocals: string;
    mood: string[];
  };
  qualityFlags: string[];
};

export type Chunk = {
  index: number;
  startSec: number;
  durationSec: number;
  measurements: Measurements;
  analysis: ChunkAnalysis | null;
  raw: string | null;
  modelMs: number;
};

export type PickFields = {
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
};

/** Copy for Bandcamp's track editor; artist accounts have no upload API, so Nathan pastes it. */
export type BandcampDraft = { about: string; credits: string };

export type Pick = PickFields & {
  version: number;
  flags: string[];
  brandCheck: string;
  why: { title: string; description: string; tags: string };
  bandcamp: BandcampDraft;
  modelMs: number;
};

export type Wait =
  'waking model' | 'waiting on another run' | 'step running in another tab' | 'waiting on YouTube';

/** The job as the browser sees it: no upload session URIs, claim tokens, or IP hashes. */
export type PublicJob = {
  id: string;
  state: JobState;
  owner: JobOwner;
  channel: Channel;
  songTitle: string;
  notes: string;
  filename: string;
  sampleId: string | null;
  probe: Probe | null;
  measurements: Measurements | null;
  chunkCount: number;
  chunkIndex: number;
  failedState: JobState | null;
  error: string | null;
  uploadProgress: { sent: number; total: number } | null;
  videoId: string | null;
  payload: PickFields | null;
  hashtagCandidates: string[] | null;
  createdAt: number;
};

export type JobView = {
  job: PublicJob;
  chunks: Chunk[];
  pick: Pick | null;
  wait?: Wait;
};

export type Sample = {
  id: string;
  songTitle: string;
  videoId: string;
  object: string;
  durationSec: number;
};

export type LiveMetadata = {
  videoId: string;
  title: string;
  description: string;
  tags: string[];
};
