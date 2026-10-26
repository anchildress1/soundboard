import { getTraceData, startNewTrace, startSpan, type Span } from '@sentry/sveltekit';

/** OTel's well-known provider name for the Gemini Developer API. */
export const PROVIDER = 'gcp.gemini';
/** Groups every agent, model, and tool span under one pipeline in Sentry's AI views. */
export const PIPELINE = 'soundboard';

export type AgentName =
  'chunk-analyst' | 'smart-pick' | 'brand-guide' | 'voice-guide' | 'hook-pick' | 'peer-match';

/** Guide proposals restate their YouTube sources, so spans keep no reply or reasoning text. */
export const GUIDE_AGENTS: ReadonlySet<AgentName> = new Set(['voice-guide', 'brand-guide']);

/** What spans record in place of a guide agent's reply or reasoning. */
export const guidePlaceholder = (text: string) => `[guide proposal: ${text.length} chars]`;
export type AgentSpan = Span;

/**
 * Agents whose replies can restate their prompt's YouTube data. Spans keep their reply and
 * reasoning text with each YouTube-sourced value replaced by `YOUTUBE_VALUE`.
 */
export const VALUE_AGENTS: ReadonlySet<AgentName> = new Set(['peer-match', 'smart-pick']);
export const YOUTUBE_VALUE = '[YouTube data]';

export type Part =
  /**
   * `source: 'youtube'` marks text drawn from YouTube data; spans record only `[<label>: <count>]`
   * in its place, while the model still gets the text. `source: 'guide'` marks a guide agent's
   * earlier reply resent for a re-ask, recorded as its placeholder; `source: 'reply'` a
   * `VALUE_AGENTS` reply, recorded with its YouTube values replaced.
   */
  | {
      type: 'text';
      text: string;
      source?: 'youtube' | 'guide' | 'reply';
      count?: number;
      label?: string;
    }
  /** A peer's public YouTube upload, heard from `start` to `end` seconds; spans keep no URL. */
  | { type: 'youtube'; url: string; start: number; end: number }
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

/**
 * A text part of YouTube data, `count` naming how many items it describes and `label` what they are
 * (`YouTube uploads` unless given).
 */
export const youtubePart = (value: unknown, count: number, label?: string): Part => ({
  type: 'text',
  text: JSON.stringify(value),
  source: 'youtube',
  count,
  ...(label ? { label } : {}),
});

type Redact = (text: string) => string;
const keep: Redact = (text) => text;

/** String leaves of at least 3 characters with their sentences, and numbers of 2+ digits. */
function leaves(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const piece of [value, ...value.split(/[.!?\n]+/)]) {
      const trimmed = piece.trim();
      if (trimmed.length >= 3) into.add(trimmed.toLowerCase());
    }
  } else if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) >= 10) {
    into.add(String(value));
    into.add(value.toLocaleString('en-US'));
  } else if (Array.isArray(value)) {
    for (const item of value) leaves(item, into);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) leaves(item, into);
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Replaces every value from `turns`' YouTube parts, longest first and case-insensitively, with
 * `YOUTUBE_VALUE` wherever it stands as a whole word or number.
 */
export function youtubeRedactor(turns: Turn[]): Redact {
  const values = new Set<string>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.type !== 'text' || part.source !== 'youtube') continue;
      try {
        leaves(JSON.parse(part.text), values);
      } catch {
        leaves(part.text, values);
      }
    }
  }
  if (values.size === 0) return keep;
  const alternatives = [...values].sort((a, b) => b.length - a.length).map(escape);
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:${alternatives.join('|')})(?![\p{L}\p{N}])`,
    'giu',
  );
  return (text) => text.replace(pattern, YOUTUBE_VALUE);
}

/** How a span records `agent`'s reply and reasoning, given the request it answered. */
function replyRedactor(agent: AgentName | undefined, turns: Turn[]): Redact {
  if (agent && GUIDE_AGENTS.has(agent)) return guidePlaceholder;
  if (agent && VALUE_AGENTS.has(agent)) return youtubeRedactor(turns);
  return keep;
}

function redactText(part: Extract<Part, { type: 'text' }>, values: () => Redact): string {
  if (part.source === 'youtube') return `[${part.label ?? 'YouTube uploads'}: ${part.count ?? 0}]`;
  if (part.source === 'guide') return guidePlaceholder(part.text);
  if (part.source === 'reply') return values()(part.text);
  return part.text;
}

function redactPart(part: Part, values: () => Redact) {
  if (part.type === 'text') return { type: 'text', content: redactText(part, values) };
  if (part.type === 'youtube') return { type: 'video', source: 'youtube' };
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
 * Replaces image and video payloads and YouTube-sourced text with placeholders, so neither reaches
 * Sentry while the shape of the request and the rest of its text stay visible.
 */
export function redactTurns(turns: Turn[]): unknown[] {
  let redactor: Redact | undefined;
  const values = () => (redactor ??= youtubeRedactor(turns));
  return turns.map((turn) => ({
    role: turn.role,
    parts: turn.parts.map((part) => redactPart(part, values)),
  }));
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

const spanTurns = new WeakMap<AgentSpan, Turn[]>();

/** The agent's task on its `invoke_agent` span; Sentry shows an agent's input only from here. */
export function agentInput(span: AgentSpan, request: ModelRequest): void {
  spanTurns.set(span, request.turns);
  span.setAttributes(requestAttributes(request));
}

/**
 * The agent's final answer on its `invoke_agent` span: a guide agent's as its placeholder, a
 * `VALUE_AGENTS` answer with the YouTube values of the input `agentInput` recorded replaced.
 */
export function agentOutput(span: AgentSpan, content: string, agent?: AgentName): void {
  const recorded = replyRedactor(agent, spanTurns.get(span) ?? [])(content);
  span.setAttribute(
    'gen_ai.output.messages',
    JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: recorded }] }]),
  );
}

const optionalCount = (key: string, value: number | undefined) =>
  value === undefined ? {} : { [key]: value };

/**
 * `chat` span: system prompt, redacted turns, the reply and its reasoning (placeholders for guide
 * agents, YouTube values replaced for `VALUE_AGENTS`), finish reason, and token counts. A reply that later fails to parse is still recorded here; a thrown error passes through
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
      const record = replyRedactor(params.agent, request.turns);
      const parts = [
        ...(result.reasoning ? [{ type: 'reasoning', content: record(result.reasoning) }] : []),
        { type: 'text', content: record(result.content) },
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
