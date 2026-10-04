import type { Chunk, ChunkAnalysis, Measurements } from '$lib/types';
import { extractWindow } from './ffmpeg';
import { chatJson, stepDeadline } from './model';
import { stripDeep, stripNumerics } from './numerics';
import { isString, isStrings, shape } from './shape';
import { agentInput, agentOutput, invokeAgent, type ChatMessage } from './tracing';

const stringArray = { type: 'array', items: { type: 'string' } };

export const CHUNK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['visual', 'music', 'qualityFlags'],
  properties: {
    visual: { type: 'string' },
    music: {
      type: 'object',
      additionalProperties: false,
      required: ['genre', 'tempoFeel', 'instrumentation', 'vocals', 'mood'],
      properties: {
        genre: stringArray,
        tempoFeel: { type: 'string' },
        instrumentation: stringArray,
        vocals: { type: 'string' },
        mood: stringArray,
      },
    },
    qualityFlags: stringArray,
  },
} as const;

const CHUNK_ANALYSIS = shape({
  visual: isString,
  music: shape({
    genre: isStrings,
    tempoFeel: isString,
    instrumentation: isStrings,
    vocals: isString,
    mood: isStrings,
  }),
  qualityFlags: isStrings,
});

export function isChunkAnalysis(value: unknown): value is ChunkAnalysis {
  return CHUNK_ANALYSIS(value);
}

const INSTRUCTIONS = [
  'Analyze one window of a music video: its audio and frames sampled across it.',
  'Report what you see and hear in short plain phrases.',
  'visual: one or two sentences on imagery, setting, color, and editing pace.',
  'music: genre terms, tempo feel in words, instrumentation, vocal type, mood words.',
  'qualityFlags: unintended audible or visible problems only (dropouts, sync drift, encoding artifacts). Never the intended style: glitch, distortion, or lo-fi effects used on purpose are not problems. Empty if none.',
  'The measurements were taken with ffmpeg. Do not restate or estimate any loudness, level, or tempo numbers.',
  'Do not transcribe lyrics.',
].join('\n');

export function buildChunkMessages(input: {
  songTitle: string;
  notes: string;
  startSec: number;
  durationSec: number;
  measurements: Measurements;
  frames: Buffer[];
  wav: Buffer;
}): ChatMessage[] {
  const context = {
    songTitle: input.songTitle,
    artistNotes: input.notes || undefined,
    window: { startSec: input.startSec, durationSec: input.durationSec },
    ffmpeg: input.measurements,
  };
  return [
    { role: 'system', content: INSTRUCTIONS },
    {
      role: 'user',
      content: [
        { type: 'text', text: JSON.stringify(context) },
        ...input.frames.map((frame) => ({
          type: 'image_url' as const,
          image_url: { url: `data:image/jpeg;base64,${frame.toString('base64')}` },
        })),
        { type: 'input_audio', input_audio: { data: input.wav.toString('base64'), format: 'wav' } },
      ],
    },
  ];
}

/** Cuts one window from the source and runs it through the chunk analyst. */
export async function analyzeChunk(input: {
  url: string;
  index: number;
  startSec: number;
  durationSec: number;
  songTitle: string;
  notes: string;
}): Promise<Chunk> {
  const deadline = stepDeadline();
  const window = await extractWindow(input.url, input.startSec, input.durationSec);
  return invokeAgent('chunk-analyst', async (span) => {
    span.setAttribute('chunk.index', input.index);
    const messages = buildChunkMessages({ ...input, ...window });
    agentInput(span, messages);
    const { value, raw, ms } = await chatJson(
      messages,
      'chunk_analysis',
      CHUNK_SCHEMA,
      isChunkAnalysis,
      deadline,
    );
    const analysis = value ? stripDeep(value) : null;
    const stripped = value ? null : stripNumerics(raw);
    agentOutput(span, analysis ? JSON.stringify(analysis) : (stripped ?? ''));
    return {
      index: input.index,
      startSec: input.startSec,
      durationSec: input.durationSec,
      measurements: window.measurements,
      raw: stripped,
      modelMs: ms,
      analysis,
    };
  });
}
