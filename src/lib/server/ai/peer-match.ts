import type { Chunk } from '#lib/types.js';
import {
  agentInput,
  agentOutput,
  invokeAgent,
  youtubePart,
  type ModelRequest,
  type Part,
} from '#lib/server/core/tracing.js';
import { chatJson, hasModelTime, modelFor } from './model';
import { stripStats } from './stat-guard';
import { shape, type Check } from './shape';

const CHANNEL_KINDS = ['artist', 'label', 'compilation', 'curator', 'uncertain'] as const;
const SOUNDS = ['same', 'different', 'uncertain'] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export type Sound = (typeof SOUNDS)[number];
export type PeerMatchReply = { channelKind: ChannelKind; sound: Sound; explanation: string };
/** `heard` when the sample's audio was part of the call, else the text alone. */
export type MatchBasis = 'heard' | 'metadata-only';
export type PeerMatch = PeerMatchReply & { basis: MatchBasis };

export const PEER_MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['channelKind', 'sound', 'explanation'],
  properties: {
    channelKind: { type: 'string', enum: CHANNEL_KINDS },
    sound: { type: 'string', enum: SOUNDS },
    explanation: { type: 'string' },
  },
} as const;

const oneOf =
  (allowed: readonly string[]): Check =>
  (value) =>
    typeof value === 'string' && allowed.includes(value);

const PEER_MATCH = shape({
  channelKind: oneOf(CHANNEL_KINDS),
  sound: oneOf(SOUNDS),
  explanation: (value) => typeof value === 'string',
});

export function isPeerMatch(value: unknown): value is PeerMatchReply {
  return PEER_MATCH(value);
}

/** What the song sounds like, from the chunk analyst: distinct terms across its windows. */
export type SongDigest = {
  genre: string[];
  instrumentation: string[];
  mood: string[];
  tempoFeel: string[];
  vocals: string[];
};

const DIGEST_TERMS = 8;

function distinct(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const term = value.trim();
    if (term && !seen.has(term.toLowerCase())) seen.set(term.toLowerCase(), term);
  }
  return [...seen.values()].slice(0, DIGEST_TERMS);
}

export function songDigest(chunks: Chunk[]): SongDigest {
  const music = chunks.flatMap((chunk) => (chunk.analysis ? [chunk.analysis.music] : []));
  return {
    genre: distinct(music.flatMap((m) => m.genre)),
    instrumentation: distinct(music.flatMap((m) => m.instrumentation)),
    mood: distinct(music.flatMap((m) => m.mood)),
    tempoFeel: distinct(music.map((m) => m.tempoFeel)),
    vocals: distinct(music.map((m) => m.vocals)),
  };
}

const INSTRUCTIONS = [
  "Decide whether a YouTube channel is an artist whose sound matches the artist's own song.",
  "You get the song's digest from our analysis, the channel's title and description, and the title and tags of its newest upload. Sometimes you also get the first minute of that upload to listen to.",
  "channelKind: artist for a musician or band posting their own music; label for a record label; compilation for a channel of mixes or playlists of other people's music; curator for reviews, reactions or promotion; uncertain when you cannot tell.",
  "sound: same when the music shares the song's genre and instrumentation; different when it clearly does not; uncertain when what you were given does not settle it.",
  'explanation: one or two plain sentences naming the sounds you heard or read (genre, instruments, mood). Without audio, say the judgment rests on text only.',
  'Never write a number about views, subscribers, likes or any other statistic.',
].join('\n');

const DESCRIPTION_CHARS = 700;
const CLIP_SECONDS = 60;
const VIDEO_ID = /^[\w-]{11}$/;

export type PeerInput = {
  digest: SongDigest;
  channel: { title: string; description: string };
  /** The channel's newest public upload; null when it has none. */
  sample: { videoId: string; title: string; tags: string[] } | null;
  /** Whether the sample's first minute may be heard (`PEER_HEARING`, gate G1). */
  hearing: boolean;
};

/** The sample is heard only for a well-formed video ID; any other URL would be fetched by the SDK. */
const canHear = (input: PeerInput) =>
  input.hearing && input.sample !== null && VIDEO_ID.test(input.sample.videoId);

export function buildPeerRequest(input: PeerInput, hear = canHear(input)): ModelRequest {
  const parts: Part[] = [
    { type: 'text', text: JSON.stringify({ song: input.digest }) },
    youtubePart(
      {
        channel: {
          title: input.channel.title,
          description: input.channel.description.slice(0, DESCRIPTION_CHARS),
        },
        newestUpload: input.sample && { title: input.sample.title, tags: input.sample.tags },
      },
      1,
      'YouTube peers',
    ),
  ];
  if (hear && input.sample) {
    parts.push({
      type: 'youtube',
      url: `https://www.youtube.com/watch?v=${input.sample.videoId}`,
      start: 0,
      end: CLIP_SECONDS,
    });
  }
  return { system: INSTRUCTIONS, turns: [{ role: 'user', parts }] };
}

/** Gemini refused the video itself (private, removed, restricted), not the request as a whole. */
const VIDEO_REFUSED = /^Gemini (?:400|403|404):/;

const UNREADABLE: PeerMatchReply = {
  channelKind: 'uncertain',
  sound: 'uncertain',
  explanation: 'The reply could not be read.',
};

/**
 * One candidate's match. A video Gemini can't open falls back to the text alone, labeled
 * `metadata-only`; a busy or spent model throws its typed wait. A reply that never parses comes
 * back uncertain, so the candidate is skipped.
 */
export function matchPeer(input: PeerInput, deadline: number): Promise<PeerMatch> {
  return invokeAgent('peer-match', modelFor('peer-match'), async (span) => {
    const ask = async (hear: boolean): Promise<PeerMatch> => {
      const request = buildPeerRequest(input, hear);
      agentInput(span, request);
      const { value, ms } = await chatJson(
        request,
        'peer-match',
        PEER_MATCH_SCHEMA,
        isPeerMatch,
        deadline,
      );
      const reply = value
        ? { ...value, explanation: stripStats(value.explanation).text }
        : UNREADABLE;
      agentOutput(span, JSON.stringify(reply), 'peer-match');
      span.setAttributes({ 'peer.model_ms': ms, 'peer.basis': hear ? 'heard' : 'metadata-only' });
      return { ...reply, basis: hear ? 'heard' : 'metadata-only' };
    };
    if (!canHear(input)) return await ask(false);
    try {
      return await ask(true);
    } catch (error) {
      const refused = error instanceof Error && VIDEO_REFUSED.test(error.message);
      if (!refused || !hasModelTime('peer-match', deadline)) throw error;
      return await ask(false);
    }
  });
}
