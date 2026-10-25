import { percent } from './format';
import type { JobState, JobView, PublicJob, Wait } from './types';

export type Tone = 'info' | 'warn' | 'ok' | 'err';
export type Status = { tone: Tone; text: string; progress: number };

type Label = (view: JobView, upload: UploadShown) => Status;

/** Why a browser upload is paused (data-model "Browser state"). */
export type PauseReason = 'offline' | 'stall' | 'no-reply' | 'timeout' | '408' | '429' | '5xx';

/**
 * What the job page shows for its upload. `pick` is a tab with no file, `saved` null when GCS
 * didn't say how much it has. `saved` and `total` are bytes GCS confirmed, not bytes sent.
 */
export type UploadShown =
  | { state: 'sending'; saved: number; total: number }
  | { state: 'paused'; reason: PauseReason; saved: number; total: number }
  | { state: 'pick'; saved: number | null; total: number }
  | { state: 'away'; saved: number; total: number }
  | { state: 'unreadable' | 'other-tab' | 'replaced' | 'moved' | 'discarded' };

/** One-off lines the page shows while sending, after the upload started over. */
export const UPLOAD_NOTICE = {
  'new-video': 'New video: starting the upload over.',
  renewed: 'The saved upload expired; starting again.',
} as const;

const PAUSE_TEXT: Record<PauseReason, string> = {
  offline: 'Upload paused: no connection',
  stall: 'Upload paused: no connection',
  'no-reply': 'Upload paused: no connection',
  timeout: 'Upload paused: no connection',
  '408': 'Upload paused: no connection',
  '429': 'Upload paused: storage busy, retrying',
  '5xx': 'Upload paused: storage busy, retrying',
};

/** `n` in the page states: whole percent, rounded down so 100 means every byte. */
export const savedPercent = (saved: number, total: number): number =>
  total > 0 ? Math.floor((saved / total) * 100) : 0;

function uploadStatus(upload: UploadShown): Status {
  switch (upload.state) {
    case 'sending': {
      const n = savedPercent(upload.saved, upload.total);
      return { tone: 'info', text: `Uploading ${n}%`, progress: n };
    }
    case 'paused':
      return {
        tone: 'warn',
        text: PAUSE_TEXT[upload.reason],
        progress: savedPercent(upload.saved, upload.total),
      };
    case 'pick': {
      if (upload.saved === null) {
        return { tone: 'warn', text: 'Pick the video to continue.', progress: 0 };
      }
      const n = savedPercent(upload.saved, upload.total);
      return {
        tone: 'warn',
        text: `Upload paused at ${n}%. Pick the video to continue.`,
        progress: n,
      };
    }
    case 'away':
      return {
        tone: 'warn',
        text: 'The upload paused while you were away.',
        progress: savedPercent(upload.saved, upload.total),
      };
    case 'unreadable':
      return { tone: 'err', text: "Couldn't read this video. Pick it again.", progress: 0 };
    case 'other-tab':
      return { tone: 'info', text: 'Uploading in another tab', progress: 0 };
    case 'replaced':
      return { tone: 'warn', text: 'A different video replaced this upload.', progress: 0 };
    case 'moved':
      return { tone: 'warn', text: 'The upload moved to another device or window.', progress: 0 };
    case 'discarded':
      return { tone: 'err', text: 'This job was discarded.', progress: 0 };
  }
}

/** Plain words for each wait, the same on every screen that shows one. */
export const WAIT_TEXT: Record<Wait, string> = {
  'model busy': 'Model busy',
  'model quota spent': 'Model quota spent',
  'step running in another tab': 'Running in another tab',
  'waiting on YouTube': 'Waiting on YouTube',
  'reconnect YouTube': 'Reconnect YouTube',
  'upload outcome unknown': 'Upload outcome unknown',
  'Daily upload limit reached. Try tomorrow.': 'Daily upload limit reached',
};

const fixed =
  (tone: Tone, text: string, progress: number): Label =>
  () => ({ tone, text, progress });

const LABELS: Record<JobState, Label> = {
  AWAITING_UPLOAD: (_view, upload) => uploadStatus(upload),
  PREP: fixed('info', 'Measuring audio', 4),
  ANALYZE: (view) => ({
    tone: 'info',
    text: `Window ${Math.min(view.job.chunkIndex + 1, view.job.chunkCount)} of ${view.job.chunkCount}`,
    progress: runningProgress(view),
  }),
  PICK: fixed('info', 'Smart pick', 92),
  HOOK: fixed('info', 'Picking the hook', 30),
  RENDER: fixed('info', 'Cutting the Short', 60),
  REVIEW: fixed('warn', 'Needs review', 100),
  PUBLISHING: ({ job }) => {
    const sent = job.uploadProgress
      ? percent(job.uploadProgress.sent, job.uploadProgress.total)
      : 0;
    return { tone: 'info', text: `Uploading to YouTube ${sent}%`, progress: sent };
  },
  CLAIMED_COMPLETE: fixed('info', 'Verifying upload', 100),
  VERIFIED: fixed('ok', 'Verified · private', 100),
  FAILED: (view) => ({ tone: 'err', text: 'Failed', progress: runningProgress(view) }),
  DISCARDED: fixed('err', 'Discarded', 0),
};

/** The state chip, bar, and label for a job: the named wait when there is one, else the state's. */
export function jobStatus(
  view: JobView,
  wait?: Wait,
  upload: UploadShown = { state: 'sending', saved: 0, total: 0 },
): Status {
  if (wait) return { tone: 'info', text: WAIT_TEXT[wait], progress: runningProgress(view) };
  return LABELS[view.job.state](view, upload);
}

/** The model role the job's current work uses; a failed job counts as the step it failed at. */
export function modelRole(
  job: Pick<PublicJob, 'state' | 'failedState' | 'short'>,
): 'analyst' | 'picker' {
  if (job.short) return 'picker';
  const state = job.state === 'FAILED' ? (job.failedState ?? 'PREP') : job.state;
  return state === 'PREP' || state === 'ANALYZE' ? 'analyst' : 'picker';
}

/** Names the configured model, never the one that produced earlier results. */
export const modelLabel = (view: JobView) => `Configured ${modelRole(view.job)}: ${view.model}`;

/** Whether publishing is paused for owner action and can be discarded. */
export function publishPaused({ job, wait }: JobView): boolean {
  return (
    (job.state === 'PUBLISHING' || job.state === 'CLAIMED_COMPLETE') &&
    (wait === 'reconnect YouTube' ||
      wait === 'upload outcome unknown' ||
      wait === 'Daily upload limit reached. Try tomorrow.')
  );
}

function runningProgress({ job }: JobView): number {
  if (job.chunkCount === 0) return 4;
  return 6 + Math.round((84 * job.chunkIndex) / job.chunkCount);
}

/** Perceptual tags from the chunk analysis, most frequent first. No numbers, no lyrics. */
export function heardTags(view: JobView, limit = 8): string[] {
  const counts = new Map<string, number>();
  const add = (value: string | undefined) => {
    const tag = value?.trim().toLowerCase();
    if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  };
  for (const chunk of view.chunks) {
    const music = chunk.analysis?.music;
    if (!music) continue;
    // Vocals is a free-text description ("none", "processed male vocals"), not a tag.
    for (const tag of [...music.genre, music.tempoFeel, ...music.instrumentation]) {
      add(tag);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

/**
 * Whether the pick's model call is running now. Only the pick ticks live: a pick step is almost all
 * model time, while a chunk step also spends seconds in ffmpeg and GCS, so a live clock there would
 * overshoot and jump back when the chunk's measured time lands.
 */
export function modelWorking(view: JobView): boolean {
  return view.job.state === 'PICK' && !view.wait;
}

/**
 * Seconds the model has spent on this job (every chunk plus the current pick), for the
 * `Total model time` label. `runningMs` adds the call still in flight so the label keeps counting.
 * A Short counts only its hook pick: its pick is the video's, copied.
 */
export function modelSeconds(view: JobView, runningMs = 0): number | null {
  const done = view.job.short
    ? view.job.short.modelMs
    : view.chunks.reduce((sum, chunk) => sum + chunk.modelMs, view.pick?.modelMs ?? 0);
  const ms = done + runningMs;
  return ms ? Math.round(ms / 1000) : null;
}
