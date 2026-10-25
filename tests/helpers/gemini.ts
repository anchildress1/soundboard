// Gemini Interactions API wire fixtures, shared by unit tests and the E2E preload. No test-runner
// imports: the preload loads this under plain Node.

export const GEMINI_INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A finished interaction whose model output is `text`. */
export function interaction(
  text: string,
  over: { status?: string; reasoning?: string; id?: string } = {},
): Response {
  return json(200, {
    id: over.id ?? 'interaction-1',
    status: over.status ?? 'completed',
    steps: [
      { type: 'thought', summary: [{ type: 'text', text: over.reasoning ?? 'thinking...' }] },
      { type: 'model_output', content: [{ type: 'text', text }] },
    ],
    usage: {
      total_input_tokens: 10,
      total_cached_tokens: 2,
      total_output_tokens: 5,
      total_thought_tokens: 3,
      total_tokens: 18,
    },
  });
}

const quotaFailure = (quotaId: string) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_requests', quotaId }],
});

/** Google's error envelope. */
export const geminiError = (status: number, code: string, details: unknown[] = []) =>
  json(status, { error: { code: status, message: `${code} from Gemini`, status: code, details } });

/** A per-minute 429: busy, try again shortly. */
export const busy429 = () =>
  geminiError(429, 'RESOURCE_EXHAUSTED', [quotaFailure('GenerateRequestsPerMinutePerProject')]);

/** A per-day 429: the quota is spent until midnight Pacific. */
export const perDay429 = () =>
  geminiError(429, 'RESOURCE_EXHAUSTED', [
    quotaFailure('GenerateRequestsPerDayPerProjectPerModel'),
  ]);

/** A per-day 429 whose envelope lacks `status`, so only the raw body carries the details. */
export const perDay429BodyOnly = () =>
  json(429, {
    error: {
      code: 429,
      message: 'quota',
      details: [quotaFailure('GenerateRequestsPerDayPerProjectPerModel')],
    },
  });

export const unavailable503 = () => geminiError(503, 'UNAVAILABLE');
export const badRequest400 = () => geminiError(400, 'INVALID_ARGUMENT');
