import { GoogleAuth } from 'google-auth-library';
import { modelUrl } from './env';
import { chatSpan, MODEL_NAME, type AgentName, type ChatMessage, type ChatReply } from './tracing';

export const TEMPERATURE = 0.2;
/** Thinking tokens count against this budget, so it stays well above the reply size. */
export const MAX_TOKENS = 2048;
/** Per-call timeout, counted only once the model reports ready. */
export const CALL_TIMEOUT_MS = 90_000;
/** Whole-step budget, started when the step begins: under the ~2-minute step target and well inside the 3-minute claim. */
export const STEP_BUDGET_MS = 110_000;
/** A retry is only worth starting with at least this much budget left. */
const MIN_CALL_MS = 15_000;

export const stepDeadline = (now = Date.now()) => now + STEP_BUDGET_MS;

export type ModelStatus = 'ready' | 'loading' | 'busy';

type Slot = { is_processing?: boolean };

let auth: GoogleAuth | undefined;

/** The Vertex endpoint (https) takes the runtime identity's token; a local `llama-server` takes none. */
async function authHeaders(): Promise<Record<string, string>> {
  if (!modelUrl().startsWith('https://')) return {};
  auth ??= new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('No access token for the model endpoint.');
  return { authorization: `Bearer ${token}` };
}

/**
 * The endpoint answers 429 while scaled to zero (the request starts a replica), and `/health`
 * answers 503 while weights load; either reads as loading. `/slots` shows whether the single slot
 * is taken by another run.
 */
export async function modelStatus(): Promise<ModelStatus> {
  // Outside the try: a missing credential is a deploy fault, not a model still waking.
  const headers = await authHeaders();
  try {
    const health = await fetch(`${modelUrl()}/health`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok) return 'loading';
  } catch {
    return 'loading';
  }
  try {
    const slots = await fetch(`${modelUrl()}/slots`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!slots.ok) return 'ready';
    const list = (await slots.json()) as Slot[];
    return list.length > 0 && list.every((slot) => slot.is_processing) ? 'busy' : 'ready';
  } catch {
    return 'ready';
  }
}

export type ChatResult = ChatReply & { ms: number };

/** Each JSON schema belongs to one agent, which names its model spans. */
const AGENT_FOR_SCHEMA = {
  chunk_analysis: 'chunk-analyst',
  smart_pick: 'smart-pick',
  brand_guide: 'brand-guide',
  hook_pick: 'hook-pick',
} as const satisfies Record<string, AgentName>;

export type SchemaName = keyof typeof AGENT_FOR_SCHEMA;

type CompletionResponse = {
  id?: string;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; reasoning_content?: string | null };
  }[];
  usage?: ChatReply['usage'];
};

/** One schema-constrained chat completion. The answer is `content`; `reasoning_content` is the think block. */
export async function chat(
  messages: ChatMessage[],
  schemaName: SchemaName,
  schema: Record<string, unknown>,
  deadline = Date.now() + CALL_TIMEOUT_MS,
): Promise<ChatResult> {
  const params = {
    agent: AGENT_FOR_SCHEMA[schemaName],
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
  };
  return chatSpan(messages, params, async () => {
    const started = Date.now();
    const timeout = Math.min(CALL_TIMEOUT_MS, deadline - started);
    if (timeout <= 0) throw new Error('The step ran out of time for the model.');
    const response = await fetch(`${modelUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        model: MODEL_NAME,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema },
        },
        messages,
      }),
    });
    if (!response.ok) {
      throw new Error(`llama-server ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as CompletionResponse;
    const choice = body.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      reasoning: choice?.message?.reasoning_content ?? '',
      usage: body.usage ?? {},
      finishReason: choice?.finish_reason ?? null,
      responseId: body.id ?? null,
      ms: Date.now() - started,
    };
  });
}

/**
 * Parses the model's JSON reply, retrying the call once on a parse failure while the step budget
 * allows. A failure that can't be retried keeps the raw text instead of throwing.
 */
export async function chatJson<T>(
  messages: ChatMessage[],
  schemaName: SchemaName,
  schema: Record<string, unknown>,
  validate: (value: unknown) => value is T,
  deadline = stepDeadline(),
): Promise<{ value: T | null; raw: string; ms: number }> {
  let ms = 0;
  let raw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && deadline - Date.now() < MIN_CALL_MS) break;
    const result = await chat(messages, schemaName, schema, deadline);
    ms += result.ms;
    raw = result.content;
    try {
      const value: unknown = JSON.parse(raw);
      if (validate(value)) return { value, raw, ms };
    } catch {
      // Falls through to the retry.
    }
  }
  return { value: null, raw, ms };
}
