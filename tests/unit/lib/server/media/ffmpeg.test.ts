// @vitest-environment node
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { startSpan } from '../../../../mocks/sentry';
import {
  chunkCount,
  encodeClip,
  loudnessCurve,
  measureFile,
  measureRange,
  parseLoudness,
  parseMeasurements,
  parseProbe,
  probe,
  renderShort,
  SHORT_HEIGHT,
  SHORT_WIDTH,
  shortFilter,
} from '$lib/server/media/ffmpeg';

const SIGNED_OBJECT_URL = 'https://storage.example/obj?X-Goog-Signature=secret';
const FFMPEG_OP = 'process.ffmpeg';
const OBJECT_URL = 'https://storage.example/obj';
const FILTER_GRAPH = '-filter_complex';
const RENDER_MS = 80_000;

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
  code?: number | null;
  error?: Error;
  /** A started process: an error (an abort) is followed by its exit, as with a real kill. */
  started?: boolean;
  noPipes?: boolean;
};

function fakeChild(run: FakeRun) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    pid: run.started ? 4242 : undefined,
    stdout: run.noPipes ? null : stdout,
    stderr: run.noPipes ? null : stderr,
  });
  setImmediate(() => {
    if (run.error) {
      child.emit('error', run.error);
      if (!run.started) return;
    }
    if (run.stdout) stdout.emit('data', run.stdout);
    if (run.stderr) stderr.emit('data', Buffer.from(run.stderr));
    setImmediate(() => child.emit('close', run.code === undefined ? 0 : run.code));
  });
  return child;
}

function nextRun(run: FakeRun) {
  spawnMock.mockImplementationOnce((() => fakeChild(run)) as unknown as typeof spawn);
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('source input restrictions', () => {
  it.each([
    ['probe', () => probe(OBJECT_URL)],
    ['measure', () => measureFile(OBJECT_URL, 1)],
    ['measure range', () => measureRange(OBJECT_URL, 0, 1, 1000)],
    ['clip', () => encodeClip(OBJECT_URL, 0, 1, 'clip.mp4', 1000)],
    ['loudness', () => loudnessCurve(OBJECT_URL, 0, 1)],
    [
      'render',
      () =>
        renderShort(
          OBJECT_URL,
          'out.mp4',
          { startSec: 0, lengthSec: 1, reframe: 'crop' },
          RENDER_MS,
        ),
    ],
  ])('restricts %s before opening uploaded bytes', async (_task, invoke) => {
    nextRun({ stdout: Buffer.from('{}') });
    await invoke();

    const args = spawnMock.mock.calls[0]![1]!;
    const inputIndex = args.indexOf(OBJECT_URL);
    const formatsIndex = args.indexOf('-format_whitelist');
    const protocolsIndex = args.indexOf('-protocol_whitelist');
    expect(formatsIndex).toBeGreaterThan(-1);
    expect(protocolsIndex).toBeGreaterThan(-1);
    expect(formatsIndex).toBeLessThan(inputIndex);
    expect(protocolsIndex).toBeLessThan(inputIndex);
    const formats = args[formatsIndex + 1]!.split(',');
    expect(formats).toEqual([
      'mov',
      'matroska',
      'webm',
      'avi',
      'asf',
      'flv',
      'mpeg',
      'mpegts',
      'ogg',
    ]);
    for (const manifest of ['hls', 'dash', 'concat', 'sdp', 'image2']) {
      expect(formats).not.toContain(manifest);
    }
    expect(args[protocolsIndex + 1]).toBe('https,tls,tcp');
    // These MOV-only switches cause ffmpeg to reject ordinary WebM input.
    expect(args).not.toContain('-enable_drefs');
    expect(args).not.toContain('-use_absolute_path');
    expect(args.filter((arg) => arg === OBJECT_URL)).toHaveLength(1);
  });
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

  it('applies a quarter-turn rotation from the display matrix or the rotate tag', () => {
    const turned = (stream: object) =>
      parseProbe(
        JSON.stringify({
          format: { duration: '79' },
          streams: [{ codec_type: 'video', width: 1280, height: 720, ...stream }],
        }),
      );
    expect(turned({ side_data_list: [{ rotation: -90 }] })).toMatchObject({
      width: 720,
      height: 1280,
    });
    expect(turned({ tags: { rotate: '270' } })).toMatchObject({ width: 720, height: 1280 });
    expect(turned({ side_data_list: [{ rotation: 180 }] })).toMatchObject({
      width: 1280,
      height: 720,
    });
    expect(turned({ side_data_list: [{}] })).toMatchObject({ width: 1280, height: 720 });
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

describe('chunkCount', () => {
  it('covers the file in 60 s windows', () => {
    expect(chunkCount(60)).toBe(1);
    expect(chunkCount(61.5)).toBe(2);
    expect(chunkCount(900)).toBe(15);
  });

  it('ignores a trailing sliver under a second', () => {
    expect(chunkCount(60.5)).toBe(1);
    expect(chunkCount(61)).toBe(1);
    expect(chunkCount(121.5)).toBe(3);
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
    expect(options).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
    expect((options as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects with the last three stderr lines on a non-zero exit', async () => {
    nextRun({ stderr: 'line1\nline2\nline3\nline4\n', code: 1 });
    await expect(probe('u')).rejects.toThrow('ffprobe exited 1: line2 | line3 | line4');
  });

  it('runs for up to 60 s by default, or for the limit it is given', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    onTestFinished(() => timeout.mockRestore());
    const json = Buffer.from(JSON.stringify({ format: { duration: '1' }, streams: [] }));
    nextRun({ stdout: json });
    await probe('u');
    nextRun({ stdout: json });
    await probe('u', 10_000);
    expect(timeout.mock.calls).toEqual([[60_000], [10_000]]);
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

describe('ffmpeg spans', () => {
  const PROBE_JSON = JSON.stringify({ format: { duration: '10' }, streams: [] });

  it('opens one span per task, named for it, without the signed URL', async () => {
    startSpan.mockClear();
    nextRun({ stdout: Buffer.from(PROBE_JSON) });
    nextRun({ stderr: '' });
    nextRun({ stderr: '' });
    await probe(SIGNED_OBJECT_URL);
    await measureFile(SIGNED_OBJECT_URL, 10);
    await encodeClip(SIGNED_OBJECT_URL, 0, 10, '/tmp/w.mp4', 1000);
    const spans = startSpan.mock.calls.map(([options]) => options as { op: string; name: string });
    expect(spans.map((s) => [s.op, s.name])).toEqual([
      [FFMPEG_OP, 'ffprobe probe'],
      [FFMPEG_OP, 'ffmpeg measure'],
      [FFMPEG_OP, 'ffmpeg clip'],
    ]);
    expect(JSON.stringify(spans)).not.toContain('Signature');
  });

  it('lets a failed run reject through its span', async () => {
    nextRun({ code: 1, stderr: 'boom' });
    await expect(measureFile('u', 10)).rejects.toThrow();
  });
});

describe('measureFile', () => {
  it('measures the whole file from offset zero', async () => {
    nextRun({ stderr: `${STDERR}[silencedetect @ 0x3] silence_start: 170\n` });
    const m = await measureFile(OBJECT_URL, 183.2);
    expect(m.integratedLufs).toBeCloseTo(-9.7);
    expect(m.silences).toEqual([
      { start: 4, end: 7 },
      { start: 170, end: 183.2 },
    ]);
    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe('ffmpeg');
    expect(args).toEqual(expect.arrayContaining(['-vn', '-i', OBJECT_URL, 'null']));
    const graph = args![args!.indexOf(FILTER_GRAPH) + 1]!;
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

describe('measureRange', () => {
  it('measures one stretch of audio, shifted to file time', async () => {
    nextRun({ stderr: STDERR });
    const measurements = await measureRange(OBJECT_URL, 60, 60, 20_000);
    expect(measurements.silences).toEqual([{ start: 64, end: 67 }]);
    expect(measurements.integratedLufs).toBe(-9.7);
    const args = spawnMock.mock.calls[0]![1]!;
    expect(args[args.indexOf('-ss') + 1]).toBe('60.000');
    expect(args[args.indexOf('-t') + 1]).toBe('60.000');
    expect(args).toContain('-vn');
    expect(args[args.indexOf(FILTER_GRAPH) + 1]).toMatch(/^\[0:a:0\]ebur128=peak=true/);
  });

  it('closes open silence at the end of the stretch', async () => {
    nextRun({ stderr: 'silence_start: 6\n' });
    expect((await measureRange('u', 59, 10, 1000)).silences).toEqual([{ start: 65, end: 69 }]);
  });

  it("gives ffmpeg the caller's time limit and rejects on failure", async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    onTestFinished(() => timeout.mockRestore());
    nextRun({ stderr: 'boom', code: 2 });
    await expect(measureRange('u', 0, 60, 12_345)).rejects.toThrow('ffmpeg exited 2: boom');
    expect(timeout).toHaveBeenCalledWith(12_345);
  });
});

describe('encodeClip', () => {
  it('encodes the window to a small upright MP4 with stereo AAC', async () => {
    nextRun({});
    await encodeClip(OBJECT_URL, 120, 60, '/tmp/w.mp4', 45_000);
    const args = spawnMock.mock.calls[0]![1]!;
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value('-ss')).toBe('120.000');
    expect(value('-t')).toBe('60.000');
    expect(value('-vf')).toBe(
      "scale=w='min(640,iw)':h='min(360,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    );
    expect(value('-fpsmax')).toBe('30');
    expect(value('-c:v')).toBe('libx264');
    expect(value('-maxrate')).toBe('600k');
    expect(value('-bufsize')).toBe('1200k');
    expect(value('-pix_fmt')).toBe('yuv420p');
    expect(value('-c:a')).toBe('aac');
    expect(value('-b:a')).toBe('96k');
    expect(value('-ac')).toBe('2');
    expect(value('-ar')).toBe('48000');
    expect(value('-movflags')).toBe('+faststart');
    expect(args.at(-1)).toBe('/tmp/w.mp4');
    expect(args).not.toContain('-fs');
    expect(args).not.toContain('-shortest');
  });

  it('rejects on a non-zero exit', async () => {
    nextRun({ stderr: 'bad input', code: 1 });
    await expect(encodeClip('u', 0, 60, '/tmp/w.mp4', 1000)).rejects.toThrow(
      'ffmpeg exited 1: bad input',
    );
  });
});

describe('aborted runs', () => {
  it('reject only once the killed process has exited', async () => {
    const order: string[] = [];
    nextRun({ error: new DOMException('timed out', 'AbortError'), started: true, code: null });
    const child = encodeClip('u', 0, 60, '/tmp/w.mp4', 1000).catch((error: Error) => {
      order.push(`rejected ${error.name}`);
    });
    const proc = spawnMock.mock.results[0]!.value as EventEmitter;
    proc.on('error', () => order.push('error'));
    proc.on('close', () => order.push('close'));
    await child;
    expect(order).toEqual(['error', 'close', 'rejected AbortError']);
  });
});

const EBUR_LINES = [
  '[Parsed_ebur128_0 @ 0x1] t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU',
  '[Parsed_ebur128_0 @ 0x1] t: 0.199977   TARGET:-23 LUFS    M: -48.0 S: -48.0     I: -48.0 LUFS       LRA:   0.0 LU',
  '[Parsed_ebur128_0 @ 0x1] t: 0.299977   TARGET:-23 LUFS    M: -inf S: -inf     I: -48.0 LUFS       LRA:   0.0 LU',
  '[Parsed_ebur128_0 @ 0x1] t: 0.399977   TARGET:-23 LUFS    M:  -9.5 S: -12.0     I: -20.0 LUFS       LRA:   1.0 LU',
  '[Parsed_ebur128_0 @ 0x1] Summary:',
  '  Integrated loudness:',
  '    I:         -20.0 LUFS',
].join('\n');

describe('parseLoudness', () => {
  it('reads time and momentary loudness from the per-frame lines, shifted to file time', () => {
    expect(parseLoudness(EBUR_LINES, 26.5)).toEqual([
      { t: 26.6, m: -120.7 },
      { t: 26.7, m: -48 },
      { t: 26.8, m: -Infinity },
      { t: 26.9, m: -9.5 },
    ]);
  });

  it('keeps -inf silence as the quietest reading, not a gap in the curve', () => {
    expect(parseLoudness(EBUR_LINES, 0).map((p) => p.t)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('returns nothing for output without frame lines', () => {
    expect(parseLoudness('Summary:\n  I: -9 LUFS', 0)).toEqual([]);
    expect(parseLoudness('', 0)).toEqual([]);
  });
});

describe('loudnessCurve', () => {
  it('seeks the stretch, reads audio only, and returns the shifted curve', async () => {
    nextRun({ stderr: EBUR_LINES });
    const curve = await loudnessCurve(OBJECT_URL, 26.5, 35);
    expect(curve).toHaveLength(4);
    expect(curve[0]).toEqual({ t: 26.6, m: -120.7 });
    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe('ffmpeg');
    expect(args![args!.indexOf('-ss') + 1]).toBe('26.500');
    expect(args![args!.indexOf('-t') + 1]).toBe('35.000');
    expect(args).toEqual(expect.arrayContaining(['-vn', '-i', OBJECT_URL]));
    expect(args![args!.indexOf(FILTER_GRAPH) + 1]).toBe('[0:a:0]ebur128');
    expect(args!.indexOf('-ss')).toBeLessThan(args!.indexOf('-i'));
  });

  it('names its span without the signed URL', async () => {
    nextRun({ stderr: '' });
    await loudnessCurve('https://storage.example/obj?X-Goog-Signature=abc', 0, 10);
    const options = startSpan.mock.calls.at(-1)![0] as { name: string };
    expect(options.name).toBe('ffmpeg loudness');
    expect(JSON.stringify(options)).not.toContain('Signature');
  });

  it('rejects on a non-zero exit', async () => {
    nextRun({ stderr: 'Server returned 403 Forbidden', code: 1 });
    await expect(loudnessCurve('u', 0, 10)).rejects.toThrow('ffmpeg exited 1');
  });
});

describe('shortFilter', () => {
  it('blur fill overlays the whole frame on a quarter-size blurred copy, at 9:16', () => {
    const graph = shortFilter('blur');
    expect(SHORT_WIDTH / SHORT_HEIGHT).toBeCloseTo(9 / 16);
    expect(graph).toContain('split=2[bg][fg]');
    expect(graph).toContain(
      '[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=8:2,scale=1080:1920',
    );
    expect(graph).toContain('[fg]scale=1080:1920:force_original_aspect_ratio=decrease');
    expect(graph).toContain('overlay=(W-w)/2:(H-h)/2[v]');
    expect(graph).toMatch(/^\[0:v:0\]fps=30,/);
  });

  it('center crop fills 1080x1920 from the middle of the frame', () => {
    expect(shortFilter('crop')).toBe(
      '[0:v:0]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v]',
    );
  });
});

describe('renderShort', () => {
  it('cuts the hook into a local MP4 with its index up front', async () => {
    nextRun({});
    await renderShort(
      'https://storage.example/src',
      'renders/short-s1-1.mp4',
      { startSec: 40, lengthSec: 30, reframe: 'crop' },
      RENDER_MS,
    );
    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe('ffmpeg');
    expect(args![args!.indexOf('-ss') + 1]).toBe('40.000');
    expect(args![args!.indexOf('-t') + 1]).toBe('30.000');
    expect(args![args!.indexOf('-i') + 1]).toBe('https://storage.example/src');
    expect(args![args!.indexOf(FILTER_GRAPH) + 1]).toBe(shortFilter('crop'));
    expect(args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '0:a:0']));
    expect(args![args!.indexOf('-movflags') + 1]).toBe('+faststart');
    expect(args![args!.indexOf('-preset') + 1]).toBe('veryfast');
    expect(args).toContain('-y');
    expect(args!.at(-1)).toBe('renders/short-s1-1.mp4');
  });

  it("gives ffmpeg the caller's time limit", async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    onTestFinished(() => timeout.mockRestore());
    nextRun({});
    await renderShort('s', 't', { startSec: 0, lengthSec: 15, reframe: 'blur' }, 42_000);
    expect(timeout).toHaveBeenCalledWith(42_000);
  });

  it('uses the blur graph for blur fill', async () => {
    nextRun({});
    await renderShort('s', 't', { startSec: 0, lengthSec: 15, reframe: 'blur' }, RENDER_MS);
    const args = spawnMock.mock.calls[0]![1]!;
    expect(args[args.indexOf(FILTER_GRAPH) + 1]).toBe(shortFilter('blur'));
  });

  it('rejects when ffmpeg fails', async () => {
    nextRun({ stderr: 'Conversion failed!', code: 1 });
    await expect(
      renderShort('s', 't', { startSec: 0, lengthSec: 15, reframe: 'blur' }, RENDER_MS),
    ).rejects.toThrow('ffmpeg exited 1: Conversion failed!');
  });

  it('rejects when the process cannot start', async () => {
    nextRun({ error: new Error('spawn ffmpeg ENOENT') });
    await expect(
      renderShort('s', 't', { startSec: 0, lengthSec: 15, reframe: 'crop' }, RENDER_MS),
    ).rejects.toThrow('ENOENT');
  });
});
