import * as Sentry from '@sentry/sveltekit';

export const MODEL_NAME = 'gemma-4-12b-it';
export const PROVIDER = 'llama.cpp';
/** Groups every agent, model, and tool span under one pipeline in Sentry's AI views. */
export const PIPELINE = 'soundboard';

export type AgentName = 'chunk-analyst' | 'smart-pick' | 'brand-guide' | 'hook-pick';

type Part =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | Part[] };

const dataUrlMime = (url: string) => url.match(/^data:([^;,]+)/)?.[1] ?? 'unknown';
const base64Bytes = (b64: string) => {
  const padding = b64.endsWith('==') ? 2 : Number(b64.endsWith('='));
  return Math.floor((b64.length * 3) / 4) - padding;
};

/**
 * Replaces audio and image payloads with `{type, mime, bytes}` placeholders, so media never reaches
 * Sentry while the shape of the request stays visible.
 */
export function redactMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    parts:
      typeof message.content === 'string'
        ? [{ type: 'text', content: message.content }]
        : message.content.map((part) => {
            if (part.type === 'text') return { type: 'text', content: part.text };
            if (part.type === 'image_url') {
              const url = part.image_url.url;
              const b64 = url.slice(url.indexOf(',') + 1);
              return { type: 'image', mime: dataUrlMime(url), bytes: base64Bytes(b64) };
            }
            return {
              type: 'audio',
              mime: `audio/${part.input_audio.format}`,
              bytes: base64Bytes(part.input_audio.data),
            };
          }),
  }));
}

/** `invoke_agent` span; model and tool spans started inside become its children. */
export function invokeAgent<T>(
  agent: AgentName,
  fn: (span: Sentry.Span) => Promise<T>,
): Promise<T> {
  return Sentry.startSpan(
    {
      op: 'gen_ai.invoke_agent',
      name: `invoke_agent ${agent}`,
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': agent,
        'gen_ai.pipeline.name': PIPELINE,
        'gen_ai.request.model': MODEL_NAME,
        'gen_ai.provider.name': PROVIDER,
      },
    },
    fn,
  );
}

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

export type ChatReply = {
  content: string;
  reasoning: string;
  usage: Usage;
  finishReason: string | null;
  responseId: string | null;
};

const textParts = (messages: ChatMessage[]) =>
  (redactMessages(messages) as { parts: unknown[] }[]).flatMap((m) => m.parts);

/**
 * `chat` span: system prompt as `gen_ai.system_instructions`, the rest of the redacted request as
 * input, the reply and its think block as output, plus finish reason and token counts.
 */
export function chatSpan<T extends ChatReply>(
  messages: ChatMessage[],
  params: { agent: AgentName; temperature: number; maxTokens: number },
  fn: () => Promise<T>,
): Promise<T> {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  return Sentry.startSpan(
    {
      op: 'gen_ai.chat',
      name: `chat ${MODEL_NAME}`,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': PROVIDER,
        'gen_ai.request.model': MODEL_NAME,
        'gen_ai.agent.name': params.agent,
        'gen_ai.pipeline.name': PIPELINE,
        'gen_ai.request.temperature': params.temperature,
        'gen_ai.request.max_tokens': params.maxTokens,
        ...(system.length > 0
          ? { 'gen_ai.system_instructions': JSON.stringify(textParts(system)) }
          : {}),
        'gen_ai.input.messages': JSON.stringify(redactMessages(rest)),
      },
    },
    async (span) => {
      const result = await fn();
      const { usage } = result;
      const parts = [
        ...(result.reasoning ? [{ type: 'reasoning', content: result.reasoning }] : []),
        { type: 'text', content: result.content },
      ];
      span.setAttributes({
        'gen_ai.response.model': MODEL_NAME,
        'gen_ai.output.messages': JSON.stringify([
          {
            role: 'assistant',
            parts,
            ...(result.finishReason ? { finish_reason: result.finishReason } : {}),
          },
        ]),
        ...(result.finishReason ? { 'gen_ai.response.finish_reasons': [result.finishReason] } : {}),
        ...(result.responseId ? { 'gen_ai.response.id': result.responseId } : {}),
        'gen_ai.usage.input_tokens': usage.prompt_tokens ?? 0,
        'gen_ai.usage.output_tokens': usage.completion_tokens ?? 0,
        'gen_ai.usage.total_tokens': usage.total_tokens ?? 0,
        ...(usage.prompt_tokens_details?.cached_tokens !== undefined
          ? { 'gen_ai.usage.cache_read.input_tokens': usage.prompt_tokens_details.cached_tokens }
          : {}),
        ...(usage.completion_tokens_details?.reasoning_tokens !== undefined
          ? {
              'gen_ai.usage.reasoning.output_tokens':
                usage.completion_tokens_details.reasoning_tokens,
            }
          : {}),
      });
      return result;
    },
  );
}

/** `execute_tool` span for deterministic tools the agent relies on, like the hashtag search. */
export function toolSpan<T>(
  agent: string,
  tool: string,
  args: Record<string, unknown>,
  fn: (span: Sentry.Span) => Promise<T>,
): Promise<T> {
  return Sentry.startSpan(
    {
      op: 'gen_ai.execute_tool',
      name: `execute_tool ${tool}`,
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.agent.name': agent,
        'gen_ai.pipeline.name': PIPELINE,
        'gen_ai.tool.name': tool,
        'gen_ai.tool.call.arguments': JSON.stringify(args),
      },
    },
    fn,
  );
}

/** Starts a fresh trace for a new job and returns the headers every later step continues from. */
export function startJobTrace(jobId: string): { sentryTrace: string; baggage: string } | null {
  return Sentry.startNewTrace(() =>
    Sentry.startSpan(
      { op: 'job.create', name: 'job', forceTransaction: true, attributes: { 'job.id': jobId } },
      () => {
        const data = Sentry.getTraceData();
        const sentryTrace = data['sentry-trace'];
        return sentryTrace ? { sentryTrace, baggage: data.baggage ?? '' } : null;
      },
    ),
  );
}
