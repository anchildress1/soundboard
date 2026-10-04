import { percent } from './format';
import type { JobState, JobView, Wait } from './types';

export type Tone = 'info' | 'warn' | 'ok' | 'err';
export type Status = { tone: Tone; text: string; progress: number };

type Label = (view: JobView, uploadPct: number) => Status;

const fixed =
  (tone: Tone, text: string, progress: number): Label =>
  () => ({ tone, text, progress });

const LABELS: Record<JobState, Label> = {
  AWAITING_UPLOAD: (_view, uploadPct) => ({
    tone: 'info',
    text: `Uploading ${uploadPct}%`,
    progress: uploadPct,
  }),
  PREP: fixed('info', 'Measuring audio', 4),
  ANALYZE: (view) => ({
    tone: 'info',
    text: `Chunk ${Math.min(view.job.chunkIndex + 1, view.job.chunkCount)} / ${view.job.chunkCount}`,
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
  PAYLOAD: fixed('warn', 'Payload ready', 100),
  FAILED: (view) => ({ tone: 'err', text: 'Failed', progress: runningProgress(view) }),
  DISCARDED: fixed('err', 'Discarded', 0),
};

/** The state chip, bar, and label for a job. Chunk N/M or a named wait is always shown while running. */
export function jobStatus(view: JobView, wait?: Wait, uploadPct = 0): Status {
  if (wait) return { tone: 'info', text: wait, progress: runningProgress(view) };
  return LABELS[view.job.state](view, uploadPct);
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
 * `gemma-4-12b-it · 52s` label. `runningMs` adds the call still in flight so the label keeps counting.
 * A Short counts only its hook pick: its pick is the video's, copied.
 */
export function modelSeconds(view: JobView, runningMs = 0): number | null {
  const done = view.job.short
    ? view.job.short.modelMs
    : view.chunks.reduce((sum, chunk) => sum + chunk.modelMs, view.pick?.modelMs ?? 0);
  const ms = done + runningMs;
  return ms ? Math.round(ms / 1000) : null;
}
