import { getTraceData, startNewTrace, startSpan, type Span } from '@sentry/sveltekit';

/** OTel's well-known provider name for the Gemini Developer API. */
export const PROVIDER = 'gcp.gemini';
/** Groups every agent, model, and tool span under one pipeline in Sentry's AI views. */
export const PIPELINE = 'soundboard';

export type AgentName = 'chunk-analyst' | 'smart-pick' | 'brand-guide' | 'hook-pick';
export type AgentSpan = Span;

export type Part =
  | { type: 'text'; text: string }
  /** Base64 image, such as a thumbnail. */
  | { type: 'image'; data: string; mime_type: string }
  /** One window's inline clip; `start` and `end` are source seconds. */
  | { type: 'video'; data: Uint8Array; mime_type: string; start: number; end: number };

/** `assistant` turns carry an earlier answer for a re-ask; nothing is stored provider-side. */
export type Turn = { role: 'user' | 'assistant'; parts: Part[] };

export type ModelRequest = { system: string; turns: Turn[] };

/** A turn of plain text, such as a re-ask or the earlier answer it resends. */
export const textTurn = (role: Turn['role'], text: string): Turn => ({
  role,
  parts: [{ type: 'text', text }],
});

/** A caption followed by each image, or nothing when there are no images. */
export function imageParts(
  caption: string,
  images: ({ data: string; mime_type: string } | null)[],
): Part[] {
  const parts = images.flatMap((image): Part[] => (image ? [{ type: 'image', ...image }] : []));
  return parts.length > 0 ? [{ type: 'text', text: caption }, ...parts] : [];
}

const base64Bytes = (b64: string) => {
  const padding = b64.endsWith('==') ? 2 : Number(b64.endsWith('='));
  return Math.floor((b64.length * 3) / 4) - padding;
};

function redactPart(part: Part) {
  if (part.type === 'text') return { type: 'text', content: part.text };
  if (part.type === 'image') {
    return { type: 'image', mime: part.mime_type, bytes: base64Bytes(part.data) };
  }
  return {
    type: 'video',
    mime: part.mime_type,
    bytes: part.data.byteLength,
    clip: `${part.start}s–${part.end}s`,
  };
}

/**
 * Replaces image and video payloads with placeholders, so media never reaches Sentry while the
 * shape of the request and all of its text stay visible.
 */
export function redactTurns(turns: Turn[]): unknown[] {
  return turns.map((turn) => ({ role: turn.role, parts: turn.parts.map(redactPart) }));
}

/** `invoke_agent` span; model and tool spans started inside become its children. */
export function invokeAgent<T>(
  agent: AgentName,
  model: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return startSpan(
    {
      op: 'gen_ai.invoke_agent',
      name: `invoke_agent ${agent}`,
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': agent,
        'gen_ai.pipeline.name': PIPELINE,
        'gen_ai.request.model': model,
        'gen_ai.provider.name': PROVIDER,
      },
    },
    fn,
  );
}

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};

export type ChatReply = {
  content: string;
  reasoning: string;
  usage: Usage;
  finishReason: string | null;
  responseId: string | null;
};

/** System prompt as `gen_ai.system_instructions`, the redacted turns as input. */
function requestAttributes(request: ModelRequest): Record<string, string> {
  return {
    ...(request.system
      ? {
          'gen_ai.system_instructions': JSON.stringify([{ type: 'text', content: request.system }]),
        }
      : {}),
    'gen_ai.input.messages': JSON.stringify(redactTurns(request.turns)),
  };
}

/** The agent's task on its `invoke_agent` span; Sentry shows an agent's input only from here. */
export function agentInput(span: AgentSpan, request: ModelRequest): void {
  span.setAttributes(requestAttributes(request));
}

/** The agent's final answer on its `invoke_agent` span. */
export function agentOutput(span: AgentSpan, content: string): void {
  span.setAttribute(
    'gen_ai.output.messages',
    JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content }] }]),
  );
}

const optionalCount = (key: string, value: number | undefined) =>
  value === undefined ? {} : { [key]: value };

/**
 * `chat` span: system prompt, redacted turns, the reply and its reasoning, finish reason, and token
 * counts. A reply that later fails to parse is still recorded here; a thrown error passes through
 * untouched.
 */
export function chatSpan<T extends ChatReply>(
  request: ModelRequest,
  params: { agent: AgentName; model: string; maxTokens: number },
  fn: () => Promise<T>,
): Promise<T> {
  return startSpan(
    {
      op: 'gen_ai.chat',
      name: `chat ${params.model}`,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': PROVIDER,
        'gen_ai.request.model': params.model,
        'gen_ai.agent.name': params.agent,
        'gen_ai.pipeline.name': PIPELINE,
        'gen_ai.request.max_tokens': params.maxTokens,
        ...requestAttributes(request),
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
        'gen_ai.response.model': params.model,
        'gen_ai.output.messages': JSON.stringify([
          {
            role: 'assistant',
            parts,
            ...(result.finishReason ? { finish_reason: result.finishReason } : {}),
          },
        ]),
        ...(result.finishReason ? { 'gen_ai.response.finish_reasons': [result.finishReason] } : {}),
        ...(result.responseId ? { 'gen_ai.response.id': result.responseId } : {}),
        'gen_ai.usage.input_tokens': usage.inputTokens ?? 0,
        'gen_ai.usage.output_tokens': usage.outputTokens ?? 0,
        'gen_ai.usage.total_tokens': usage.totalTokens ?? 0,
        ...optionalCount('gen_ai.usage.cache_read.input_tokens', usage.cachedInputTokens),
        ...optionalCount('gen_ai.usage.reasoning.output_tokens', usage.reasoningTokens),
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
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return startSpan(
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
  return startNewTrace(() =>
    startSpan(
      { op: 'job.create', name: 'job', forceTransaction: true, attributes: { 'job.id': jobId } },
      () => {
        const data = getTraceData();
        const sentryTrace = data['sentry-trace'];
        return sentryTrace ? { sentryTrace, baggage: data.baggage ?? '' } : null;
      },
    ),
  );
}
