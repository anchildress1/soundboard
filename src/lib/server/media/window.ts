import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Measurements } from '#lib/types.js';
import { encodeClip, measureRange } from './ffmpeg';

/** The clip is sent inline; this leaves the request room for the prompt under Gemini's limit. */
export const MAX_CLIP_BYTES = 8_000_000;
const CUT_CAP_MS = 45_000;
const MEASURE_CAP_MS = 20_000;

/** The task's cap, cut short by the step's deadline; throws when nothing is left. */
function timeLeft(capMs: number, deadline: number): number {
  const ms = Math.min(capMs, deadline - Date.now());
  if (ms <= 0) throw new Error('The step ran out of time for the window.');
  return ms;
}

/**
 * Encodes `startSec`–`endSec` of the source to a temp MP4 and returns its path. The caller reads
 * and deletes it; on any failure here the file is already gone.
 */
export async function cutWindowClip(
  url: string,
  startSec: number,
  endSec: number,
  deadline: number,
): Promise<string> {
  const timeoutMs = timeLeft(CUT_CAP_MS, deadline);
  const path = join(tmpdir(), `window-${randomUUID()}.mp4`);
  try {
    await encodeClip(url, startSec, endSec - startSec, path, timeoutMs);
    const { size } = await stat(path);
    if (size === 0) throw new Error('The window clip came out empty.');
    if (size > MAX_CLIP_BYTES) {
      throw new Error(`The window clip is ${size} bytes, over the ${MAX_CLIP_BYTES}-byte limit.`);
    }
    return path;
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

/** ffmpeg's measurements of `startSec`–`endSec` of the source. */
export async function measureWindow(
  url: string,
  startSec: number,
  endSec: number,
  deadline: number,
): Promise<Measurements> {
  return await measureRange(url, startSec, endSec - startSec, timeLeft(MEASURE_CAP_MS, deadline));
}
