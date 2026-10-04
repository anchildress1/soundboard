// @vitest-environment node
import * as Sentry from '@sentry/sveltekit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatSpan,
  invokeAgent,
  MODEL_NAME,
  PROVIDER,
  redactMessages,
  startJobTrace,
  toolSpan,
  type ChatMessage,
} from '$lib/server/tracing';

const span = { setAttribute: vi.fn(), setAttributes: vi.fn() };

vi.mock('@sentry/sveltekit', () => ({
  startSpan: vi.fn((_options: unknown, fn: (s: unknown) => unknown) => fn(span)),
  startNewTrace: vi.fn((fn: () => unknown) => fn()),
  getTraceData: vi.fn(() => ({})),
}));

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
  it('records redacted input, parameters, output, and token usage', async () => {
    const result = await chatSpan(multimodal, { temperature: 0.2, maxTokens: 2048 }, async () => ({
      content: '{"visual":"neon"}',
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
    }));
    expect(result.content).toBe('{"visual":"neon"}');

    const options = lastOptions();
    expect(options.op).toBe('gen_ai.chat');
    expect(options.name).toBe(`chat ${MODEL_NAME}`);
    expect(options.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.temperature': 0.2,
      'gen_ai.request.max_tokens': 2048,
      'gen_ai.request.model': MODEL_NAME,
    });
    const input = options.attributes['gen_ai.input.messages'] as string;
    expect(JSON.parse(input)).toEqual(redactMessages(multimodal));
    expect(input).not.toContain(IMAGE_B64);
    expect(input).not.toContain(AUDIO_B64);

    expect(span.setAttributes).toHaveBeenCalledWith({
      'gen_ai.response.model': MODEL_NAME,
      'gen_ai.output.messages': JSON.stringify([
        { role: 'assistant', parts: [{ type: 'text', content: '{"visual":"neon"}' }] },
      ]),
      'gen_ai.usage.input_tokens': 900,
      'gen_ai.usage.output_tokens': 120,
      'gen_ai.usage.total_tokens': 1020,
    });
  });

  it('records zero tokens when usage is missing', async () => {
    await chatSpan([], { temperature: 0.2, maxTokens: 2048 }, async () => ({
      content: '',
      usage: {},
    }));
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        'gen_ai.usage.total_tokens': 0,
      }),
    );
  });

  it('sets no output attributes when the call fails', async () => {
    await expect(
      chatSpan([], { temperature: 0.2, maxTokens: 2048 }, async () => {
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
