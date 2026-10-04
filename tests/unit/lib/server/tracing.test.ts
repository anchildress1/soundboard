// @vitest-environment node
import * as Sentry from '@sentry/sveltekit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatSpan,
  invokeAgent,
  MODEL_NAME,
  PIPELINE,
  PROVIDER,
  redactMessages,
  startJobTrace,
  toolSpan,
  type ChatMessage,
  type ChatReply,
} from '$lib/server/tracing';

import { span } from '../../../mocks/sentry';

const startSpan = vi.mocked(Sentry.startSpan);
const getTraceData = vi.mocked(Sentry.getTraceData);
type SpanOptions = { op: string; name: string; attributes: Record<string, unknown> };
const lastOptions = () => startSpan.mock.calls.at(-1)![0] as unknown as SpanOptions;

const IMAGE_B64 = Buffer.from('fake-jpeg-bytes-0123456789').toString('base64');
const AUDIO_B64 = Buffer.from('RIFF-fake-wav-data').toString('base64');

const multimodal: ChatMessage[] = [
  { role: 'system', content: 'Instructions' },
  {
    role: 'user',
    content: [
      { type: 'text', text: '{"songTitle":"PeekaBoo"}' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${IMAGE_B64}` } },
      { type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'wav' } },
    ],
  },
];

beforeEach(() => {
  startSpan.mockClear();
  span.setAttribute.mockClear();
  span.setAttributes.mockClear();
});

describe('redactMessages', () => {
  it('replaces images and audio with {type, mime, bytes} placeholders', () => {
    expect(redactMessages(multimodal)).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'Instructions' }] },
      {
        role: 'user',
        parts: [
          { type: 'text', content: '{"songTitle":"PeekaBoo"}' },
          { type: 'image', mime: 'image/jpeg', bytes: 26 },
          { type: 'audio', mime: 'audio/wav', bytes: 18 },
        ],
      },
    ]);
  });

  it('leaves no base64 payload in the output', () => {
    const out = JSON.stringify(redactMessages(multimodal));
    expect(out).not.toContain(IMAGE_B64);
    expect(out).not.toContain(AUDIO_B64);
    expect(out).not.toContain('base64');
  });

  it('accounts for base64 padding in the byte count', () => {
    const [msg] = redactMessages([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } },
          { type: 'input_audio', input_audio: { data: 'QUI=', format: 'mp3' } },
          { type: 'input_audio', input_audio: { data: '', format: 'wav' } },
        ],
      },
    ]) as { parts: unknown[] }[];
    expect(msg!.parts).toEqual([
      { type: 'image', mime: 'image/png', bytes: 1 },
      { type: 'audio', mime: 'audio/mp3', bytes: 2 },
      { type: 'audio', mime: 'audio/wav', bytes: 0 },
    ]);
  });

  it('labels a non-data image URL with an unknown mime and no URL', () => {
    const [msg] = redactMessages([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://i.example/t.jpg' } }],
      },
    ]) as { parts: { type: string; mime: string }[] }[];
    expect(msg!.parts[0]).toMatchObject({ type: 'image', mime: 'unknown' });
    expect(JSON.stringify(msg)).not.toContain('i.example');
  });

  it('returns an empty list for no messages', () => {
    expect(redactMessages([])).toEqual([]);
  });
});

describe('invokeAgent', () => {
  it('opens an invoke_agent span named for the agent and passes it to the callback', async () => {
    const result = await invokeAgent('chunk-analyst', async (s) => {
      expect(s).toBe(span);
      return 7;
    });
    expect(result).toBe(7);
    expect(lastOptions()).toEqual({
      op: 'gen_ai.invoke_agent',
      name: 'invoke_agent chunk-analyst',
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'chunk-analyst',
        'gen_ai.pipeline.name': PIPELINE,
        'gen_ai.request.model': MODEL_NAME,
        'gen_ai.provider.name': PROVIDER,
      },
    });
  });

  it('propagates callback errors', async () => {
    await expect(
      invokeAgent('smart-pick', async () => {
        throw new Error('model down');
      }),
    ).rejects.toThrow('model down');
  });
});

describe('chatSpan', () => {
  const PARAMS = { agent: 'chunk-analyst', temperature: 0.2, maxTokens: 2048 } as const;
  const reply = (over: Partial<ChatReply> = {}): ChatReply => ({
    content: '{"visual":"neon"}',
    reasoning: '',
    usage: {
      prompt_tokens: 900,
      completion_tokens: 120,
      total_tokens: 1020,
      prompt_tokens_details: { cached_tokens: 300 },
    },
    finishReason: 'stop',
    responseId: 'chatcmpl-1',
    ...over,
  });

  it('records the agent, parameters, system instructions, and redacted input', async () => {
    const result = await chatSpan(multimodal, PARAMS, async () => reply());
    expect(result.content).toBe('{"visual":"neon"}');

    const options = lastOptions();
    expect(options.op).toBe('gen_ai.chat');
    expect(options.name).toBe(`chat ${MODEL_NAME}`);
    expect(options.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': PROVIDER,
      'gen_ai.request.model': MODEL_NAME,
      'gen_ai.agent.name': 'chunk-analyst',
      'gen_ai.pipeline.name': PIPELINE,
      'gen_ai.request.temperature': 0.2,
      'gen_ai.request.max_tokens': 2048,
    });
    expect(options.attributes).not.toHaveProperty('gen_ai.system');
    expect(JSON.parse(options.attributes['gen_ai.system_instructions'] as string)).toEqual([
      { type: 'text', content: 'Instructions' },
    ]);
    const input = options.attributes['gen_ai.input.messages'] as string;
    expect(JSON.parse(input)).toEqual(redactMessages(multimodal.slice(1)));
    expect(input).not.toContain('Instructions');
    expect(input).not.toContain(IMAGE_B64);
    expect(input).not.toContain(AUDIO_B64);
  });

  it('records the reply, think block, finish reason, id, and every token count', async () => {
    await chatSpan(multimodal, PARAMS, async () =>
      reply({
        reasoning: 'thinking',
        usage: { ...reply().usage, completion_tokens_details: { reasoning_tokens: 40 } },
      }),
    );
    expect(span.setAttributes).toHaveBeenCalledWith({
      'gen_ai.response.model': MODEL_NAME,
      'gen_ai.output.messages': JSON.stringify([
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', content: 'thinking' },
            { type: 'text', content: '{"visual":"neon"}' },
          ],
          finish_reason: 'stop',
        },
      ]),
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.response.id': 'chatcmpl-1',
      'gen_ai.usage.input_tokens': 900,
      'gen_ai.usage.output_tokens': 120,
      'gen_ai.usage.total_tokens': 1020,
      'gen_ai.usage.cache_read.input_tokens': 300,
      'gen_ai.usage.reasoning.output_tokens': 40,
    });
  });

  it('omits system instructions, finish reason, id, and token details the server did not send', async () => {
    await chatSpan([{ role: 'user', content: 'hi' }], PARAMS, async () =>
      reply({ usage: {}, finishReason: null, responseId: null }),
    );
    expect(lastOptions().attributes).not.toHaveProperty('gen_ai.system_instructions');
    expect(span.setAttributes).toHaveBeenCalledWith({
      'gen_ai.response.model': MODEL_NAME,
      'gen_ai.output.messages': JSON.stringify([
        { role: 'assistant', parts: [{ type: 'text', content: '{"visual":"neon"}' }] },
      ]),
      'gen_ai.usage.input_tokens': 0,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.usage.total_tokens': 0,
    });
  });

  it('sets no output attributes when the call fails', async () => {
    await expect(
      chatSpan([], PARAMS, async () => {
        throw new Error('llama-server 500');
      }),
    ).rejects.toThrow('llama-server 500');
    expect(span.setAttributes).not.toHaveBeenCalled();
  });
});

describe('toolSpan', () => {
  it('opens an execute_tool span with serialized arguments', async () => {
    const result = await toolSpan(
      'smart-pick',
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
        'gen_ai.agent.name': 'smart-pick',
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
    expect(Sentry.startNewTrace).toHaveBeenCalled();
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
