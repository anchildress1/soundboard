import { percent } from './format';
import type { JobView, Wait } from './types';

export type Tone = 'info' | 'warn' | 'ok' | 'err';
export type Status = { tone: Tone; text: string; progress: number };

/** The state chip, bar, and label for a job. Chunk N/M or a named wait is always shown while running. */
export function jobStatus(view: JobView, wait?: Wait, uploadPct = 0): Status {
  const { job } = view;
  if (wait) return { tone: 'info', text: wait, progress: runningProgress(view) };
  switch (job.state) {
    case 'AWAITING_UPLOAD':
      return { tone: 'info', text: `Uploading ${uploadPct}%`, progress: uploadPct };
    case 'PREP':
      return { tone: 'info', text: 'Measuring audio', progress: 4 };
    case 'ANALYZE':
      return {
        tone: 'info',
        text: `Chunk ${Math.min(job.chunkIndex + 1, job.chunkCount)} / ${job.chunkCount}`,
        progress: runningProgress(view),
      };
    case 'PICK':
      return { tone: 'info', text: 'Smart pick', progress: 92 };
    case 'HOOK':
      return { tone: 'info', text: 'Picking the hook', progress: 30 };
    case 'RENDER':
      return { tone: 'info', text: 'Cutting the Short', progress: 60 };
    case 'REVIEW':
      return { tone: 'warn', text: 'Needs review', progress: 100 };
    case 'PUBLISHING': {
      const sent = job.uploadProgress
        ? percent(job.uploadProgress.sent, job.uploadProgress.total)
        : 0;
      return { tone: 'info', text: `Uploading to YouTube ${sent}%`, progress: sent };
    }
    case 'CLAIMED_COMPLETE':
      return { tone: 'info', text: 'Verifying upload', progress: 100 };
    case 'VERIFIED':
      return { tone: 'ok', text: 'Verified · private', progress: 100 };
    case 'PAYLOAD':
      return { tone: 'warn', text: 'Payload ready', progress: 100 };
    case 'FAILED':
      return { tone: 'err', text: 'Failed', progress: runningProgress(view) };
    case 'DISCARDED':
      return { tone: 'err', text: 'Discarded', progress: 0 };
  }
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

/** Seconds of the last model call, for the `gemma-4-12b-it · 12s` label. A Short's is its hook pick. */
export function lastModelSeconds(view: JobView): number | null {
  const ms = view.job.short
    ? view.job.short.modelMs
    : (view.pick?.modelMs ?? view.chunks.at(-1)?.modelMs);
  return ms ? Math.round(ms / 1000) : null;
}
