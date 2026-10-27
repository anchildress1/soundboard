// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBusy, stepDeadline } from '#lib/server/ai/model.js';
import {
  buildPeerRequest,
  isPeerMatch,
  matchPeer,
  PEER_MATCH_SCHEMA,
  songDigest,
  type PeerInput,
} from '#lib/server/ai/peer-match.js';
import type { Chunk, ChunkAnalysis } from '#lib/types.js';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import { badRequest400, busy429, geminiError, interaction } from '../../../../helpers/gemini';

const music = (patch: Partial<ChunkAnalysis['music']> = {}): Chunk => ({
  index: 0,
  startSec: 0,
  durationSec: 60,
  measurements: {
    integratedLufs: null,
    truePeakDbtp: null,
    peakLevelDb: null,
    clippedSamples: 0,
    silences: [],
  },
  raw: null,
  modelMs: 1,
  analysis: {
    visual: '',
    music: {
      genre: ['synthwave'],
      tempoFeel: 'driving',
      instrumentation: ['analog synth'],
      vocals: 'male lead',
      mood: ['nocturnal'],
      ...patch,
    },
    qualityFlags: [],
  },
});

const DIGEST = songDigest([music()]);
const VIDEO = 'abcdefghijk';
const input = (patch: Partial<PeerInput> = {}): PeerInput => ({
  digest: DIGEST,
  channel: { title: 'Velvet Static', description: 'Dark synth from Ohio.' },
  sample: { videoId: VIDEO, title: 'Night Drive', tags: ['synthwave'] },
  hearing: true,
  ...patch,
});
const reply = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    channelKind: 'artist',
    sound: 'same',
    explanation: 'Analog synth leads over gated drums.',
    ...patch,
  });

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

type Sent = { input: { content: { type: string; text?: string; uri?: string }[] }[] };
const sentBody = (call = 0) =>
  JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string) as Sent;

describe('isPeerMatch', () => {
  it('accepts every kind and sound', () => {
    for (const channelKind of ['artist', 'label', 'compilation', 'curator', 'uncertain']) {
      for (const sound of ['same', 'different', 'uncertain']) {
        expect(isPeerMatch({ channelKind, sound, explanation: '' })).toBe(true);
      }
    }
  });

  it('rejects a value outside the enums, a missing field and non-objects', () => {
    expect(isPeerMatch({ channelKind: 'band', sound: 'same', explanation: 'x' })).toBe(false);
    expect(isPeerMatch({ channelKind: 'artist', sound: 'alike', explanation: 'x' })).toBe(false);
    expect(isPeerMatch({ channelKind: 'artist', sound: 'same', explanation: 3 })).toBe(false);
    expect(isPeerMatch({ channelKind: 'artist', sound: 'same' })).toBe(false);
    expect(isPeerMatch({ channelKind: 1, sound: 'same', explanation: 'x' })).toBe(false);
    expect(isPeerMatch(null)).toBe(false);
    expect(isPeerMatch('artist')).toBe(false);
  });

  it('has a schema that lists the same enums', () => {
    expect(PEER_MATCH_SCHEMA.properties.sound.enum).toEqual(['same', 'different', 'uncertain']);
    expect(PEER_MATCH_SCHEMA.required).toEqual(['channelKind', 'sound', 'explanation']);
  });
});

describe('songDigest', () => {
  it('collects distinct terms across windows, ignoring case and blanks', () => {
    const digest = songDigest([
      music(),
      music({ genre: ['Synthwave', 'darkwave', ' '], mood: ['nocturnal', 'tense'] }),
    ]);
    expect(digest.genre).toEqual(['synthwave', 'darkwave']);
    expect(digest.mood).toEqual(['nocturnal', 'tense']);
    expect(digest.tempoFeel).toEqual(['driving']);
    expect(digest.vocals).toEqual(['male lead']);
    expect(digest.instrumentation).toEqual(['analog synth']);
  });

  it('skips windows the analyst never answered, and is empty without any', () => {
    const none = { ...music(), analysis: null };
    expect(songDigest([none, music()]).genre).toEqual(['synthwave']);
    expect(songDigest([none])).toEqual({
      genre: [],
      instrumentation: [],
      mood: [],
      tempoFeel: [],
      vocals: [],
    });
  });

  it('keeps at most eight terms per field', () => {
    const genre = Array.from({ length: 12 }, (_, i) => `genre ${i}`);
    expect(songDigest([music({ genre })]).genre).toEqual(genre.slice(0, 8));
  });
});

describe('buildPeerRequest', () => {
  it('sends the song digest as app text and the channel as one YouTube-sourced part', () => {
    const { system, turns } = buildPeerRequest(input({ hearing: false }));
    expect(system).toMatch(/Never write a number about views/);
    const [song, channel] = turns[0]!.parts;
    expect(song).toMatchObject({ type: 'text' });
    expect((song as { source?: string }).source).toBeUndefined();
    expect(JSON.parse((song as { text: string }).text)).toEqual({ song: DIGEST });
    expect(channel).toMatchObject({ source: 'youtube', count: 1, label: 'YouTube peers' });
    expect(JSON.parse((channel as { text: string }).text)).toEqual({
      channel: { title: 'Velvet Static', description: 'Dark synth from Ohio.' },
      newestUpload: { title: 'Night Drive', tags: ['synthwave'] },
    });
    expect(turns[0]!.parts).toHaveLength(2);
  });

  it('adds the first 60 s of the sample as a watch URL when it can be heard', () => {
    const { turns } = buildPeerRequest(input());
    expect(turns[0]!.parts[2]).toEqual({
      type: 'youtube',
      url: `https://www.youtube.com/watch?v=${VIDEO}`,
      start: 0,
      end: 60,
    });
  });

  it('never adds a clip without hearing, without a sample, or for a malformed ID', () => {
    expect(buildPeerRequest(input({ hearing: false })).turns[0]!.parts).toHaveLength(2);
    expect(buildPeerRequest(input({ sample: null })).turns[0]!.parts).toHaveLength(2);
    const odd = input({ sample: { videoId: 'x/../y', title: 't', tags: [] } });
    expect(buildPeerRequest(odd).turns[0]!.parts).toHaveLength(2);
  });

  it('has no upload to describe when the channel has none, and clips a long description', () => {
    const { turns } = buildPeerRequest(
      input({ sample: null, channel: { title: 'T', description: 'x'.repeat(2000) } }),
    );
    const parsed = JSON.parse((turns[0]!.parts[1] as { text: string }).text);
    expect(parsed.newestUpload).toBeNull();
    expect(parsed.channel.description).toHaveLength(700);
  });
});

describe('matchPeer', () => {
  it('hears the clip, labels the match heard, and sends no YouTube fetch of its own', async () => {
    fetchMock.mockResolvedValueOnce(interaction(reply()));

    const match = await matchPeer(input(), stepDeadline());

    expect(match).toEqual({
      channelKind: 'artist',
      sound: 'same',
      explanation: 'Analog synth leads over gated drums.',
      basis: 'heard',
    });
    const content = sentBody().input[0]!.content;
    expect(JSON.stringify(content)).toContain(`https://www.youtube.com/watch?v=${VIDEO}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('generativelanguage.googleapis.com');
  });

  it('labels the match metadata-only when hearing is off', async () => {
    fetchMock.mockResolvedValueOnce(interaction(reply({ sound: 'different' })));
    const match = await matchPeer(input({ hearing: false }), stepDeadline());
    expect(match).toMatchObject({ sound: 'different', basis: 'metadata-only' });
    expect(JSON.stringify(sentBody())).not.toContain('youtube.com/watch');
  });

  it('falls back to the text alone when Gemini cannot open a private or removed video', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiError(403, 'PERMISSION_DENIED'))
      .mockResolvedValueOnce(interaction(reply()));

    const match = await matchPeer(input(), stepDeadline());

    expect(match.basis).toBe('metadata-only');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sentBody(0))).toContain('youtube.com/watch');
    expect(JSON.stringify(sentBody(1))).not.toContain('youtube.com/watch');
  });

  it('throws when the text-only retry is refused too', async () => {
    fetchMock.mockImplementation(async () => badRequest400());
    await expect(matchPeer(input(), stepDeadline())).rejects.toThrow('Gemini 400');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a refused video when the step has no time left for a second call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Enough for the first call's minimum, not for a second after it.
      const deadline = Date.now() + 6_000;
      fetchMock.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 3_000);
        return geminiError(404, 'NOT_FOUND');
      });
      await expect(matchPeer(input(), deadline)).rejects.toThrow('Gemini 404');
    } finally {
      vi.useRealTimers();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws a busy provider as the typed wait, never retried as text only', async () => {
    fetchMock.mockResolvedValueOnce(busy429());
    await expect(matchPeer(input(), stepDeadline())).rejects.toBeInstanceOf(ModelBusy);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on a server error', async () => {
    fetchMock.mockResolvedValueOnce(geminiError(500, 'INTERNAL'));
    await expect(matchPeer(input(), stepDeadline())).rejects.toThrow('Gemini 500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('comes back uncertain when the reply never parses, so the candidate is skipped', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction('{"channelKind": "arti'))
      .mockResolvedValueOnce(interaction('not json'));
    const match = await matchPeer(input({ hearing: false }), stepDeadline());
    expect(match).toMatchObject({ channelKind: 'uncertain', sound: 'uncertain' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers on the re-ask after one bad reply', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction('{}'))
      .mockResolvedValueOnce(interaction(reply({ channelKind: 'label', sound: 'uncertain' })));
    const match = await matchPeer(input({ hearing: false }), stepDeadline());
    expect(match).toMatchObject({ channelKind: 'label', sound: 'uncertain' });
  });

  it('strips a statistic the model wrote into the explanation', async () => {
    fetchMock.mockResolvedValueOnce(
      interaction(
        reply({ explanation: 'Gated drums and analog synth. Their 1200 views show it.' }),
      ),
    );
    const match = await matchPeer(input({ hearing: false }), stepDeadline());
    expect(match.explanation).toBe('Gated drums and analog synth.');
  });

  it('keeps the reply text in the span but replaces the peer values it echoes', async () => {
    fetchMock.mockResolvedValueOnce(
      interaction(reply({ explanation: 'Velvet Static plays dark synth like the song.' }), {
        reasoning: 'Night Drive is tagged synthwave, so it fits.',
      }),
    );

    await matchPeer(input({ hearing: false }), stepDeadline());

    const { input: recorded, output } = agentSpanIO();
    const sent = recorded[0]!['gen_ai.input.messages']!;
    expect(sent).toContain('[YouTube peers: 1]');
    expect(sent).not.toContain('Velvet Static');
    expect(sent).not.toContain('Night Drive');
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('[YouTube data] plays dark synth like the song');
    expect(output[0]).not.toContain('Velvet Static');
  });
});
