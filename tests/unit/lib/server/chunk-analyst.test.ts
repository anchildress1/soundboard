// @vitest-environment node
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeChunk,
  buildChunkMessages,
  CHUNK_SCHEMA,
  isChunkAnalysis,
} from '$lib/server/chunk-analyst';
import type { ChunkAnalysis, Measurements } from '$lib/types';

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

const jpeg = (i: number) => Buffer.from([0xff, 0xd8, 0xff, i, 0xff, 0xd9]);
const WAV = Buffer.from('RIFF0000WAVEfmt fake');

function ffmpegRun(code = 0) {
  spawnMock.mockImplementationOnce((() => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const fd3 = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdio: [null, stdout, stderr, fd3],
    });
    setImmediate(() => {
      stdout.emit('data', WAV);
      stderr.emit('data', Buffer.from(code === 0 ? STDERR : 'Server returned 403 Forbidden'));
      fd3.emit('data', Buffer.concat(Array.from({ length: 8 }, (_, i) => jpeg(i))));
      child.emit('close', code);
    });
    return child;
  }) as unknown as typeof spawn);
}

const completion = (content: string, status = 200) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content, reasoning_content: '' } }], usage: {} }),
    { status, headers: { 'content-type': 'application/json' } },
  );

const analysis: ChunkAnalysis = {
  visual: 'Neon-lit alley, fast cuts, mastered hot at -8 LUFS.',
  music: {
    genre: ['synthwave', '120 BPM'],
    tempoFeel: 'driving, about 118 bpm',
    instrumentation: ['analog synth bass', 'gated drums'],
    vocals: 'male lead',
    mood: ['nocturnal'],
  },
  qualityFlags: ['clipping near 0 dBFS (-0.1 dBTP)'],
};

const input = {
  url: 'https://storage.example/uploads/j1?sig=1',
  index: 2,
  startSec: 59,
  durationSec: 29.5,
  songTitle: 'PeekaBoo',
  notes: 'Nathan wants the neon look called out.',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  spawnMock.mockReset();
  vi.stubEnv('MODEL_URL', 'http://model.test');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Part = {
  type: string;
  image_url?: { url: string };
  input_audio?: { data: string; format: string };
  text?: string;
};
const sentBody = (call = 0) =>
  JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string) as {
    messages: { role: string; content: string | Part[] }[];
    response_format: { json_schema: { name: string; schema: unknown } };
  };

describe('isChunkAnalysis', () => {
  it('accepts a complete analysis', () => {
    expect(isChunkAnalysis(analysis)).toBe(true);
    expect(
      isChunkAnalysis({
        visual: '',
        music: { genre: [], tempoFeel: '', instrumentation: [], vocals: '', mood: [] },
        qualityFlags: [],
      }),
    ).toBe(true);
  });

  it('rejects non-objects and missing music', () => {
    expect(isChunkAnalysis(null)).toBe(false);
    expect(isChunkAnalysis('text')).toBe(false);
    expect(isChunkAnalysis({ visual: 'x', music: null, qualityFlags: [] })).toBe(false);
    expect(isChunkAnalysis({ visual: 1, music: analysis.music, qualityFlags: [] })).toBe(false);
  });

  it('rejects wrong field types anywhere in the shape', () => {
    const bad = (patch: Record<string, unknown>) =>
      isChunkAnalysis({ ...analysis, music: { ...analysis.music, ...patch } });
    expect(bad({ genre: 'synthwave' })).toBe(false);
    expect(bad({ genre: ['ok', 3] })).toBe(false);
    expect(bad({ tempoFeel: 120 })).toBe(false);
    expect(bad({ instrumentation: null })).toBe(false);
    expect(bad({ vocals: undefined })).toBe(false);
    expect(bad({ mood: {} })).toBe(false);
    expect(isChunkAnalysis({ ...analysis, qualityFlags: 'none' })).toBe(false);
  });
});

describe('buildChunkMessages', () => {
  const measurements: Measurements = {
    integratedLufs: -9.7,
    truePeakDbtp: -0.4,
    peakLevelDb: 0,
    clippedSamples: 3,
    silences: [],
  };

  it('sends the window context, every frame as a JPEG data URL, and the WAV', () => {
    const frames = [jpeg(1), jpeg(2)];
    const [system, user] = buildChunkMessages({
      songTitle: 'PeekaBoo',
      notes: '',
      startSec: 0,
      durationSec: 29.5,
      measurements,
      frames,
      wav: WAV,
    });
    expect(system!.role).toBe('system');
    expect(system!.content).toMatch(/Do not restate or estimate any loudness/);
    expect(system!.content).toMatch(/Do not transcribe lyrics/);
    const parts = user!.content as Part[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'image_url', 'input_audio']);
    const context = JSON.parse(parts[0]!.text!);
    expect(context).toEqual({
      songTitle: 'PeekaBoo',
      window: { startSec: 0, durationSec: 29.5 },
      ffmpeg: measurements,
    });
    expect(parts[1]!.image_url!.url).toBe(
      `data:image/jpeg;base64,${frames[0]!.toString('base64')}`,
    );
    expect(parts[3]!.input_audio).toEqual({ data: WAV.toString('base64'), format: 'wav' });
  });

  it('includes artist notes when present', () => {
    const [, user] = buildChunkMessages({
      songTitle: 'S',
      notes: 'Flies Like Robots live take',
      startSec: 0,
      durationSec: 1,
      measurements,
      frames: [],
      wav: Buffer.alloc(0),
    });
    const parts = user!.content as Part[];
    expect(JSON.parse(parts[0]!.text!).artistNotes).toBe('Flies Like Robots live take');
    expect(parts).toHaveLength(2);
  });
});

describe('analyzeChunk', () => {
  it('cuts the window, sends 8 frames and 1 audio part, and strips model numerics', async () => {
    ffmpegRun();
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(analysis)));

    const chunk = await analyzeChunk(input);

    const args = spawnMock.mock.calls[0]![1]!;
    expect(args[args.indexOf('-ss') + 1]).toBe('59.000');
    expect(args[args.indexOf('-t') + 1]).toBe('29.500');
    expect(args).toContain(input.url);

    const body = sentBody();
    expect(fetchMock.mock.calls[0]![0]).toBe('http://model.test/v1/chat/completions');
    expect(body.response_format.json_schema).toEqual({
      name: 'chunk_analysis',
      strict: true,
      schema: CHUNK_SCHEMA,
    });
    const parts = body.messages[1]!.content as Part[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(8);
    expect(parts.filter((p) => p.type === 'input_audio')).toHaveLength(1);
    expect(JSON.parse(parts[0]!.text!)).toMatchObject({
      songTitle: 'PeekaBoo',
      artistNotes: input.notes,
      window: { startSec: 59, durationSec: 29.5 },
      ffmpeg: { integratedLufs: -9.7, truePeakDbtp: -0.4 },
    });

    expect(chunk).toMatchObject({
      index: 2,
      startSec: 59,
      durationSec: 29.5,
      raw: null,
      measurements: {
        integratedLufs: -9.7,
        truePeakDbtp: -0.4,
        clippedSamples: 1146,
        silences: [{ start: 63, end: 66 }],
      },
    });
    expect(chunk.analysis).toEqual({
      visual: 'Neon-lit alley, fast cuts, mastered hot at.',
      music: {
        genre: ['synthwave'],
        tempoFeel: 'driving, about',
        instrumentation: ['analog synth bass', 'gated drums'],
        vocals: 'male lead',
        mood: ['nocturnal'],
      },
      qualityFlags: ['clipping near'],
    });
    expect(JSON.stringify(chunk.analysis)).not.toMatch(/LUFS|dB|bpm/i);
    expect(chunk.modelMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps the raw reply when the model fails to produce valid JSON twice', async () => {
    ffmpegRun();
    fetchMock
      .mockResolvedValueOnce(completion('{"visual": "cut off'))
      .mockResolvedValueOnce(completion('Sorry, -9 LUFS {not json'));

    const chunk = await analyzeChunk(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunk.analysis).toBeNull();
    expect(chunk.raw).toBe('Sorry, -9 LUFS {not json');
    expect(chunk.measurements.integratedLufs).toBe(-9.7);
  });

  it('recovers on the retry after one bad reply', async () => {
    ffmpegRun();
    fetchMock
      .mockResolvedValueOnce(completion('{"visual":"x"}'))
      .mockResolvedValueOnce(completion(JSON.stringify({ ...analysis, visual: 'Calm' })));
    const chunk = await analyzeChunk(input);
    expect(chunk.analysis?.visual).toBe('Calm');
    expect(chunk.raw).toBeNull();
  });

  it('rejects without calling the model when ffmpeg fails', async () => {
    ffmpegRun(1);
    await expect(analyzeChunk(input)).rejects.toThrow(
      'ffmpeg exited 1: Server returned 403 Forbidden',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when llama-server errors', async () => {
    ffmpegRun();
    fetchMock.mockResolvedValueOnce(new Response('slot unavailable', { status: 503 }));
    await expect(analyzeChunk(input)).rejects.toThrow('llama-server 503: slot unavailable');
  });
});
