// @vitest-environment node
import {
  getTraceData as sentryGetTraceData,
  startNewTrace,
  startSpan as sentryStartSpan,
  type Span,
} from '@sentry/sveltekit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentInput,
  agentOutput,
  chatSpan,
  imageParts,
  invokeAgent,
  PIPELINE,
  PROVIDER,
  redactTurns,
  startJobTrace,
  textTurn,
  toolSpan,
  youtubePart,
  youtubeRedactor,
  YOUTUBE_VALUE,
  type ChatReply,
  type ModelRequest,
} from '#lib/server/core/tracing.js';

import { span } from '../../../../mocks/sentry';

const CHUNK_ANALYST = 'chunk-analyst';
const SMART_PICK = 'smart-pick';
const FLASH = 'gemini-3.8-flash';
const VISUAL_JSON = '{"visual":"neon"}';

const startSpan = vi.mocked(sentryStartSpan);
const getTraceData = vi.mocked(sentryGetTraceData);
type SpanOptions = { op: string; name: string; attributes: Record<string, unknown> };
const lastOptions = () => startSpan.mock.calls.at(-1)![0] as unknown as SpanOptions;

const IMAGE_B64 = Buffer.from('fake-jpeg-bytes-0123456789').toString('base64');
const CLIP = new TextEncoder().encode('fake-mp4-clip-bytes');
const CLIP_B64 = Buffer.from(CLIP).toString('base64');

const request: ModelRequest = {
  system: 'Instructions',
  turns: [
    {
      role: 'user',
      parts: [
        { type: 'text', text: '{"songTitle":"PeekaBoo"}' },
        { type: 'image', data: IMAGE_B64, mime_type: 'image/jpeg' },
        { type: 'video', data: CLIP, mime_type: 'video/mp4', start: 60, end: 120 },
      ],
    },
    { role: 'assistant', parts: [{ type: 'text', text: '{"title":"first"}' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Again.' }] },
  ],
};

beforeEach(() => {
  startSpan.mockClear();
  span.setAttribute.mockClear();
  span.setAttributes.mockClear();
});

describe('request parts', () => {
  const thumb = { data: 'AA', mime_type: 'image/jpeg' };

  it('builds a text turn for either role', () => {
    expect(textTurn('assistant', 'earlier')).toEqual({
      role: 'assistant',
      parts: [{ type: 'text', text: 'earlier' }],
    });
    expect(textTurn('user', 'again').role).toBe('user');
  });

  it('captions the images it has and skips missing ones', () => {
    expect(imageParts('Thumbnails:', [thumb, null, thumb])).toEqual([
      { type: 'text', text: 'Thumbnails:' },
      { type: 'image', ...thumb },
      { type: 'image', ...thumb },
    ]);
  });

  it('adds no caption when there are no images', () => {
    expect(imageParts('Thumbnails:', [])).toEqual([]);
    expect(imageParts('Thumbnails:', [null, null])).toEqual([]);
  });
});

const SENTINEL = 'youtube-sentinel-91c';
const youtubeRequest: ModelRequest = {
  system: 'Pick.',
  turns: [
    {
      role: 'user',
      parts: [
        { type: 'text', text: '{"songTitle":"PeekaBoo"}' },
        youtubePart({ recentUploads: [{ title: SENTINEL }, { title: 'b' }] }, 2),
      ],
    },
  ],
};

describe('YouTube text in spans', () => {
  it('replaces a YouTube part with a counted placeholder and keeps untagged text', () => {
    expect(redactTurns(youtubeRequest.turns)).toEqual([
      {
        role: 'user',
        parts: [
          { type: 'text', content: '{"songTitle":"PeekaBoo"}' },
          { type: 'text', content: '[YouTube uploads: 2]' },
        ],
      },
    ]);
  });

  it('keeps the YouTube text out of every invoke_agent and chat span attribute', async () => {
    await invokeAgent(SMART_PICK, FLASH, async (agent) => {
      agentInput(agent, youtubeRequest);
      await chatSpan(
        youtubeRequest,
        { agent: SMART_PICK, model: FLASH, maxTokens: 1 },
        async () => ({
          content: '{}',
          reasoning: '',
          usage: {},
          finishReason: 'stop',
          responseId: null,
        }),
      );
    });
    const recorded = JSON.stringify([
      startSpan.mock.calls.map(([options]) => options),
      span.setAttribute.mock.calls,
      span.setAttributes.mock.calls,
    ]);
    expect(recorded).toContain('[YouTube uploads: 2]');
    expect(recorded).not.toContain(SENTINEL);
  });
});

describe('redactTurns', () => {
  it('keeps every text and replaces media with placeholders', () => {
    expect(redactTurns(request.turns)).toEqual([
      {
        role: 'user',
        parts: [
          { type: 'text', content: '{"songTitle":"PeekaBoo"}' },
          { type: 'image', mime: 'image/jpeg', bytes: 26 },
          { type: 'video', mime: 'video/mp4', bytes: CLIP.byteLength, clip: '60s–120s' },
        ],
      },
      { role: 'assistant', parts: [{ type: 'text', content: '{"title":"first"}' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Again.' }] },
    ]);
  });

  it('leaves no media payload in the output', () => {
    const out = JSON.stringify(redactTurns(request.turns));
    expect(out).not.toContain(IMAGE_B64);
    expect(out).not.toContain(CLIP_B64);
    expect(out).not.toContain('data');
  });

  it('accounts for base64 padding and empty media in the byte count', () => {
    const [turn] = redactTurns([
      {
        role: 'user',
        parts: [
          { type: 'image', data: 'QQ==', mime_type: 'image/png' },
          { type: 'image', data: 'QUI=', mime_type: 'image/png' },
          { type: 'video', data: new Uint8Array(), mime_type: 'video/mp4', start: 0, end: 0.5 },
        ],
      },
    ]) as { parts: unknown[] }[];
    expect(turn!.parts).toEqual([
      { type: 'image', mime: 'image/png', bytes: 1 },
      { type: 'image', mime: 'image/png', bytes: 2 },
      { type: 'video', mime: 'video/mp4', bytes: 0, clip: '0s–0.5s' },
    ]);
  });

  it('returns an empty list for no turns', () => {
    expect(redactTurns([])).toEqual([]);
  });
});

describe('invokeAgent', () => {
  it('opens an invoke_agent span for the agent and its model', async () => {
    const result = await invokeAgent(CHUNK_ANALYST, FLASH, async (s) => {
      expect(s).toBe(span);
      return 7;
    });
    expect(result).toBe(7);
    expect(lastOptions()).toEqual({
      op: 'gen_ai.invoke_agent',
      name: 'invoke_agent chunk-analyst',
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': CHUNK_ANALYST,
        'gen_ai.pipeline.name': PIPELINE,
        'gen_ai.request.model': FLASH,
        'gen_ai.provider.name': 'gcp.gemini',
      },
    });
  });

  it('propagates callback errors', async () => {
    await expect(
      invokeAgent(SMART_PICK, 'gemini-4-argon', async () => {
        throw new Error('model down');
      }),
    ).rejects.toThrow('model down');
  });
});

describe('agentInput', () => {
  it('records system instructions and the redacted turns on the agent span', () => {
    agentInput(span as unknown as Span, request);
    const attributes = span.setAttributes.mock.calls[0]![0] as Record<string, string>;
    expect(JSON.parse(attributes['gen_ai.system_instructions']!)).toEqual([
      { type: 'text', content: 'Instructions' },
    ]);
    expect(JSON.parse(attributes['gen_ai.input.messages']!)).toEqual(redactTurns(request.turns));
    expect(JSON.stringify(attributes)).not.toContain(IMAGE_B64);
    expect(JSON.stringify(attributes)).not.toContain(CLIP_B64);
  });

  it('omits system instructions when the request has none', () => {
    agentInput(span as unknown as Span, { system: '', turns: request.turns });
    expect(span.setAttributes).toHaveBeenCalledWith({
      'gen_ai.input.messages': JSON.stringify(redactTurns(request.turns)),
    });
  });
});

describe('agentOutput', () => {
  it('records the answer as one assistant text part', () => {
    agentOutput(span as unknown as Span, '{"title":"PeekaBoo"}');
    expect(span.setAttribute).toHaveBeenCalledWith(
      'gen_ai.output.messages',
      JSON.stringify([
        { role: 'assistant', parts: [{ type: 'text', content: '{"title":"PeekaBoo"}' }] },
      ]),
    );
  });

  it('records an empty answer as an empty text part', () => {
    agentOutput(span as unknown as Span, '');
    const [, value] = span.setAttribute.mock.calls[0]!;
    expect(JSON.parse(value as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: '' }] },
    ]);
  });
});

describe('guide proposals in spans', () => {
  const SENTINEL_GUIDE = 'SENTINEL-GUIDE-7f3';
  const guide = { agent: 'voice-guide', model: FLASH, maxTokens: 8192 } as const;

  it('records a guide agent answer as its length only', () => {
    agentOutput(span as unknown as Span, SENTINEL_GUIDE, 'brand-guide');
    expect(span.setAttribute).toHaveBeenCalledWith(
      'gen_ai.output.messages',
      JSON.stringify([
        {
          role: 'assistant',
          parts: [{ type: 'text', content: `[guide proposal: ${SENTINEL_GUIDE.length} chars]` }],
        },
      ]),
    );
  });

  it('keeps a guide reply, its reasoning and a resent reply out of the chat span', async () => {
    const resent: ModelRequest = {
      system: 'Rules.',
      turns: [
        { role: 'user', parts: [{ type: 'text', text: 'Evidence.' }] },
        { role: 'assistant', parts: [{ type: 'text', text: SENTINEL_GUIDE, source: 'guide' }] },
      ],
    };
    await chatSpan(resent, guide, async () => ({
      content: SENTINEL_GUIDE,
      reasoning: `${SENTINEL_GUIDE} thoughts`,
      usage: {},
      finishReason: 'stop',
      responseId: null,
    }));
    const recorded = JSON.stringify([
      startSpan.mock.calls.map(([options]) => options),
      span.setAttributes.mock.calls,
    ]);
    expect(recorded).not.toContain(SENTINEL_GUIDE);
    expect(recorded).toContain(`[guide proposal: ${SENTINEL_GUIDE.length} chars]`);
    expect(recorded).toContain(`[guide proposal: ${SENTINEL_GUIDE.length + 9} chars]`);
  });
});

describe('YouTube values in peer-match and smart-pick spans', () => {
  const METRIC = 987654;
  const PEER_TITLE = 'Velvet Static Arcade';
  const CHANNEL = 'Moonline Ghosts';
  const PEER_SENTENCE = 'Recorded live in a parking garage';
  const youtube: ModelRequest = {
    system: 'Rules.',
    turns: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: '{"songTitle":"PeekaBoo"}' },
          youtubePart(
            { peers: [{ ref: 'P1', title: CHANNEL, stats: { views: METRIC } }] },
            1,
            'YouTube peers',
          ),
          youtubePart(
            {
              releases: [
                { ref: 'P1-R1', title: PEER_TITLE, description: `${PEER_SENTENCE}. Out now!` },
              ],
            },
            1,
            'YouTube releases',
          ),
          {
            type: 'youtube',
            url: 'https://www.youtube.com/watch?v=abcdefghijk',
            start: 0,
            end: 60,
          },
        ],
      },
    ],
  };
  const echo = `P1 (${CHANNEL}) got ${METRIC.toLocaleString('en-US')} views on "${PEER_TITLE}", ${PEER_SENTENCE.toLowerCase()}; keep the plain wording.`;
  const recorded = () =>
    JSON.stringify([
      startSpan.mock.calls.map(([options]) => options),
      span.setAttributes.mock.calls,
      span.setAttribute.mock.calls,
    ]);
  const expectRedacted = (text: string) => {
    for (const value of [String(METRIC), '987,654', PEER_TITLE, CHANNEL, PEER_SENTENCE]) {
      expect(text.toLowerCase()).not.toContain(value.toLowerCase());
    }
    expect(text).toContain(YOUTUBE_VALUE);
    expect(text).toContain('keep the plain wording');
    expect(text).not.toContain('youtube.com');
  };

  it.each(['peer-match', 'smart-pick'] as const)(
    'keeps %s reply, reasoning and a resent reply with every YouTube value replaced',
    async (agent) => {
      const resent: ModelRequest = {
        ...youtube,
        turns: [
          ...youtube.turns,
          { role: 'assistant', parts: [{ type: 'text', text: echo, source: 'reply' }] },
          textTurn('user', 'Again.'),
        ],
      };
      await chatSpan(resent, { agent, model: FLASH, maxTokens: 2048 }, async () => ({
        content: echo,
        reasoning: `Thinking: ${echo}`,
        usage: {},
        finishReason: 'stop',
        responseId: null,
      }));
      expectRedacted(recorded());
      expect(recorded()).toContain('[YouTube peers: 1]');
      expect(recorded()).toContain('[YouTube releases: 1]');
      expect(recorded()).toContain('{\\"type\\":\\"video\\",\\"source\\":\\"youtube\\"}');
    },
  );

  it('redacts the agent output with the values of the input the agent recorded', () => {
    agentInput(span as unknown as Span, youtube);
    agentOutput(span as unknown as Span, echo, 'smart-pick');
    expectRedacted(recorded());
  });

  it('keeps another agent reply as it is', async () => {
    await chatSpan(youtube, { agent: 'hook-pick', model: FLASH, maxTokens: 8192 }, async () => ({
      content: echo,
      reasoning: '',
      usage: {},
      finishReason: 'stop',
      responseId: null,
    }));
    expect(recorded()).toContain(PEER_TITLE);
  });

  it('matches whole words and numbers only, longest first', () => {
    const redact = youtubeRedactor([
      { role: 'user', parts: [youtubePart({ a: 'Neon', b: 'Neon Drive', n: 120 }, 1)] },
    ]);
    expect(redact('Neon Drive and neon and Neonlight, 120 and 1200 and 120.5')).toBe(
      `${YOUTUBE_VALUE} and ${YOUTUBE_VALUE} and Neonlight, ${YOUTUBE_VALUE} and 1200 and ${YOUTUBE_VALUE}.5`,
    );
  });

  it('changes nothing when the request has no YouTube parts', () => {
    expect(youtubeRedactor(request.turns)('PeekaBoo 2026')).toBe('PeekaBoo 2026');
  });

  it('redacts short strings and single digits too', () => {
    const redact = youtubeRedactor([
      { role: 'user', parts: [youtubePart({ a: 'U2', n: 3, m: -42 }, 1)] },
    ]);
    expect(redact('U2 gained 3, lost -42; P3 stays')).toBe(
      `${YOUTUBE_VALUE} gained ${YOUTUBE_VALUE}, lost ${YOUTUBE_VALUE}; P3 stays`,
    );
  });
});

describe('chatSpan', () => {
  const PARAMS = { agent: CHUNK_ANALYST, model: FLASH, maxTokens: 2048 } as const;
  const reply = (over: Partial<ChatReply> = {}): ChatReply => ({
    content: VISUAL_JSON,
    reasoning: '',
    usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020, cachedInputTokens: 300 },
    finishReason: 'stop',
    responseId: 'interaction-1',
    ...over,
  });

  it('records the agent, model, provider, cap, system instructions, and redacted input', async () => {
    const result = await chatSpan(request, PARAMS, async () => reply());
    expect(result.content).toBe(VISUAL_JSON);

    const options = lastOptions();
    expect(options.op).toBe('gen_ai.chat');
    expect(options.name).toBe(`chat ${FLASH}`);
    expect(options.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': PROVIDER,
      'gen_ai.request.model': FLASH,
      'gen_ai.agent.name': CHUNK_ANALYST,
      'gen_ai.pipeline.name': PIPELINE,
      'gen_ai.request.max_tokens': 2048,
    });
    expect(options.attributes).not.toHaveProperty('gen_ai.request.temperature');
    expect(JSON.parse(options.attributes['gen_ai.system_instructions'] as string)).toEqual([
      { type: 'text', content: 'Instructions' },
    ]);
    const input = options.attributes['gen_ai.input.messages'] as string;
    expect(JSON.parse(input)).toEqual(redactTurns(request.turns));
    expect(input).not.toContain(IMAGE_B64);
    expect(input).not.toContain(CLIP_B64);
  });

  it('records the reply, reasoning, finish reason, id, and every token count', async () => {
    await chatSpan(request, PARAMS, async () =>
      reply({ reasoning: 'thinking', usage: { ...reply().usage, reasoningTokens: 40 } }),
    );
    expect(span.setAttributes).toHaveBeenCalledWith({
      'gen_ai.response.model': FLASH,
      'gen_ai.output.messages': JSON.stringify([
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', content: 'thinking' },
            { type: 'text', content: VISUAL_JSON },
          ],
          finish_reason: 'stop',
        },
      ]),
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.response.id': 'interaction-1',
      'gen_ai.usage.input_tokens': 900,
      'gen_ai.usage.output_tokens': 120,
      'gen_ai.usage.total_tokens': 1020,
      'gen_ai.usage.cache_read.input_tokens': 300,
      'gen_ai.usage.reasoning.output_tokens': 40,
    });
  });

  it('records a cut-off reply that will not parse, with its finish reason', async () => {
    await chatSpan(request, PARAMS, async () =>
      reply({ content: '{"visual":', finishReason: 'length' }),
    );
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'gen_ai.output.messages': JSON.stringify([
          {
            role: 'assistant',
            parts: [{ type: 'text', content: '{"visual":' }],
            finish_reason: 'length',
          },
        ]),
        'gen_ai.response.finish_reasons': ['length'],
      }),
    );
  });

  it('omits system instructions, finish reason, id, and token details the provider did not send', async () => {
    await chatSpan(
      { system: '', turns: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
      PARAMS,
      async () => reply({ usage: {}, finishReason: null, responseId: null }),
    );
    expect(lastOptions().attributes).not.toHaveProperty('gen_ai.system_instructions');
    expect(span.setAttributes).toHaveBeenCalledWith({
      'gen_ai.response.model': FLASH,
      'gen_ai.output.messages': JSON.stringify([
        { role: 'assistant', parts: [{ type: 'text', content: VISUAL_JSON }] },
      ]),
      'gen_ai.usage.input_tokens': 0,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.usage.total_tokens': 0,
    });
  });

  it('rethrows the same error object and sets no output when the call fails', async () => {
    class Busy extends Error {
      readonly until = 42;
    }
    const thrown = new Busy('busy');
    const caught = await chatSpan(request, PARAMS, async () => {
      throw thrown;
    }).catch((error: unknown) => error);
    expect(caught).toBe(thrown);
    expect((caught as Busy).until).toBe(42);
    expect(span.setAttributes).not.toHaveBeenCalled();
  });
});

describe('toolSpan', () => {
  it('opens an execute_tool span with serialized arguments', async () => {
    const result = await toolSpan(
      SMART_PICK,
      'hashtag_search',
      { query: 'synthwave music video' },
      async (s) => {
        expect(s).toBe(span);
        return ['#synthwave'];
      },
    );
    expect(result).toEqual(['#synthwave']);
    expect(lastOptions()).toEqual({
      op: 'gen_ai.execute_tool',
      name: 'execute_tool hashtag_search',
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.pipeline.name': PIPELINE,
        'gen_ai.agent.name': SMART_PICK,
        'gen_ai.tool.name': 'hashtag_search',
        'gen_ai.tool.call.arguments': '{"query":"synthwave music video"}',
      },
    });
  });
});

describe('startJobTrace', () => {
  it('starts a new trace with a job transaction and returns its headers', () => {
    getTraceData.mockReturnValueOnce({ 'sentry-trace': 'abc-123-1', baggage: 'sentry-release=1' });
    expect(startJobTrace('job-1')).toEqual({
      sentryTrace: 'abc-123-1',
      baggage: 'sentry-release=1',
    });
    expect(startNewTrace).toHaveBeenCalled();
    expect(lastOptions()).toEqual({
      op: 'job.create',
      name: 'job',
      forceTransaction: true,
      attributes: { 'job.id': 'job-1' },
    });
  });

  it('defaults baggage to an empty string', () => {
    getTraceData.mockReturnValueOnce({ 'sentry-trace': 'abc-123-0' });
    expect(startJobTrace('job-2')).toEqual({ sentryTrace: 'abc-123-0', baggage: '' });
  });

  it('returns null when Sentry has no trace to propagate', () => {
    getTraceData.mockReturnValueOnce({});
    expect(startJobTrace('job-3')).toBeNull();
  });
});
