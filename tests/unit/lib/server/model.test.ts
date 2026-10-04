// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_TIMEOUT_MS,
  chat,
  chatJson,
  MAX_TOKENS,
  modelStatus,
  STEP_BUDGET_MS,
  stepDeadline,
  TEMPERATURE,
} from '$lib/server/model';
import { MODEL_NAME, type ChatMessage } from '$lib/server/tracing';

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

  it('is loading while the sidecar refuses connections', async () => {
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

  it('defaults to the loopback sidecar', async () => {
    vi.stubEnv('MODEL_URL', undefined);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await modelStatus();
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:8081/health');
  });
});

describe('chat', () => {
  it('sends a schema-constrained request at temperature 0.2 and returns content', async () => {
    fetchMock.mockResolvedValueOnce(completion('{"ok":true}'));
    const result = await chat(messages, 'chunk_analysis', schema);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://model.test/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: MODEL_NAME,
      messages,
      temperature: 0.2,
      max_tokens: 2048,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'chunk_analysis', strict: true, schema },
      },
    });
    expect(TEMPERATURE).toBeCloseTo(0.2);
    expect(MAX_TOKENS).toBeGreaterThanOrEqual(2048);
    expect(CALL_TIMEOUT_MS).toBeLessThan(120_000);

    expect(result.content).toBe('{"ok":true}');
    expect(result.reasoning).toBe('thinking...');
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('never treats reasoning_content as the answer', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { choices: [{ message: { content: null, reasoning_content: '{"a":1}' } }] }),
    );
    const result = await chat(messages, 's', schema);
    expect(result.content).toBe('');
    expect(result.reasoning).toBe('{"a":1}');
    expect(result.usage).toEqual({});
  });

  it('tolerates a response without choices', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    expect(await chat(messages, 's', schema)).toMatchObject({ content: '', reasoning: '' });
  });

  it('throws with the status and a truncated body on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(500), { status: 500 }));
    const err = (await chat(messages, 's', schema).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(`llama-server 500: ${'x'.repeat(200)}`);
  });

  it('propagates transport errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    await expect(chat(messages, 's', schema)).rejects.toThrow('timeout');
  });
});

describe('step budget', () => {
  it('sets the deadline one budget ahead and keeps it inside the 3-minute claim', () => {
    expect(stepDeadline(1000)).toBe(1000 + STEP_BUDGET_MS);
    expect(STEP_BUDGET_MS).toBeLessThan(3 * 60 * 1000);
  });

  it('refuses a call once the deadline has passed', async () => {
    await expect(chat(messages, 's', schema, Date.now() - 1)).rejects.toThrow('ran out of time');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the parse retry when too little budget is left', async () => {
    fetchMock.mockResolvedValueOnce(completion('bad'));
    const isObject = (v: unknown): v is object => typeof v === 'object';
    const result = await chatJson(messages, 's', schema, isObject, Date.now() + 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ value: null, raw: 'bad' });
  });
});

describe('chatJson', () => {
  const isOk = (v: unknown): v is { ok: boolean } =>
    typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';

  it('returns the parsed value on the first valid reply', async () => {
    fetchMock.mockResolvedValueOnce(completion('{"ok":true}'));
    const result = await chatJson(messages, 's', schema, isOk);
    expect(result.value).toEqual({ ok: true });
    expect(result.raw).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once after a parse failure', async () => {
    fetchMock
      .mockResolvedValueOnce(completion('{"ok":tr'))
      .mockResolvedValueOnce(completion('{"ok":false}'));
    const result = await chatJson(messages, 's', schema, isOk);
    expect(result.value).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once when the JSON fails validation', async () => {
    fetchMock
      .mockResolvedValueOnce(completion('{"ok":"yes"}'))
      .mockResolvedValueOnce(completion('{"ok":true}'));
    expect((await chatJson(messages, 's', schema, isOk)).value).toEqual({ ok: true });
  });

  it('keeps the last raw text after two failures instead of throwing', async () => {
    fetchMock
      .mockResolvedValueOnce(completion('first bad'))
      .mockResolvedValueOnce(completion('second bad'));
    const result = await chatJson(messages, 's', schema, isOk);
    expect(result).toMatchObject({ value: null, raw: 'second bad' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('adds up model time across attempts', async () => {
    const now = vi.spyOn(Date, 'now');
    // start, end; budget check, start, end
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1400);
    now.mockReturnValueOnce(1500).mockReturnValueOnce(2000).mockReturnValueOnce(2250);
    fetchMock.mockResolvedValueOnce(completion('bad')).mockResolvedValueOnce(completion('bad'));
    const result = await chatJson(messages, 's', schema, isOk, 1_000_000);
    now.mockRestore();
    expect(result.ms).toBe(650);
  });

  it('propagates a chat error rather than retrying it', async () => {
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    await expect(chatJson(messages, 's', schema, isOk)).rejects.toThrow('llama-server 503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
