import type { Chunk, ChunkAnalysis, Measurements } from '#lib/types.js';
import { chatJson, modelFor } from './model';
import { stripDeep, stripNumerics } from './numerics';
import { isString, isStrings, shape } from './shape';
import {
  agentInput,
  agentOutput,
  invokeAgent,
  type ModelRequest,
} from '#lib/server/core/tracing.js';

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
  'Analyze one window of a music video, given as a short clip: watch it and listen to it.',
  'Report what you see and hear in short plain phrases.',
  'visual: one or two sentences on imagery, setting, color, and editing pace.',
  'music: genre terms, tempo feel in words, instrumentation, vocal type, mood words.',
  'qualityFlags: unintended audible or visible problems only (dropouts, sync drift, encoding artifacts). Never the intended style: glitch, distortion, or lo-fi effects used on purpose are not problems. Empty if none.',
  'The measurements were taken with ffmpeg. Do not restate or estimate any loudness, level, or tempo numbers.',
  'Do not transcribe lyrics.',
].join('\n');

type WindowInput = {
  songTitle: string;
  notes: string;
  startSec: number;
  durationSec: number;
  measurements: Measurements;
  /** The window's MP4 clip, sent inline. */
  clip: Uint8Array;
};

export function buildChunkRequest(input: WindowInput): ModelRequest {
  const context = {
    songTitle: input.songTitle,
    artistNotes: input.notes || undefined,
    window: { startSec: input.startSec, durationSec: input.durationSec },
    ffmpeg: input.measurements,
  };
  return {
    system: INSTRUCTIONS,
    turns: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: JSON.stringify(context) },
          {
            type: 'video',
            data: input.clip,
            mime_type: 'video/mp4',
            start: input.startSec,
            end: input.startSec + input.durationSec,
          },
        ],
      },
    ],
  };
}

/**
 * Runs one window's clip through the chunk analyst. A reply that never parses is kept as
 * numerics-stripped raw text.
 */
export function analyzeChunk(
  input: WindowInput & { index: number },
  deadline: number,
): Promise<Chunk> {
  return invokeAgent('chunk-analyst', modelFor('chunk-analyst'), async (span) => {
    span.setAttribute('chunk.index', input.index);
    const request = buildChunkRequest(input);
    agentInput(span, request);
    const { value, raw, ms } = await chatJson(
      request,
      'chunk-analyst',
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
      measurements: input.measurements,
      raw: stripped,
      modelMs: ms,
      analysis,
    };
  });
}
