// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeChunk,
  buildChunkRequest,
  CHUNK_SCHEMA,
  isChunkAnalysis,
} from '#lib/server/ai/chunk-analyst.js';
import { stepDeadline } from '#lib/server/ai/model.js';
import type { ChunkAnalysis, Measurements } from '#lib/types.js';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import { badRequest400, busy429, interaction } from '../../../../helpers/gemini';
import { omit } from '../../../../helpers/omit';

const CLIP = new Uint8Array(Buffer.from('fake-mp4-window-clip'));
const CLIP_B64 = Buffer.from(CLIP).toString('base64');

const measurements: Measurements = {
  integratedLufs: -9.7,
  truePeakDbtp: -0.4,
  peakLevelDb: 0,
  clippedSamples: 1146,
  silences: [{ start: 63, end: 66 }],
};

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
  index: 2,
  startSec: 120,
  durationSec: 60,
  songTitle: 'PeekaBoo',
  notes: 'Nathan wants the neon look called out.',
  measurements,
  clip: CLIP,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearAgentSpan();
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Content = { type: string; text?: string; data?: string; mime_type?: string };
const sentBody = (call = 0) =>
  JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string) as {
    model: string;
    input: { type: string; content: Content[] }[];
    response_format: unknown;
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
    expect(isChunkAnalysis({ ...analysis, music: omit(analysis.music, 'vocals') })).toBe(false);
    expect(bad({ mood: {} })).toBe(false);
    expect(isChunkAnalysis({ ...analysis, qualityFlags: 'none' })).toBe(false);
  });
});

describe('buildChunkRequest', () => {
  it('sends the window context and the clip as one video part, with no images or audio', () => {
    const { system, turns } = buildChunkRequest({ ...input, notes: '' });
    expect(system).toMatch(/Do not restate or estimate any loudness/);
    expect(system).toMatch(/Do not transcribe lyrics/);
    expect(turns).toHaveLength(1);
    const [text, video] = turns[0]!.parts;
    expect(turns[0]!.parts.map((p) => p.type)).toEqual(['text', 'video']);
    expect(JSON.parse((text as { text: string }).text)).toEqual({
      songTitle: 'PeekaBoo',
      window: { startSec: 120, durationSec: 60 },
      ffmpeg: measurements,
    });
    expect(video).toEqual({
      type: 'video',
      data: CLIP,
      mime_type: 'video/mp4',
      start: 120,
      end: 180,
    });
  });

  it('includes artist notes when present', () => {
    const [text] = buildChunkRequest({ ...input, notes: 'Flies Like Robots live take' }).turns[0]!
      .parts;
    expect(JSON.parse((text as { text: string }).text).artistNotes).toBe(
      'Flies Like Robots live take',
    );
  });

  it('ends the clip at the window end for a short last window', () => {
    const [, video] = buildChunkRequest({ ...input, startSec: 840, durationSec: 12.5 }).turns[0]!
      .parts;
    expect(video).toMatchObject({ start: 840, end: 852.5 });
  });
});

describe('analyzeChunk', () => {
  it('sends the clip inline to the analyst model and strips model numerics', async () => {
    fetchMock.mockResolvedValueOnce(interaction(JSON.stringify(analysis)));

    const chunk = await analyzeChunk(input, stepDeadline());

    const body = sentBody();
    expect(body.model).toBe('gemini-3.8-flash');
    expect(JSON.stringify(body.response_format)).toContain(JSON.stringify(CHUNK_SCHEMA));
    const content = body.input[0]!.content;
    expect(content.map((c) => c.type)).toEqual(['text', 'video']);
    expect(content[1]).toMatchObject({ data: CLIP_B64, mime_type: 'video/mp4' });
    expect(JSON.parse(content[0]!.text!)).toMatchObject({
      songTitle: 'PeekaBoo',
      artistNotes: input.notes,
      window: { startSec: 120, durationSec: 60 },
      ffmpeg: { integratedLufs: -9.7, truePeakDbtp: -0.4 },
    });

    expect(chunk).toMatchObject({
      index: 2,
      startSec: 120,
      durationSec: 60,
      raw: null,
      measurements,
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

  it('keeps the raw reply, minus model numbers, when the model fails to produce valid JSON twice', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction('{"visual": "cut off'))
      .mockResolvedValueOnce(interaction('Sorry, -9 LUFS {not json'));

    const chunk = await analyzeChunk(input, stepDeadline());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunk.analysis).toBeNull();
    expect(chunk.raw).toBe('Sorry, {not json');
    expect(chunk.measurements).toEqual(measurements);
  });

  it('recovers on the re-ask after one bad reply', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction('{"visual":"x"}'))
      .mockResolvedValueOnce(interaction(JSON.stringify({ ...analysis, visual: 'Calm' })));
    const chunk = await analyzeChunk(input, stepDeadline());
    expect(chunk.analysis?.visual).toBe('Calm');
    expect(chunk.raw).toBeNull();
  });

  it('records the redacted request and the stripped analysis on the agent span', async () => {
    fetchMock.mockResolvedValueOnce(interaction(JSON.stringify(analysis)));
    const chunk = await analyzeChunk(input, stepDeadline());

    const { input: recorded, output } = agentSpanIO();
    expect(recorded).toHaveLength(1);
    const sent = recorded[0]!['gen_ai.input.messages']!;
    expect(sent).toContain('PeekaBoo');
    expect(sent).toContain('"clip":"120s–180s"');
    expect(sent).not.toContain(CLIP_B64);
    expect(recorded[0]!['gen_ai.system_instructions']).toBeDefined();
    expect(output).toEqual([JSON.stringify(chunk.analysis)]);
  });

  it('records the stripped raw reply as the agent output when parsing fails', async () => {
    fetchMock.mockImplementation(async () => interaction('Sorry, -9 LUFS {not json'));
    await analyzeChunk(input, stepDeadline());
    expect(agentSpanIO().output).toEqual(['Sorry, {not json']);
  });

  it('uses the deadline it is given', async () => {
    await expect(analyzeChunk(input, Date.now() + 1000)).rejects.toThrow('ran out of time');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when Gemini refuses or is busy', async () => {
    fetchMock.mockResolvedValueOnce(badRequest400());
    await expect(analyzeChunk(input, stepDeadline())).rejects.toThrow('Gemini 400');
    fetchMock.mockResolvedValueOnce(busy429());
    await expect(analyzeChunk(input, stepDeadline())).rejects.toThrow('Gemini 429');
  });
});
