import { createGoogle } from '@ai-sdk/google';
import {
  AISDKError,
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';
import { analystModel, geminiApiKey, pickModel } from '#lib/server/core/env.js';
import {
  chatSpan,
  GUIDE_AGENTS,
  textTurn,
  VALUE_AGENTS,
  type AgentName,
  type ChatReply,
  type ModelRequest,
  type Part,
  type Turn,
} from '#lib/server/core/tracing.js';
import { quotaResetAt } from '#lib/server/core/quota.js';

export type Agent = AgentName;

/** Per-call cap; the shared step deadline usually binds first. */
export const CALL_TIMEOUT_MS = 90_000;
/** Whole-step budget, started when the step begins: under the ~2-minute step target and well inside the 3-minute claim. */
export const STEP_BUDGET_MS = 110_000;

export const stepDeadline = (now = Date.now()) => now + STEP_BUDGET_MS;

/**
 * Thinking tokens count against `maxOutputTokens` and the cap cuts the reply off, so Argon agents get
 * a wide cap and cost is steered by thinking level. `minCallMs` is G1's p95: no call or re-ask starts
 * with less time left.
 */
const AGENTS = {
  'chunk-analyst': { model: analystModel, thinkingLevel: 'low', maxTokens: 2048, minCallMs: 8_000 },
  // Gate G1 measured 4.1 s for a 60 s YouTube clip.
  'peer-match': { model: analystModel, thinkingLevel: 'low', maxTokens: 2048, minCallMs: 5_000 },
  'smart-pick': { model: pickModel, thinkingLevel: 'medium', maxTokens: 8192, minCallMs: 33_000 },
  'hook-pick': { model: pickModel, thinkingLevel: 'low', maxTokens: 8192, minCallMs: 35_000 },
  'brand-guide': { model: pickModel, thinkingLevel: 'medium', maxTokens: 8192, minCallMs: 33_000 },
  // T004 measured 7.6 s at the voice caps, under the brand guide's p95.
  'voice-guide': { model: pickModel, thinkingLevel: 'medium', maxTokens: 8192, minCallMs: 33_000 },
} as const satisfies Record<
  Agent,
  { model: () => string; thinkingLevel: 'low' | 'medium'; maxTokens: number; minCallMs: number }
>;

/** Whether `deadline` still leaves the agent its minimum call time. */
export const hasModelTime = (agent: Agent, deadline: number, now = Date.now()) =>
  deadline - now >= AGENTS[agent].minCallMs;

/** The configured model id for an agent. */
export const modelFor = (agent: Agent) => AGENTS[agent].model();

/** Provider answered 429 or 503; the step returns the `model busy` wait. */
export class ModelBusy extends Error {}

/** A per-day quota is spent; `until` is the next reset (midnight Pacific). */
export class ModelQuotaSpent extends Error {
  constructor(
    message: string,
    readonly until: number,
  ) {
    super(message);
  }
}

type QuotaDetail = { '@type'?: unknown; violations?: { quotaId?: unknown }[] };

function errorDetails(error: APICallError): unknown[] {
  const parsed = (error.data as { error?: { details?: unknown[] } } | undefined)?.error?.details;
  if (parsed) return parsed;
  try {
    const body = JSON.parse(error.responseBody ?? '') as { error?: { details?: unknown[] } };
    return body.error?.details ?? [];
  } catch {
    return [];
  }
}

const spentPerDay = (details: unknown[]) =>
  details.some((detail) => {
    const { '@type': type, violations = [] } = (detail ?? {}) as QuotaDetail;
    return (
      String(type).endsWith('QuotaFailure') &&
      violations.some((v) => String(v.quotaId).includes('PerDay'))
    );
  });

/**
 * Typed waits for 429/503; any other SDK error becomes a plain error carrying only its message, so a
 * captured exception never holds the request body (inline media), headers, or a media-bearing cause.
 */
function classify(error: unknown): unknown {
  if (APICallError.isInstance(error)) {
    const message = `Gemini ${error.statusCode ?? 'unreachable'}: ${error.message}`;
    if (error.statusCode === 429 && spentPerDay(errorDetails(error))) {
      return new ModelQuotaSpent(message, quotaResetAt(Date.now()));
    }
    if (error.statusCode === 429 || error.statusCode === 503) return new ModelBusy(message);
    return new Error(message);
  }
  if (AISDKError.isInstance(error)) return new Error(`Gemini: ${error.message}`);
  return error;
}

const usageOf = (usage: LanguageModelUsage | undefined): ChatReply['usage'] => ({
  inputTokens: usage?.inputTokens,
  outputTokens: usage?.outputTokens,
  totalTokens: usage?.totalTokens,
  cachedInputTokens: usage?.inputTokenDetails.cacheReadTokens,
  reasoningTokens: usage?.outputTokenDetails.reasoningTokens,
});

const WATCH_URL = /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/;

function sdkPart(part: Part) {
  if (part.type === 'text') return { type: 'text' as const, text: part.text };
  if (part.type === 'youtube') {
    // The Interactions model passes a YouTube watch URL to Gemini instead of downloading it (G1);
    // any other URL would be fetched by the SDK, so it never gets this far.
    if (!WATCH_URL.test(part.url)) throw new Error('Only a YouTube watch URL can be heard.');
    return {
      type: 'file' as const,
      mediaType: 'video/mp4',
      data: new URL(part.url),
      providerOptions: {
        google: { processing: { type: 'static', startOffset: part.start, endOffset: part.end } },
      },
    };
  }
  // Inline bytes only: given a URL, the SDK would download it.
  return { type: 'file' as const, mediaType: part.mime_type, data: part.data };
}

/**
 * Assistant turns are earlier text answers resent for a re-ask; nothing is stored provider-side. A
 * part's `source` only steers span redaction, so it never reaches the SDK.
 */
const sdkMessage = (turn: Turn) =>
  ({ role: turn.role, content: turn.parts.map(sdkPart) }) as ModelMessage;

let gemini: ReturnType<typeof createGoogle> | undefined;
let geminiKey: string | undefined;

/** Built lazily and rebuilt when the key changes, so tests and new revisions read the current key. */
function provider() {
  const key = geminiApiKey();
  if (!gemini || key !== geminiKey) {
    gemini = createGoogle({ apiKey: key });
    geminiKey = key;
  }
  return gemini;
}

const LOW_RESOLUTION: ReadonlySet<Agent> = new Set(['chunk-analyst', 'peer-match']);

export type ChatResult = ChatReply & { ms: number };

/** Re-asks left for one pick: its parse, repeat and check failures all spend this one allowance. */
export type Asks = { left: number };

/**
 * One schema-constrained call. A reply that can't be parsed comes back with its raw text and finish
 * reason rather than throwing; busy and quota answers throw typed errors.
 */
export function chat(
  request: ModelRequest,
  agent: Agent,
  schema: Record<string, unknown>,
  deadline = Date.now() + CALL_TIMEOUT_MS,
): Promise<ChatResult> {
  const settings = AGENTS[agent];
  const model = settings.model();
  return chatSpan(request, { agent, model, maxTokens: settings.maxTokens }, async () => {
    const started = Date.now();
    if (deadline - started < settings.minCallMs) {
      throw new Error('The step ran out of time for the model.');
    }
    try {
      const result = await generateText({
        model: provider().interactions(model),
        instructions: request.system,
        messages: request.turns.map(sdkMessage),
        output: Output.object({ schema: jsonSchema(schema) }),
        maxOutputTokens: settings.maxTokens,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, deadline - started)),
        // Sentry's default AI integration would otherwise add a second, unredacted span.
        telemetry: { isEnabled: false },
        providerOptions: {
          google: {
            store: false,
            thinkingLevel: settings.thinkingLevel,
            // Applies to image parts too; pick and brand need full-resolution thumbnails.
            ...(LOW_RESOLUTION.has(agent) ? { mediaResolution: 'low' } : {}),
          },
        },
      });
      return {
        content: result.text,
        reasoning: result.finalStep.reasoningText ?? '',
        usage: usageOf(result.usage),
        finishReason: result.finishReason,
        responseId: result.finalStep.response.id,
        ms: Date.now() - started,
      };
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw classify(error);
      return {
        content: error.text ?? '',
        reasoning: '',
        usage: usageOf(error.usage),
        finishReason: error.finishReason ?? null,
        responseId: error.response?.id ?? null,
        ms: Date.now() - started,
      };
    }
  });
}

const REASK =
  'That reply was not complete JSON matching the schema. Answer again with only the JSON.';

/**
 * An earlier reply resent for a re-ask. A guide's restates its sources and a `VALUE_AGENTS` reply
 * can restate YouTube data, so span inputs record them redacted like the reply itself.
 */
export function resentReply(agent: Agent, content: string): Turn {
  if (GUIDE_AGENTS.has(agent)) {
    return { role: 'assistant', parts: [{ type: 'text', text: content, source: 'guide' }] };
  }
  if (VALUE_AGENTS.has(agent)) {
    return { role: 'assistant', parts: [{ type: 'text', text: content, source: 'reply' }] };
  }
  return textTurn('assistant', content);
}

/**
 * `chat`, parsed and validated. A reply that doesn't parse, is empty, or was cut off gets a re-ask
 * (the earlier answer resent as an assistant turn) while `asks` has one left and the agent's
 * minimum budget remains; after that the raw text comes back with a null value.
 */
export async function chatJson<T>(
  request: ModelRequest,
  agent: Agent,
  schema: Record<string, unknown>,
  validate: (value: unknown) => value is T,
  deadline = stepDeadline(),
  asks: Asks = { left: 1 },
): Promise<{ value: T | null; raw: string; ms: number; turns: Turn[] }> {
  let ms = 0;
  let turns = request.turns;
  for (;;) {
    const reply = await chat({ system: request.system, turns }, agent, schema, deadline);
    ms += reply.ms;
    const value = reply.finishReason === 'stop' ? parse(reply.content) : undefined;
    const answered = [...turns, ...(reply.content ? [resentReply(agent, reply.content)] : [])];
    if (value !== undefined && validate(value)) {
      return { value, raw: reply.content, ms, turns: answered };
    }
    if (asks.left < 1 || !hasModelTime(agent, deadline)) {
      return { value: null, raw: reply.content, ms, turns: answered };
    }
    asks.left -= 1;
    turns = [...answered, textTurn('user', REASK)];
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
