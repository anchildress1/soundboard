// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSpan } from '../../../mocks/sentry';
import { chat, chatJson, modelStatus, STEP_BUDGET_MS, stepDeadline } from '$lib/server/model';
import { CLAIM_TTL_MS } from '$lib/server/jobs';
import { MODEL_NAME, type ChatMessage } from '$lib/server/tracing';

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn(), scopes: [] as unknown[] }));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(options: { scopes: unknown }) {
      auth.scopes.push(options.scopes);
    }
    getAccessToken = auth.getAccessToken;
  },
}));

const OK_JSON = '{"ok":true}';
const ENDPOINT =
  'https://1.us-central1-2.prediction.vertexai.goog/v1/projects/2/locations/us-central1/endpoints/1/invoke';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const completion = (content: string | null, extra: Record<string, unknown> = {}) =>
  json(200, {
    choices: [{ message: { content, reasoning_content: 'thinking...' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...extra,
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('MODEL_URL', 'http://model.test');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const messages: ChatMessage[] = [
  { role: 'system', content: 'Report in JSON.' },
  { role: 'user', content: 'Analyze.' },
];
const schema = { type: 'object' };

describe('modelStatus', () => {
  it('is loading while /health answers 503', async () => {
    fetchMock.mockResolvedValueOnce(new Response('loading', { status: 503 }));
    expect(await modelStatus()).toBe('loading');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://model.test/health');
  });

  it('is loading while llama-server refuses connections', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await modelStatus()).toBe('loading');
  });

  it('is busy when every slot is processing', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { status: 'ok' }))
      .mockResolvedValueOnce(json(200, [{ is_processing: true }]));
    expect(await modelStatus()).toBe('busy');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://model.test/slots');
  });

  it('is ready when a slot is free', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, [{ is_processing: true }, { is_processing: false }]));
    expect(await modelStatus()).toBe('ready');
  });

  it('is ready when /slots lists no slots', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {})).mockResolvedValueOnce(json(200, []));
    expect(await modelStatus()).toBe('ready');
  });

  it('is ready when /slots is disabled (non-ok)', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(new Response('', { status: 501 }));
    expect(await modelStatus()).toBe('ready');
  });

  it('is ready when /slots throws or returns non-JSON', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {})).mockRejectedValueOnce(new Error('reset'));
    expect(await modelStatus()).toBe('ready');
    fetchMock
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(new Response('nope', { status: 200 }));
    expect(await modelStatus()).toBe('ready');
  });

  it('is loading while the scaled-to-zero endpoint answers 429', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Model is not yet ready', { status: 429 }));
    expect(await modelStatus()).toBe('loading');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('defaults to a local llama-server', async () => {
    vi.stubEnv('MODEL_URL', undefined);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await modelStatus();
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:8081/health');
  });
});

describe('chat', () => {
  it('sends a schema-constrained request at temperature 0.2 and returns content', async () => {
    fetchMock.mockResolvedValueOnce(completion(OK_JSON));
    const result = await chat(messages, 'chunk_analysis', schema);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://model.test/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: MODEL_NAME,
      temperature: 0.2,
      max_tokens: 2048,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'chunk_analysis', strict: true, schema },
      },
      messages,
    });
    expect(result.content).toBe(OK_JSON);
    expect(result.reasoning).toBe('thinking...');
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("reads the finish reason and id, and names the span for the schema's agent", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        id: 'chatcmpl-9',
        choices: [{ finish_reason: 'length', message: { content: '{}' } }],
        usage: { prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
      }),
    );
    const result = await chat(messages, 'chunk_analysis', schema);
    expect(result).toMatchObject({
      finishReason: 'length',
      responseId: 'chatcmpl-9',
      usage: { prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
    });
    const options = startSpan.mock.calls.at(-1)![0] as { attributes: Record<string, unknown> };
    expect(options.attributes['gen_ai.agent.name']).toBe('chunk-analyst');
  });

  it('reports no finish reason or id when the server omits them', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { choices: [{ message: { content: '{}' } }] }));
    expect(await chat(messages, 'brand_guide', schema)).toMatchObject({
      finishReason: null,
      responseId: null,
    });
  });

  it('never treats reasoning_content as the answer', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { choices: [{ message: { content: null, reasoning_content: '{"a":1}' } }] }),
    );
    const result = await chat(messages, 'smart_pick', schema);
    expect(result.content).toBe('');
    expect(result.reasoning).toBe('{"a":1}');
    expect(result.usage).toEqual({});
  });

  it('tolerates a response without choices', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    expect(await chat(messages, 'smart_pick', schema)).toMatchObject({
      content: '',
      reasoning: '',
    });
  });

  it('throws with the status and a truncated body on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(500), { status: 500 }));
    const err = (await chat(messages, 'smart_pick', schema).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(`llama-server 500: ${'x'.repeat(200)}`);
  });

  it('propagates transport errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    await expect(chat(messages, 'smart_pick', schema)).rejects.toThrow('timeout');
  });
});

describe('step budget', () => {
  it('sets the deadline one budget ahead, inside the step claim', () => {
    expect(stepDeadline(1000)).toBe(1000 + STEP_BUDGET_MS);
    expect(STEP_BUDGET_MS).toBeLessThan(CLAIM_TTL_MS);
  });

  it('refuses a call once the deadline has passed', async () => {
    await expect(chat(messages, 'smart_pick', schema, Date.now() - 1)).rejects.toThrow(
      'ran out of time',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the parse retry when too little budget is left', async () => {
    fetchMock.mockResolvedValueOnce(completion('bad'));
    const isObject = (v: unknown): v is object => typeof v === 'object';
    const result = await chatJson(messages, 'smart_pick', schema, isObject, Date.now() + 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ value: null, raw: 'bad' });
  });
});

describe('chatJson', () => {
  const isOk = (v: unknown): v is { ok: boolean } =>
    typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';

  it('returns the parsed value on the first valid reply', async () => {
    fetchMock.mockResolvedValueOnce(completion(OK_JSON));
    const result = await chatJson(messages, 'smart_pick', schema, isOk);
    expect(result.value).toEqual({ ok: true });
    expect(result.raw).toBe(OK_JSON);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once after a parse failure', async () => {
    fetchMock
      .mockResolvedValueOnce(completion('{"ok":tr'))
      .mockResolvedValueOnce(completion('{"ok":false}'));
    const result = await chatJson(messages, 'smart_pick', schema, isOk);
    expect(result.value).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once when the JSON fails validation', async () => {
    fetchMock
      .mockResolvedValueOnce(completion('{"ok":"yes"}'))
      .mockResolvedValueOnce(completion(OK_JSON));
    expect((await chatJson(messages, 'smart_pick', schema, isOk)).value).toEqual({ ok: true });
  });

  it('keeps the last raw text after two failures instead of throwing', async () => {
    fetchMock
      .mockResolvedValueOnce(completion('first bad'))
      .mockResolvedValueOnce(completion('second bad'));
    const result = await chatJson(messages, 'smart_pick', schema, isOk);
    expect(result).toMatchObject({ value: null, raw: 'second bad' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('adds up model time across attempts', async () => {
    // The clock moves only while the model "works", so the count of Date.now calls doesn't matter.
    let clock = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    fetchMock
      .mockImplementationOnce(async () => {
        clock += 400;
        return completion('bad');
      })
      .mockImplementationOnce(async () => {
        clock += 250;
        return completion('bad');
      });
    const result = await chatJson(messages, 'smart_pick', schema, isOk, 1_000_000);
    expect(result.ms).toBe(650);
  });

  it('propagates a chat error rather than retrying it', async () => {
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    await expect(chatJson(messages, 'smart_pick', schema, isOk)).rejects.toThrow(
      'llama-server 503',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Vertex endpoint auth', () => {
  beforeEach(() => {
    vi.stubEnv('MODEL_URL', ENDPOINT);
    auth.getAccessToken.mockReset().mockResolvedValue('token-1');
  });

  const authorization = (call: number) =>
    (fetchMock.mock.calls[call]![1] as RequestInit).headers as Record<string, string>;

  it('sends the runtime token on /health and /slots under the invoke URL', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, [{ is_processing: false }]));
    expect(await modelStatus()).toBe('ready');
    expect(fetchMock.mock.calls[0]![0]).toBe(`${ENDPOINT}/health`);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${ENDPOINT}/slots`);
    expect(authorization(0)).toEqual({ authorization: 'Bearer token-1' });
    expect(authorization(1)).toEqual({ authorization: 'Bearer token-1' });
    expect(auth.scopes).toContain('https://www.googleapis.com/auth/cloud-platform');
  });

  it('sends the runtime token on chat completions', async () => {
    fetchMock.mockResolvedValueOnce(completion(OK_JSON));
    await chat(messages, 'chunk_analysis', schema);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${ENDPOINT}/v1/chat/completions`);
    expect(authorization(0)).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer token-1',
    });
  });

  it('fails the status check instead of reporting a wait when no token is issued', async () => {
    auth.getAccessToken.mockResolvedValueOnce(null);
    await expect(modelStatus()).rejects.toThrow('No access token for the model endpoint.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a credential error', async () => {
    auth.getAccessToken.mockRejectedValueOnce(new Error('Could not load the default credentials'));
    await expect(modelStatus()).rejects.toThrow('Could not load the default credentials');
  });

  it('sends no token to a local llama-server', async () => {
    vi.stubEnv('MODEL_URL', 'http://127.0.0.1:8081');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await modelStatus();
    expect(authorization(0)).toEqual({});
    expect(auth.getAccessToken).not.toHaveBeenCalled();
  });
});
