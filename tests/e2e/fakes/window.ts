// Stands in for src/lib/server/media/window.ts in the E2E build, which runs no ffmpeg: the clip is a
// few dummy bytes in a temp file and the measurements are fixed, so analyze reaches the model call.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Measurements } from '$lib/types';

export const MAX_CLIP_BYTES = 8_000_000;

export async function cutWindowClip(): Promise<string> {
  const path = join(tmpdir(), `window-e2e-${randomUUID()}.mp4`);
  await writeFile(path, Buffer.from('e2e-clip'));
  return path;
}

export async function measureWindow(): Promise<Measurements> {
  return {
    integratedLufs: -14,
    truePeakDbtp: -1,
    peakLevelDb: -1.5,
    clippedSamples: 0,
    silences: [],
  };
}
