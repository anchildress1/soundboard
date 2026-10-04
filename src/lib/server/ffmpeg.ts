import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { startSpan } from '@sentry/sveltekit';
import type { Measurements, Probe, Reframe } from '$lib/types';

/** Gemma's audio input caps at 30 s; each analyze step reads one window this long. */
export const WINDOW_SEC = 29.5;
export const FRAMES_PER_WINDOW = 8;

const SILENCE_FILTER = 'silencedetect=n=-60dB:d=2';
// framelog=verbose keeps the per-frame lines out of stderr at the default log level. True peak is
// read from the float decode; astats runs after an s16 conversion so over-range samples clamp to
// full scale and its peak count becomes a clipped-sample count.
const MEASURE_FILTER = `ebur128=peak=true:framelog=verbose,aformat=sample_fmts=s16,astats=measure_perchannel=none:measure_overall=Peak_level+Peak_count,${SILENCE_FILTER}`;

/** No banner or progress lines: stderr carries only what the parsers read. */
const QUIET = ['-hide_banner', '-nostats'] as const;
const FILTER_GRAPH = '-filter_complex';

type RunResult = { stdout: Buffer; stderr: string; fd3: Buffer };

type Task = 'probe' | 'measure' | 'window' | 'loudness' | 'render';

/**
 * Runs ffmpeg or ffprobe inside a span named for the task. The arguments carry the signed source URL,
 * so they never reach the span.
 */
function run(task: Task, command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return startSpan(
    {
      op: 'process.ffmpeg',
      name: `${command} ${task}`,
      attributes: { 'process.executable.name': command, 'ffmpeg.task': task },
    },
    () => spawnRun(command, args, timeoutMs),
  );
}

function spawnRun(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(timeoutMs),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const fd3: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    (child.stdio[3] as Readable | null)?.on('data', (c: Buffer) => fd3.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`,
          ),
        );
        return;
      }
      resolve({ stdout: Buffer.concat(out), fd3: Buffer.concat(fd3), stderr });
    });
  });
}

type FfprobeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
};
type FfprobeJson = { format?: { duration?: string }; streams?: FfprobeStream[] };

/**
 * Phones store portrait video as landscape frames plus a rotation that players and YouTube apply,
 * so a quarter turn swaps the displayed width and height.
 */
function quarterTurned(video: FfprobeStream): boolean {
  const rotation =
    video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
    Number(video.tags?.rotate ?? 0);
  return Math.abs(rotation) % 180 === 90;
}

/** Duration, displayed video size (rotation applied), and audio presence. */
export function parseProbe(json: string): Probe {
  const data = JSON.parse(json) as FfprobeJson;
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const width = video?.width ?? null;
  const height = video?.height ?? null;
  const turned = video ? quarterTurned(video) : false;
  return {
    durationSec: Number(data.format?.duration ?? 0),
    width: turned ? height : width,
    height: turned ? width : height,
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === 'audio')),
  };
}

const num = (match: RegExpMatchArray | null): number | null => {
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

/**
 * Parses the ebur128 summary, astats overall block, and silencedetect lines from ffmpeg stderr.
 * Silence still open when the input ends is closed at `endSec`.
 */
export function parseMeasurements(stderr: string, offsetSec: number, endSec: number): Measurements {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const peakLevelDb = num(/Peak level dB:\s*(-?[\d.]+|-?inf)/.exec(stderr));
  const peakCount = num(/Peak count:\s*([\d.]+)/.exec(stderr)) ?? 0;
  const silences: Measurements['silences'] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (start) open = Number(start[1]);
    if (end) {
      silences.push({
        start: round(offsetSec + (open ?? 0)),
        end: round(offsetSec + Number(end[1])),
      });
      open = null;
    }
  }
  if (open !== null) silences.push({ start: round(offsetSec + open), end: round(endSec) });
  return {
    integratedLufs: num(/I:\s*(-?[\d.]+|-?inf) LUFS/.exec(summary)),
    truePeakDbtp: num(/Peak:\s*(-?[\d.]+|-?inf) dBFS/.exec(summary)),
    // astats counts how often the peak level recurs; that is clipping only when the peak is 0 dBFS.
    clippedSamples: peakLevelDb !== null && peakLevelDb >= -0.01 ? Math.round(peakCount) : 0,
    peakLevelDb,
    silences,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function probe(url: string): Promise<Probe> {
  const { stdout } = await run(
    'probe',
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url],
    60_000,
  );
  return parseProbe(stdout.toString('utf8'));
}

/** Whole-file loudness, true peak, clipping, and silence, reading the source by range requests. */
export async function measureFile(url: string, durationSec: number): Promise<Measurements> {
  const { stderr } = await run(
    'measure',
    'ffmpeg',
    [...QUIET, '-vn', '-i', url, FILTER_GRAPH, `[0:a:0]${MEASURE_FILTER}`, '-f', 'null', '-'],
    110_000,
  );
  return parseMeasurements(stderr, 0, durationSec);
}

export type Window = { wav: Buffer; frames: Buffer[]; measurements: Measurements };

/** Splits an MJPEG stream on JPEG start/end markers; ffmpeg's mjpeg encoder writes no EXIF thumbnails. */
export function splitJpegs(stream: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let start = stream.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  while (start !== -1) {
    const end = stream.indexOf(Buffer.from([0xff, 0xd9]), start + 3);
    if (end === -1) break;
    frames.push(stream.subarray(start, end + 2));
    start = stream.indexOf(Buffer.from([0xff, 0xd8, 0xff]), end + 2);
  }
  return frames;
}

/**
 * One pass over one window: 16 kHz mono WAV on stdout, 8 frames at 360p on fd 3, and the window's
 * measurements on stderr. Everything stays in memory; nothing is written to disk.
 */
export async function extractWindow(
  url: string,
  startSec: number,
  durationSec: number,
): Promise<Window> {
  const fps = (FRAMES_PER_WINDOW / durationSec).toFixed(4);
  const graph = [
    `[0:a:0]asplit=2[m][o]`,
    `[m]${MEASURE_FILTER}[ms]`,
    `[o]aresample=16000,aformat=channel_layouts=mono[a]`,
    `[0:v:0]fps=${fps},scale=-2:360[v]`,
  ].join(';');
  const { stdout, stderr, fd3 } = await run(
    'window',
    'ffmpeg',
    [
      ...QUIET,
      '-ss',
      startSec.toFixed(3),
      '-t',
      durationSec.toFixed(3),
      '-i',
      url,
      FILTER_GRAPH,
      graph,
      '-map',
      '[ms]',
      '-f',
      'null',
      '-',
      '-map',
      '[a]',
      '-f',
      'wav',
      'pipe:1',
      '-map',
      '[v]',
      '-frames:v',
      String(FRAMES_PER_WINDOW),
      '-c:v',
      'mjpeg',
      '-q:v',
      '5',
      '-f',
      'image2pipe',
      'pipe:3',
    ],
    60_000,
  );
  return {
    wav: stdout,
    frames: splitJpegs(fd3),
    measurements: parseMeasurements(stderr, startSec, startSec + durationSec),
  };
}

/** Window count covering the file; a trailing sliver under a second is not worth a model call. */
export function chunkCount(durationSec: number): number {
  return Math.max(1, Math.ceil((durationSec - 1) / WINDOW_SEC));
}

export type LoudnessPoint = { t: number; m: number };

/** ebur128's per-100 ms lines: time and momentary loudness, shifted to file time by `offsetSec`. */
export function parseLoudness(stderr: string, offsetSec: number): LoudnessPoint[] {
  const points: LoudnessPoint[] = [];
  for (const match of stderr.matchAll(/\bt:\s*([\d.]+)\s+TARGET:.*?\bM:\s*(-?[\d.]+|-?inf)/g)) {
    // Silence reads `-inf`; it is the gap a cut backs up to, so it stays in the curve.
    const m = Number(match[2]!.replace('inf', 'Infinity'));
    points.push({ t: round(offsetSec + Number(match[1])), m });
  }
  return points;
}

/** The loudness pass's own time limit. */
export const LOUDNESS_TIMEOUT_MS = 30_000;

/** Momentary loudness every 100 ms across one stretch of the source, read by range requests. */
export async function loudnessCurve(
  url: string,
  startSec: number,
  durationSec: number,
): Promise<LoudnessPoint[]> {
  const { stderr } = await run(
    'loudness',
    'ffmpeg',
    [
      ...QUIET,
      '-ss',
      startSec.toFixed(3),
      '-t',
      durationSec.toFixed(3),
      '-vn',
      '-i',
      url,
      FILTER_GRAPH,
      '[0:a:0]ebur128',
      '-f',
      'null',
      '-',
    ],
    LOUDNESS_TIMEOUT_MS,
  );
  return parseLoudness(stderr, startSec);
}

/** YouTube's recommended Shorts frame. */
export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;
const SHORT_FPS = 30;

/** Scales a frame to cover `w`x`h`, then crops the overflow from its center. */
const fill = (w: number, h: number) =>
  `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;

/**
 * Filter graph fitting any frame to 9:16. Blur fill keeps the whole frame over a blurred copy of
 * itself (blurred at quarter size, which is cheap and looks the same); crop fills the frame from
 * its center.
 */
export function shortFilter(reframe: Reframe): string {
  const [w, h] = [SHORT_WIDTH, SHORT_HEIGHT];
  if (reframe === 'crop') return `[0:v:0]fps=${SHORT_FPS},${fill(w, h)},setsar=1[v]`;
  return [
    `[0:v:0]fps=${SHORT_FPS},split=2[bg][fg]`,
    `[bg]${fill(w / 4, h / 4)},boxblur=8:2,scale=${w}:${h},setsar=1[b]`,
    `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[f]`,
    `[b][f]overlay=(W-w)/2:(H-h)/2[v]`,
  ].join(';');
}

/**
 * Cuts and reframes the Short from the source URL into a local MP4 with its index up front, so it
 * plays and seeks before it finishes loading. `veryfast` keeps a 60-second cut inside one step on
 * the app container's 2 vCPUs.
 */
export async function renderShort(
  sourceUrl: string,
  outPath: string,
  cut: { startSec: number; lengthSec: number; reframe: Reframe },
): Promise<void> {
  await run(
    'render',
    'ffmpeg',
    [
      ...QUIET,
      '-loglevel',
      'error',
      '-y',
      '-ss',
      cut.startSec.toFixed(3),
      '-t',
      cut.lengthSec.toFixed(3),
      '-i',
      sourceUrl,
      FILTER_GRAPH,
      shortFilter(cut.reframe),
      '-map',
      '[v]',
      '-map',
      '0:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '21',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outPath,
    ],
    100_000,
  );
}
