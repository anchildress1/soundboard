// @vitest-environment node
import { tracingChannel } from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSpan } from '../../../../mocks/sentry';
import {
  chat,
  chatJson,
  modelFor,
  ModelBusy,
  ModelQuotaSpent,
  STEP_BUDGET_MS,
  stepDeadline,
  type Agent,
} from '$lib/server/ai/model';
import { CLAIM_TTL_MS } from '$lib/server/jobs/jobs';
import type { ModelRequest } from '$lib/server/core/tracing';
import { quotaResetAt } from '$lib/server/platforms/youtube/youtube';
import {
  busy429,
  geminiError,
  GEMINI_INTERACTIONS,
  interaction,
  perDay429,
  perDay429BodyOnly,
  unavailable503,
} from '../../../../helpers/gemini';

const OK_JSON = '{"ok":true}';
const KEY = 'test-gemini-key';
const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
const isOk = (v: unknown): v is { ok: boolean } =>
  typeof v === 'object' && v !== null && 'ok' in v && typeof v.ok === 'boolean';

const CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const THUMB = Buffer.from('thumb-jpeg').toString('base64');

const request: ModelRequest = {
  system: 'Report in JSON.',
  turns: [{ role: 'user', parts: [{ type: 'text', text: 'Analyze.' }] }],
};
const videoRequest: ModelRequest = {
  system: 'Describe the window.',
  turns: [
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'Window 2.' },
        { type: 'video', data: CLIP, mime_type: 'video/mp4', start: 60, end: 120 },
      ],
    },
  ],
};
const imageRequest: ModelRequest = {
  system: 'Pick.',
  turns: [
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'Thumbnails.' },
        { type: 'image', data: THUMB, mime_type: 'image/jpeg' },
      ],
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
let now: number;

type Sent = { url: string; headers: Headers; body: Record<string, unknown> & { input: Step[] } };
type Step = { type: string; content: Record<string, unknown>[] };
const sent = (call = 0): Sent => {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return {
    url,
    headers: new Headers(init.headers),
    body: JSON.parse(init.body as string) as Sent['body'],
  };
};

beforeEach(() => {
  vi.stubEnv('GEMINI_API_KEY', KEY);
  vi.stubEnv('GEMINI_ANALYST_MODEL', '');
  vi.stubEnv('GEMINI_PICK_MODEL', '');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  now = Date.parse('2026-10-24T19:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const AGENT_SETTINGS: [Agent, string, string, number][] = [
  ['chunk-analyst', 'gemini-3.8-flash', 'low', 2048],
  ['smart-pick', 'gemini-4-argon', 'medium', 8192],
  ['hook-pick', 'gemini-4-argon', 'low', 8192],
  ['brand-guide', 'gemini-4-argon', 'medium', 8192],
];

describe('chat request', () => {
  it.each(AGENT_SETTINGS)(
    '%s sends its model, thinking level, and token cap, with no temperature',
    async (agent, model, thinking, cap) => {
      fetchMock.mockResolvedValue(interaction(OK_JSON));
      await chat(request, agent, schema, stepDeadline());
      const { body } = sent();
      expect(body.model).toBe(model);
      expect(body.generation_config).toEqual({ max_output_tokens: cap, thinking_level: thinking });
      expect(modelFor(agent)).toBe(model);
    },
  );

  it('posts to the Interactions API with the key alone, unstored, schema-constrained', async () => {
    fetchMock.mockResolvedValue(interaction(OK_JSON));
    await chat(request, 'smart-pick', schema, stepDeadline());
    const { url, headers, body } = sent();
    expect(url).toBe(GEMINI_INTERACTIONS);
    expect(headers.get('x-goog-api-key')).toBe(KEY);
    expect(headers.has('authorization')).toBe(false);
    expect(body.store).toBe(false);
    expect(body.system_instruction).toBe('Report in JSON.');
    expect(JSON.stringify(body.response_format)).toContain(JSON.stringify(schema));
    expect(body.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'Analyze.' }] },
    ]);
  });

  it('reads model names from the environment', async () => {
    vi.stubEnv('GEMINI_ANALYST_MODEL', 'gemini-3.5-flash-lite');
    vi.stubEnv('GEMINI_PICK_MODEL', 'gemini-3.8-flash');
    fetchMock.mockImplementation(async () => interaction(OK_JSON));
    await chat(request, 'chunk-analyst', schema, stepDeadline());
    await chat(request, 'hook-pick', schema, stepDeadline());
    expect(sent(0).body.model).toBe('gemini-3.5-flash-lite');
    expect(sent(1).body.model).toBe('gemini-3.8-flash');
  });

  it('sends the analyst clip as one inline low-resolution video part, no URL', async () => {
    fetchMock.mockResolvedValue(interaction(OK_JSON));
    await chat(videoRequest, 'chunk-analyst', schema, stepDeadline());
    const [step] = sent().body.input;
    expect(step!.content).toEqual([
      { type: 'text', text: 'Window 2.' },
      {
        type: 'video',
        data: Buffer.from(CLIP).toString('base64'),
        mime_type: 'video/mp4',
        resolution: 'low',
      },
    ]);
    expect(JSON.stringify(sent().body)).not.toContain('uri');
  });

  it('keeps full resolution for pick thumbnails', async () => {
    fetchMock.mockResolvedValue(interaction(OK_JSON));
    await chat(imageRequest, 'smart-pick', schema, stepDeadline());
    const [step] = sent().body.input;
    expect(step!.content[1]).toEqual({ type: 'image', data: THUMB, mime_type: 'image/jpeg' });
  });

  it('publishes nothing on the AI SDK telemetry channel', async () => {
    const events: string[] = [];
    const channel = tracingChannel('ai:telemetry');
    const handlers = {
      start: () => events.push('start'),
      end: () => events.push('end'),
      asyncStart: () => events.push('asyncStart'),
      asyncEnd: () => events.push('asyncEnd'),
      error: () => events.push('error'),
    };
    channel.subscribe(handlers);
    try {
      fetchMock.mockResolvedValue(interaction(OK_JSON));
      await chat(request, 'chunk-analyst', schema, stepDeadline());
    } finally {
      channel.unsubscribe(handlers);
    }
    expect(events).toEqual([]);
  });

  it('builds a new client when the key changes', async () => {
    fetchMock.mockImplementation(async () => interaction(OK_JSON));
    await chat(request, 'smart-pick', schema, stepDeadline());
    vi.stubEnv('GEMINI_API_KEY', 'rotated-key');
    await chat(request, 'smart-pick', schema, stepDeadline());
    expect(sent(1).headers.get('x-goog-api-key')).toBe('rotated-key');
  });

  it('fails before any request when the key is missing', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    await expect(chat(request, 'smart-pick', schema, stepDeadline())).rejects.toThrow(
      'Missing required env var GEMINI_API_KEY',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chat reply', () => {
  it('returns the text, reasoning, finish reason, id, usage, and wall time', async () => {
    fetchMock.mockImplementation(async () => {
      now += 1234;
      return interaction(OK_JSON, { reasoning: 'hmm', id: 'interaction-9' });
    });
    expect(await chat(request, 'chunk-analyst', schema, now + STEP_BUDGET_MS)).toEqual({
      content: OK_JSON,
      reasoning: 'hmm',
      usage: {
        inputTokens: 10,
        outputTokens: 8,
        totalTokens: 18,
        cachedInputTokens: 2,
        reasoningTokens: 3,
      },
      finishReason: 'stop',
      responseId: 'interaction-9',
      ms: 1234,
    });
  });

  it('reports empty reasoning when the reply has no thought step', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'text', text: OK_JSON }] }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    expect(await chat(request, 'smart-pick', schema, stepDeadline())).toMatchObject({
      content: OK_JSON,
      reasoning: '',
      usage: { inputTokens: undefined, outputTokens: undefined },
    });
  });

  it('names the chat span for the call model and agent', async () => {
    fetchMock.mockResolvedValue(interaction(OK_JSON));
    await chat(request, 'hook-pick', schema, stepDeadline());
    expect(startSpan).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'chat gemini-4-argon',
        attributes: expect.objectContaining({
          'gen_ai.agent.name': 'hook-pick',
          'gen_ai.provider.name': 'gcp.gemini',
        }),
      }),
      expect.any(Function),
    );
  });

  it('returns unparseable text with its usage instead of throwing', async () => {
    fetchMock.mockResolvedValue(interaction('{"ok":'));
    const reply = await chat(request, 'smart-pick', schema, stepDeadline());
    expect(reply).toMatchObject({
      content: '{"ok":',
      finishReason: 'stop',
      responseId: 'interaction-1',
    });
    expect(reply.usage.inputTokens).toBe(10);
  });

  it('reports an incomplete interaction as a length cut-off', async () => {
    fetchMock.mockResolvedValue(interaction('', { status: 'incomplete' }));
    expect(await chat(request, 'smart-pick', schema, stepDeadline())).toMatchObject({
      content: '',
      finishReason: 'length',
    });
  });
});

describe('chat errors', () => {
  it('turns a per-day QuotaFailure into ModelQuotaSpent until midnight Pacific', async () => {
    fetchMock.mockResolvedValue(perDay429());
    const error = await chat(request, 'smart-pick', schema, stepDeadline()).catch((e) => e);
    expect(error).toBeInstanceOf(ModelQuotaSpent);
    expect((error as ModelQuotaSpent).until).toBe(quotaResetAt(now));
  });

  it('ignores details that are not a per-day QuotaFailure', async () => {
    fetchMock.mockResolvedValue(
      geminiError(429, 'RESOURCE_EXHAUSTED', [
        null,
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure' },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' },
      ]),
    );
    await expect(chat(request, 'smart-pick', schema, stepDeadline())).rejects.toBeInstanceOf(
      ModelBusy,
    );
  });

  it('falls back to the raw body when the error envelope does not parse', async () => {
    fetchMock.mockResolvedValue(perDay429BodyOnly());
    await expect(chat(request, 'smart-pick', schema, stepDeadline())).rejects.toBeInstanceOf(
      ModelQuotaSpent,
    );
  });

  it.each([
    ['a per-minute 429', busy429],
    ['a 429 with no details', () => geminiError(429, 'RESOURCE_EXHAUSTED')],
    ['a 429 with a non-JSON body', () => new Response('slow down', { status: 429 })],
    ['a 503', unavailable503],
  ])('turns %s into ModelBusy', async (_name, response) => {
    fetchMock.mockResolvedValue(response());
    const error = await chat(request, 'smart-pick', schema, stepDeadline()).catch((e) => e);
    expect(error).toBeInstanceOf(ModelBusy);
    expect(error).not.toBeInstanceOf(ModelQuotaSpent);
  });

  it.each([
    [400, 'INVALID_ARGUMENT'],
    [403, 'PERMISSION_DENIED'],
    [500, 'INTERNAL'],
  ])('fails on %i with a plain error that carries no request or cause', async (status, code) => {
    fetchMock.mockResolvedValue(geminiError(status, code));
    const error = (await chat(videoRequest, 'chunk-analyst', schema, stepDeadline()).catch(
      (e) => e,
    )) as Error;
    expect(error.constructor).toBe(Error);
    expect(error.message).toBe(`Gemini ${status}: ${code} from Gemini`);
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error)).toEqual([]);
  });

  it('labels a request that never reached Gemini', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }));
    await expect(chat(request, 'smart-pick', schema, stepDeadline())).rejects.toThrow(
      'Gemini unreachable: Cannot connect to API: ECONNRESET',
    );
  });

  it('passes a timeout through unchanged', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    fetchMock.mockRejectedValue(timeout);
    await expect(chat(request, 'smart-pick', schema, stepDeadline())).rejects.toBe(timeout);
  });

  it('reduces any other SDK error to its message', async () => {
    const error = (await chat(
      { system: 'x', turns: [] },
      'smart-pick',
      schema,
      stepDeadline(),
    ).catch((e) => e)) as Error;
    expect(error.constructor).toBe(Error);
    expect(error.message).toMatch(/^Gemini: /);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('step budget', () => {
  it('sets the deadline one budget ahead, inside the step claim', () => {
    expect(stepDeadline(1000)).toBe(1000 + STEP_BUDGET_MS);
    expect(STEP_BUDGET_MS).toBeLessThan(CLAIM_TTL_MS);
  });

  it.each([
    ['chunk-analyst', 7_999],
    ['smart-pick', 32_999],
    ['hook-pick', 34_999],
    ['brand-guide', 32_999],
    ['smart-pick', -1],
  ] as [Agent, number][])('%s refuses to start with %i ms left', async (agent, left) => {
    await expect(chat(request, agent, schema, now + left)).rejects.toThrow('ran out of time');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts with exactly its minimum budget and caps the call at the time left', async () => {
    fetchMock.mockResolvedValue(interaction(OK_JSON));
    await chat(request, 'chunk-analyst', schema, now + 8_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('chatJson', () => {
  it('returns the parsed value on the first valid reply', async () => {
    fetchMock.mockResolvedValue(interaction(OK_JSON));
    expect(await chatJson(request, 'smart-pick', schema, isOk, stepDeadline())).toEqual({
      value: { ok: true },
      raw: OK_JSON,
      ms: 0,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('re-asks once with the earlier answer as an assistant turn', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction('{"ok":'))
      .mockResolvedValueOnce(interaction(OK_JSON));
    const result = await chatJson(request, 'hook-pick', schema, isOk, stepDeadline());
    expect(result.value).toEqual({ ok: true });
    const { input } = sent(1).body;
    expect(input).toHaveLength(3);
    expect(input[0]).toEqual(sent(0).body.input[0]);
    expect(input[1]).toEqual({ type: 'model_output', content: [{ type: 'text', text: '{"ok":' }] });
    expect(input[2]!.type).toBe('user_input');
    expect(input[2]!.content[0]!.text).toMatch(/JSON/);
    expect(sent(1).body.system_instruction).toBe(request.system);
  });

  it('re-asks without an assistant turn when the reply was empty', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction('', { status: 'incomplete' }))
      .mockResolvedValueOnce(interaction(OK_JSON));
    await chatJson(request, 'smart-pick', schema, isOk, stepDeadline());
    expect(sent(1).body.input.map((s) => s.type)).toEqual(['user_input', 'user_input']);
  });

  it('re-asks a cut-off reply even when its text parses', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction(OK_JSON, { status: 'incomplete' }))
      .mockResolvedValueOnce(interaction('{"ok":false}'));
    expect((await chatJson(request, 'smart-pick', schema, isOk, stepDeadline())).value).toEqual({
      ok: false,
    });
  });

  it('re-asks when the JSON fails validation', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction('{"ok":"yes"}'))
      .mockResolvedValueOnce(interaction(OK_JSON));
    expect((await chatJson(request, 'smart-pick', schema, isOk, stepDeadline())).value).toEqual({
      ok: true,
    });
  });

  it('keeps the last raw text after two failures and records both on chat spans', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction('first'))
      .mockResolvedValueOnce(interaction('second'));
    startSpan.mockClear();
    expect(await chatJson(request, 'brand-guide', schema, isOk, stepDeadline())).toEqual({
      value: null,
      raw: 'second',
      ms: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const chats = startSpan.mock.calls.filter(([o]) => (o as { op: string }).op === 'gen_ai.chat');
    expect(chats).toHaveLength(2);
  });

  it('adds up model time across attempts', async () => {
    fetchMock.mockImplementation(async () => {
      now += 1000;
      return interaction('nope');
    });
    expect((await chatJson(request, 'chunk-analyst', schema, isOk, stepDeadline())).ms).toBe(2000);
  });

  it("skips the re-ask when less than the agent's minimum budget is left", async () => {
    fetchMock.mockImplementation(async () => {
      now += 2_000;
      return interaction('nope');
    });
    expect(await chatJson(request, 'smart-pick', schema, isOk, now + 34_000)).toEqual({
      value: null,
      raw: 'nope',
      ms: 2000,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('propagates typed errors rather than re-asking', async () => {
    fetchMock.mockResolvedValue(busy429());
    await expect(
      chatJson(request, 'smart-pick', schema, isOk, stepDeadline()),
    ).rejects.toBeInstanceOf(ModelBusy);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
