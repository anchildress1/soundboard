/** Pipeline states. `CLAIMED_COMPLETE` comes from the insert response; only read-back sets `VERIFIED`. */
export const JOB_STATES = [
  'AWAITING_UPLOAD',
  'PREP',
  'ANALYZE',
  'PICK',
  'HOOK',
  'RENDER',
  'REVIEW',
  'PUBLISHING',
  'CLAIMED_COMPLETE',
  'VERIFIED',
  'FAILED',
  'DISCARDED',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** Steps the status page drives with `POST /api/jobs/{id}/step`. */
export const DRIVEN_STATES: readonly JobState[] = [
  'PREP',
  'ANALYZE',
  'PICK',
  'HOOK',
  'RENDER',
  'PUBLISHING',
  'CLAIMED_COMPLETE',
];

/** Video job states whose chunk analysis is finished, so a Short can be cut from them. */
export const SHORT_SOURCE_STATES: readonly JobState[] = [
  'REVIEW',
  'PUBLISHING',
  'CLAIMED_COMPLETE',
  'VERIFIED',
];

/** The YouTube channel an approval pins the upload to. */
export type Destination = { channelId: string; channelTitle: string | null };

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
  /** Model time across every pick run for this job, this one included. */
  modelMs: number;
};

/** How a landscape frame fits 9:16: a blurred copy of the frame behind it, or a center crop. */
export type Reframe = 'blur' | 'crop';

/** Where the Short is cut: the model picks the window and length, ffmpeg's loudness places the start. */
export type Hook = {
  window: number;
  startSec: number;
  lengthSec: number;
  /** Why the model picked it; cleared when the artist moves the cut. */
  reason: string;
};

/** A Short job's cut. Its metadata is the source video's pick, reviewed like any other. */
export type Short = {
  sourceDurationSec: number;
  reframe: Reframe;
  hook: Hook | null;
  /** Hooks re-picked away from, so the model offers a different one. */
  skipped: { window: number; lengthSec: number }[];
  renders: number;
  modelMs: number;
};

export type Wait =
  | 'waking model'
  | 'waiting on another run'
  | 'step running in another tab'
  | 'waiting on YouTube'
  | 'reconnect YouTube';

/** The job as the browser sees it: no owner, upload session URIs, or claim tokens. */
export type PublicJob = {
  id: string;
  state: JobState;
  /** `null` on videos, the parent's ID on Shorts. */
  parentId: string | null;
  destination: Destination | null;
  songTitle: string;
  notes: string;
  filename: string;
  probe: Probe | null;
  measurements: Measurements | null;
  chunkCount: number;
  chunkIndex: number;
  failedState: JobState | null;
  error: string | null;
  uploadProgress: { sent: number; total: number } | null;
  videoId: string | null;
  /** The approved fields, once approved. */
  finalFields: PickFields | null;
  hashtagCandidates: string[] | null;
  /** Set on a video job once a Short is cut from it. */
  shortId: string | null;
  /** Set only on a Short job. */
  short: Short | null;
  createdAt: number;
};

export type JobView = {
  job: PublicJob;
  chunks: Chunk[];
  pick: Pick | null;
  wait?: Wait;
  /** Signed playback URL of a rendered Short. */
  playbackUrl?: string;
};

export type LiveMetadata = {
  videoId: string;
  title: string;
  description: string;
  tags: string[];
};
