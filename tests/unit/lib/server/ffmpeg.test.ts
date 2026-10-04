// @vitest-environment node
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunkCount,
  extractWindow,
  FRAMES_PER_WINDOW,
  measureFile,
  parseMeasurements,
  parseProbe,
  probe,
  splitJpegs,
  WINDOW_SEC,
} from '$lib/server/ffmpeg';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const spawnMock = vi.mocked(spawn);

const STDERR = `[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:          -9.7 LUFS
    Threshold: -19.7 LUFS

  True peak:
    Peak:       -0.4 dBFS
[Parsed_astats_2 @ 0x2] Peak level dB: 0.000265
[Parsed_astats_2 @ 0x2] Peak count: 1146.000000
[silencedetect @ 0x3] silence_start: 4
[silencedetect @ 0x3] silence_end: 7 | silence_duration: 3
`;

type FakeRun = {
  stdout?: Buffer;
  stderr?: string;
  fd3?: Buffer;
  code?: number | null;
  error?: Error;
  noPipes?: boolean;
};

function fakeChild(run: FakeRun) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const fd3 = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdout: run.noPipes ? null : stdout,
    stderr: run.noPipes ? null : stderr,
    stdio: run.noPipes ? [null, null, null, null] : [null, stdout, stderr, fd3],
  });
  setImmediate(() => {
    if (run.error) {
      child.emit('error', run.error);
      return;
    }
    if (run.stdout) stdout.emit('data', run.stdout);
    if (run.stderr) stderr.emit('data', Buffer.from(run.stderr));
    if (run.fd3) fd3.emit('data', run.fd3);
    child.emit('close', run.code === undefined ? 0 : run.code);
  });
  return child;
}

function nextRun(run: FakeRun) {
  spawnMock.mockImplementationOnce((() => fakeChild(run)) as unknown as typeof spawn);
}

const jpeg = (body: number[]) => Buffer.from([0xff, 0xd8, 0xff, ...body, 0xff, 0xd9]);

beforeEach(() => {
  spawnMock.mockReset();
});

describe('parseProbe', () => {
  it('reads duration, video size, and audio presence', () => {
    const json = JSON.stringify({
      format: { duration: '183.42' },
      streams: [{ codec_type: 'audio' }, { codec_type: 'video', width: 1920, height: 1080 }],
    });
    expect(parseProbe(json)).toEqual({
      durationSec: 183.42,
      width: 1920,
      height: 1080,
      hasAudio: true,
    });
  });

  it('falls back to zero duration and null size when fields are missing', () => {
    expect(parseProbe('{}')).toEqual({
      durationSec: 0,
      width: null,
      height: null,
      hasAudio: false,
    });
  });

  it('reports a video without audio and a video stream without dimensions', () => {
    const json = JSON.stringify({ format: {}, streams: [{ codec_type: 'video' }] });
    expect(parseProbe(json)).toEqual({
      durationSec: 0,
      width: null,
      height: null,
      hasAudio: false,
    });
  });

  it('throws on malformed JSON', () => {
    expect(() => parseProbe('not json')).toThrow();
  });
});

describe('parseMeasurements', () => {
  it('parses the ebur128 summary, astats, and silences with the window offset', () => {
    expect(parseMeasurements(STDERR, 10, 39.5)).toEqual({
      integratedLufs: -9.7,
      truePeakDbtp: -0.4,
      peakLevelDb: 0.000265,
      clippedSamples: 1146,
      silences: [{ start: 14, end: 17 }],
    });
  });

  it('closes a silence still open at the end of the input at endSec', () => {
    const stderr = `${STDERR}[silencedetect @ 0x3] silence_start: 25.123\n`;
    const m = parseMeasurements(stderr, 0, 29.5);
    expect(m.silences).toEqual([
      { start: 4, end: 7 },
      { start: 25.12, end: 29.5 },
    ]);
  });

  it('treats a silence_end without a start as starting at the window offset', () => {
    const m = parseMeasurements(
      '[silencedetect @ 0x3] silence_end: 2.5 | silence_duration: 2.5\n',
      30,
      59.5,
    );
    expect(m.silences).toEqual([{ start: 30, end: 32.5 }]);
  });

  it('maps -inf loudness and level values to null and counts no clipping', () => {
    const stderr = [
      'Summary:',
      '    I:         -inf LUFS',
      '    Peak:      -inf dBFS',
      'Peak level dB: -inf',
      'Peak count: 22050.000000',
    ].join('\n');
    expect(parseMeasurements(stderr, 0, 10)).toEqual({
      integratedLufs: null,
      truePeakDbtp: null,
      peakLevelDb: null,
      clippedSamples: 0,
      silences: [],
    });
  });

  it('only counts peak recurrences as clipping at full scale', () => {
    const stderr = STDERR.replace('Peak level dB: 0.000265', 'Peak level dB: -3.200000');
    const m = parseMeasurements(stderr, 0, 30);
    expect(m.peakLevelDb).toBeCloseTo(-3.2);
    expect(m.clippedSamples).toBe(0);
  });

  it('treats a peak just under -0.01 dB as not clipped and -0.01 as clipped', () => {
    const at = (db: string) =>
      parseMeasurements(`Peak level dB: ${db}\nPeak count: 7.000000\n`, 0, 1).clippedSamples;
    expect(at('-0.010000')).toBe(7);
    expect(at('-0.020000')).toBe(0);
  });

  it('reads the last summary when ffmpeg prints more than one', () => {
    const stderr = `Summary:\n    I: -30.0 LUFS\n${STDERR}`;
    expect(parseMeasurements(stderr, 0, 30).integratedLufs).toBeCloseTo(-9.7);
  });

  it('returns nulls and no silences for empty stderr', () => {
    expect(parseMeasurements('', 0, 30)).toEqual({
      integratedLufs: null,
      truePeakDbtp: null,
      peakLevelDb: null,
      clippedSamples: 0,
      silences: [],
    });
  });
});

describe('splitJpegs', () => {
  it('splits back-to-back frames on SOI/EOI markers', () => {
    const a = jpeg([1, 2, 3]);
    const b = jpeg([4, 5]);
    const frames = splitJpegs(Buffer.concat([a, b]));
    expect(frames).toHaveLength(2);
    expect(Buffer.compare(frames[0]!, a)).toBe(0);
    expect(Buffer.compare(frames[1]!, b)).toBe(0);
  });

  it('skips leading garbage and drops a truncated trailing frame', () => {
    const a = jpeg([9]);
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
    const frames = splitJpegs(Buffer.concat([Buffer.from([0, 0, 0]), a, truncated]));
    expect(frames).toHaveLength(1);
    expect(Buffer.compare(frames[0]!, a)).toBe(0);
  });

  it('returns nothing for an empty or marker-free stream', () => {
    expect(splitJpegs(Buffer.alloc(0))).toEqual([]);
    expect(splitJpegs(Buffer.from([1, 2, 3, 4]))).toEqual([]);
  });
});

describe('chunkCount', () => {
  it('covers the file in 29.5 s windows', () => {
    expect(WINDOW_SEC).toBe(29.5);
    expect(chunkCount(60)).toBe(2);
    expect(chunkCount(183)).toBe(7);
  });

  it('ignores a trailing sliver under a second', () => {
    expect(chunkCount(30.5)).toBe(1);
    expect(chunkCount(31)).toBe(2);
  });

  it('never returns fewer than one window', () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(0.5)).toBe(1);
    expect(chunkCount(-5)).toBe(1);
  });
});

describe('probe', () => {
  it('runs ffprobe on the signed URL and parses its JSON', async () => {
    nextRun({
      stdout: Buffer.from(JSON.stringify({ format: { duration: '12.5' }, streams: [] })),
    });
    const result = await probe('https://storage.example/obj?sig=1');
    expect(result.durationSec).toBe(12.5);
    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe('ffprobe');
    expect(args).toContain('https://storage.example/obj?sig=1');
    expect(args).toContain('-show_streams');
    expect(options).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    expect((options as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects with the last three stderr lines on a non-zero exit', async () => {
    nextRun({ stderr: 'line1\nline2\nline3\nline4\n', code: 1 });
    await expect(probe('u')).rejects.toThrow('ffprobe exited 1: line2 | line3 | line4');
  });

  it('rejects when the process cannot spawn', async () => {
    nextRun({ error: new Error('spawn ffprobe ENOENT') });
    await expect(probe('u')).rejects.toThrow('ENOENT');
  });

  it('rejects when killed by a signal (null exit code)', async () => {
    nextRun({ stderr: 'aborted', code: null });
    await expect(probe('u')).rejects.toThrow('ffprobe exited null: aborted');
  });

  it('tolerates a child without piped streams', async () => {
    nextRun({ noPipes: true });
    await expect(probe('u')).rejects.toThrow(SyntaxError);
  });
});

describe('measureFile', () => {
  it('measures the whole file from offset zero', async () => {
    nextRun({ stderr: `${STDERR}[silencedetect @ 0x3] silence_start: 170\n` });
    const m = await measureFile('https://storage.example/obj', 183.2);
    expect(m.integratedLufs).toBeCloseTo(-9.7);
    expect(m.silences).toEqual([
      { start: 4, end: 7 },
      { start: 170, end: 183.2 },
    ]);
    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe('ffmpeg');
    expect(args).toEqual(
      expect.arrayContaining(['-vn', '-i', 'https://storage.example/obj', 'null']),
    );
    const graph = args![args!.indexOf('-filter_complex') + 1]!;
    expect(graph).toMatch(/^\[0:a:0\]ebur128=peak=true/);
    expect(graph).toContain('silencedetect=n=-60dB:d=2');
  });

  it('rejects on ffmpeg failure', async () => {
    nextRun({ stderr: 'Invalid data found when processing input', code: 183 });
    await expect(measureFile('u', 10)).rejects.toThrow(
      'ffmpeg exited 183: Invalid data found when processing input',
    );
  });
});

describe('extractWindow', () => {
  it('seeks the window and returns WAV, frames, and offset measurements', async () => {
    const wav = Buffer.from('RIFF....WAVE');
    const frames = Array.from({ length: FRAMES_PER_WINDOW }, (_, i) => jpeg([i]));
    nextRun({ stdout: wav, stderr: STDERR, fd3: Buffer.concat(frames) });

    const window = await extractWindow('https://storage.example/obj', 29.5, 29.5);

    expect(Buffer.compare(window.wav, wav)).toBe(0);
    expect(window.frames).toHaveLength(8);
    expect(window.measurements.silences).toEqual([{ start: 33.5, end: 36.5 }]);
    const args = spawnMock.mock.calls[0]![1]!;
    expect(args[args.indexOf('-ss') + 1]).toBe('29.500');
    expect(args[args.indexOf('-t') + 1]).toBe('29.500');
    expect(args).toContain('pipe:1');
    expect(args).toContain('pipe:3');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('8');
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('fps=0.2712');
    expect(graph).toContain('aresample=16000');
    expect(graph).toContain('scale=-2:360');
  });

  it('closes open silence at the end of the window', async () => {
    nextRun({ stderr: 'silence_start: 6\n' });
    const window = await extractWindow('u', 59, 10);
    expect(window.measurements.silences).toEqual([{ start: 65, end: 69 }]);
    expect(window.frames).toEqual([]);
    expect(window.wav).toHaveLength(0);
  });

  it('rejects on a non-zero exit', async () => {
    nextRun({ stderr: 'boom', code: 2 });
    await expect(extractWindow('u', 0, 29.5)).rejects.toThrow('ffmpeg exited 2: boom');
  });
});
