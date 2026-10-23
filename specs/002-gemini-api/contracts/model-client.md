# Contract: model client (`src/lib/server/ai/model.ts`)

The only module that imports `ai` or `@ai-sdk/google`. Every agent calls through it. A provider swap changes this file and configuration, not the agents.

## Exports

```ts
export type Agent = 'chunk-analyst' | 'smart-pick' | 'hook-pick' | 'brand-guide';

/** Provider answered 429 or 503; the step returns the `model busy` wait. */
export class ModelBusy extends Error {}

/** A per-day quota is spent; `until` is the next reset. The step sets `limitUntil` and waits. */
export class ModelQuotaSpent extends Error {
  readonly until: number;
}

/** One schema-constrained call. Throws `ModelBusy` on 429/503, `Error` on any other failure. */
export function chat(
  request: ModelRequest,
  agent: Agent,
  schema: Record<string, unknown>,
  deadline?: number,
): Promise<{ content: string; ms: number }>;

/** `chat`, parsed and validated; one re-ask on a parse failure while budget allows, then raw. */
export function chatJson<T>(
  request: ModelRequest,
  agent: Agent,
  schema: Record<string, unknown>,
  validate: (value: unknown) => value is T,
  deadline?: number,
): Promise<{ value: T | null; raw: string; ms: number }>;

export const stepDeadline: (now?: number) => number; // unchanged
export function modelFor(agent: Agent): string; // configured model id
```

## Call invariants

- The client is `createGoogle({ apiKey: GEMINI_API_KEY })`, not the deprecated `createGoogleGenerativeAI` or the default `google` singleton. The key is the only credential; adding OAuth headers fails with 401 (research R8).
- `generateText({ model: gemini.interactions(modelFor(agent)), instructions, messages, output: Output.object({ schema: jsonSchema(schema) }), maxOutputTokens, maxRetries: 0, abortSignal, telemetry: { isEnabled: false }, providerOptions: { google: { store: false, thinkingLevel, ...(agent === 'chunk-analyst' ? { mediaResolution: 'low' } : {}) } } })`.
- `messages` come from `request.turns` in order. `assistant` turns carry a re-ask's earlier answer and are resent in full, because `store: false` keeps no history.
- Video parts are AI SDK inline `file` parts: `{ type: 'file', mediaType: 'video/mp4', data: bytes }`, the window clip from `cutWindowClip` (research R3). Never a URL: the SDK would download it.
- `thinkingLevel` and `maxOutputTokens` are per agent (research R5). No temperature.
- AI SDK telemetry is off on every call, because Sentry's default `vercelAIIntegration` would otherwise add an unredacted span. `chatSpan` owns the span.
- The per-call timeout is `min(CALL_TIMEOUT_MS, deadline - now)`. A timeout of 0 or less throws before the call.
- `NoObjectGeneratedError` (raw = `error.text`), `NoOutputGeneratedError` (raw = empty), an empty text or a non-`stop` finish reason → treated as unparsed (re-ask once, keep raw). Usage is still recorded on the span.
- `APICallError` with `statusCode` 429 whose details (`data.error.details`, else `responseBody`) carry a `QuotaFailure` with a `PerDay` quota → `ModelQuotaSpent`. Any other 429, or 503 → `ModelBusy`.
- A re-ask starts only when the time left is at least that agent's minimum call budget, set from G1's p95: analyst 8 s, smart pick and brand 33 s, hook 35 s. Otherwise the raw text is kept.
- **Analyze order:** `limited()` → `cutWindowClip` (`media/ffmpeg.ts`, temp file deleted in `finally`) → `measureWindow` → `chatJson`. `limited()` skips the provider during a spent quota.
- **Brand propose:** `ModelQuotaSpent` returns `{ wait: 'model quota spent' }`, and the brand page stops polling on that wait. `ModelBusy` returns `model busy` and keeps polling.
- Wrapped in `chatSpan` with provider `gcp.gemini` and `modelFor(agent)`.
- **YouTube API data never reaches Sentry (FR-017):**
  - Callers (smart pick, hook, brand) put every YouTube-sourced field in its own part marked `source: 'youtube'`.
  - Spans, the `hashtag_search` tool result and captured errors record those parts only as `{source, chars}` or `{mime, bytes, source}` (research R13).

## Removed exports

`modelStatus`, `ModelStatus`, `ModelWaking`, `SchemaName`, `TEMPERATURE`, `MAX_TOKENS` (now per agent).
