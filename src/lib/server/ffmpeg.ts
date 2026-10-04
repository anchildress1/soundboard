import { spawn } from 'node:child_process';
import * as Sentry from '@sentry/sveltekit';
import type { Measurements, Probe } from '$lib/types';

/** Gemma's audio input caps at 30 s; each analyze step reads one window this long. */
export const WINDOW_SEC = 29.5;
export const FRAMES_PER_WINDOW = 8;

const SILENCE_FILTER = 'silencedetect=n=-60dB:d=2';
// framelog=verbose keeps the per-frame lines out of stderr at the default log level. True peak is
// read from the float decode; astats runs after an s16 conversion so over-range samples clamp to
// full scale and its peak count becomes a clipped-sample count.
const MEASURE_FILTER = `ebur128=peak=true:framelog=verbose,aformat=sample_fmts=s16,astats=measure_perchannel=none:measure_overall=Peak_level+Peak_count,${SILENCE_FILTER}`;

type RunResult = { stdout: Buffer; stderr: string; fd3: Buffer };

type Task = 'probe' | 'measure' | 'window';

/**
 * Runs ffmpeg or ffprobe inside a span named for the task. The arguments carry the signed source URL,
 * so they never reach the span.
 */
function run(task: Task, command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return Sentry.startSpan(
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
    (child.stdio[3] as NodeJS.ReadableStream | null)?.on('data', (c: Buffer) => fd3.push(c));
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
      resolve({ stdout: Buffer.concat(out), stderr, fd3: Buffer.concat(fd3) });
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
  const peakLevelDb = num(stderr.match(/Peak level dB:\s*(-?[\d.]+|-?inf)/));
  const peakCount = num(stderr.match(/Peak count:\s*([\d.]+)/)) ?? 0;
  const silences: Measurements['silences'] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    const end = line.match(/silence_end:\s*(-?[\d.]+)/);
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
    integratedLufs: num(summary.match(/I:\s*(-?[\d.]+|-?inf) LUFS/)),
    truePeakDbtp: num(summary.match(/Peak:\s*(-?[\d.]+|-?inf) dBFS/)),
    peakLevelDb,
    // astats counts how often the peak level recurs; that is clipping only when the peak is 0 dBFS.
    clippedSamples: peakLevelDb !== null && peakLevelDb >= -0.01 ? Math.round(peakCount) : 0,
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
    [
      '-hide_banner',
      '-nostats',
      '-vn',
      '-i',
      url,
      '-filter_complex',
      `[0:a:0]${MEASURE_FILTER}`,
      '-f',
      'null',
      '-',
    ],
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
      '-hide_banner',
      '-nostats',
      '-ss',
      startSec.toFixed(3),
      '-t',
      durationSec.toFixed(3),
      '-i',
      url,
      '-filter_complex',
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
