import * as Sentry from '@sentry/sveltekit';

export const MODEL_NAME = 'gemma-4-12b-it';
export const PROVIDER = 'llama.cpp';

type Part =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | Part[] };

const dataUrlMime = (url: string) => url.match(/^data:([^;,]+)/)?.[1] ?? 'unknown';
const base64Bytes = (b64: string) =>
  Math.floor((b64.length * 3) / 4) - (b64.match(/=+$/)?.[0].length ?? 0);

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
  agent: 'chunk-analyst' | 'smart-pick',
  fn: (span: Sentry.Span) => Promise<T>,
): Promise<T> {
  return Sentry.startSpan(
    {
      op: 'gen_ai.invoke_agent',
      name: `invoke_agent ${agent}`,
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': agent,
        'gen_ai.request.model': MODEL_NAME,
        'gen_ai.provider.name': PROVIDER,
      },
    },
    fn,
  );
}

export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

/** `chat` span carrying the redacted request, the reply text, and token counts. */
export function chatSpan<T extends { content: string; usage: Usage }>(
  messages: ChatMessage[],
  params: { temperature: number; maxTokens: number },
  fn: () => Promise<T>,
): Promise<T> {
  return Sentry.startSpan(
    {
      op: 'gen_ai.chat',
      name: `chat ${MODEL_NAME}`,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': PROVIDER,
        'gen_ai.system': PROVIDER,
        'gen_ai.request.model': MODEL_NAME,
        'gen_ai.request.temperature': params.temperature,
        'gen_ai.request.max_tokens': params.maxTokens,
        'gen_ai.input.messages': JSON.stringify(redactMessages(messages)),
      },
    },
    async (span) => {
      const result = await fn();
      span.setAttributes({
        'gen_ai.response.model': MODEL_NAME,
        'gen_ai.output.messages': JSON.stringify([
          { role: 'assistant', parts: [{ type: 'text', content: result.content }] },
        ]),
        'gen_ai.usage.input_tokens': result.usage.prompt_tokens ?? 0,
        'gen_ai.usage.output_tokens': result.usage.completion_tokens ?? 0,
        'gen_ai.usage.total_tokens': result.usage.total_tokens ?? 0,
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
