# Research: Gemini API in place of self-hosted Gemma

Checked 2026-10-21 and 2026-10-22 against:

- the Gemini API docs (models, pricing, video understanding, file input methods, Interactions API, structured output, troubleshooting, billing)
- the `ai` 7 and `@ai-sdk/google` 4 source
- the OpenTelemetry GenAI attribute registry

Gate G1 ran on the real project on 2026-10-22 (R12).

## R1 · Provider

- **Decision:** the Gemini Developer API (`generativelanguage.googleapis.com`), paid tier.
- **Rationale:** it hears audio and watches video in one call, so the analyst keeps today's inputs. It runs per token with no idle cost. It's a paid project, so prompts and responses are not used to improve Google's products.
- **Alternatives:**
  - Claude: no audio input, so the analyst can't hear genre, instruments or vocals, and those genre terms seed the audience search (R4). Rejected.
  - Gemini on Vertex AI (`enterprise: true`): same models, service-account auth. A fair second choice; switching later is a client option, not a rewrite.

## R2 · SDK and API surface

- **Versions:** latest as of 2026-10-22, which is fine for the alpha. Inline file parts, `store` and per-agent options were checked in the `@ai-sdk/google` 4.0.102 source and on the wire in G1.
- **Decision:** AI SDK `ai` 7.0.148 with the `@ai-sdk/google` 4.0.102 provider, calling `google.interactions(modelId)` through `generateText` and `Output.object({ schema: jsonSchema(...) })`. No other Google AI SDK.
- **Rationale:**
  - **Model swap is configuration.** A provider is one import plus a model id. Picks, hook and brand can move to another provider with no agent changes.
  - **Agent work later** builds on the same SDK's tools and `ToolLoopAgent`, not a second framework.
  - The Interactions provider covers everything used here: inline `video/mp4` file parts, `store`, `thinkingLevel`, `mediaResolution` and `responseFormat`.
- **Limit:** only Gemini hears audio. The analyst stays on Gemini whatever the picks run on (R1).
- **Settings on every call:**
  - `maxRetries: 0`, because the page driver retries (R7).
  - `abortSignal` with the step deadline.
  - Provider options `{ google: { store: false, thinkingLevel } }`, plus `mediaResolution: 'low'` for `chunk-analyst` only. The provider applies it to image parts too, and pick and brand need full-resolution thumbnails.
  - `maxOutputTokens` per agent.
  - `telemetry: { isEnabled: false }` (R10).
- **Client:** `createGoogle({ apiKey: GEMINI_API_KEY })`.
  - `createGoogleGenerativeAI` is a deprecated alias.
  - The default `google` singleton reads `GOOGLE_GENERATIVE_AI_API_KEY`, which this app doesn't set.
- **Instructions:** pass the system prompt as `instructions`. `system` is deprecated in `ai` 7. The provider maps it to `system_instruction`.
- **Telemetry:** AI SDK telemetry is off per call. The existing `chatSpan` keeps owning gen_ai spans, so the redaction rules stay in one tested place (R9, R10).
- **Alternatives:**
  - `@google/genai` alone: locks every agent to Gemini. Rejected after the user asked for swap-ready agent groundwork.
  - Genkit: multi-provider too, but a heavier runtime (flows, dev UI). Rejected.
  - Raw `fetch` to REST: no swap, no agent tools. Rejected.

## R3 · Video input: a small inline clip per window

- **Decision:** each analyze step uses ffmpeg to cut its window into a small clip and sends it inline.
  - ffmpeg reads the window from the GCS source by signed URL (range reads, as today).
  - It encodes the window to a 360p H.264/AAC MP4 in a temp file in `os.tmpdir()`, about 4 MB for 60 s.
  - The step reads the file and sends it inline as `{ type: 'file', mediaType: 'video/mp4', data: bytes }`.
  - The temp file is deleted in `finally`.
- **Rationale (measured in G1, R12):**
  - Gemini fetches a registered GCS file on every request. On the 2 GB upload, a 15 s clip of its last window timed out twice at 120 s (504) and answered once at 255 s, far over the ~2-minute step.
  - The same window as a 60 s, 3.8 MB inline clip answered in 6.4 s with the same output.
  - No registration, no GCS write, no provider-side state.
- **Constitution media rule:** a few MB per call, never the whole video. That's the same shape as today's per-window WAV and frames. The temp file follows the Short render pattern.
- **Inline limit:** a clip stays far under the provider's inline request size, about 4 MB against a 20 MB-class limit.
- **Alternatives (all measured on the same clip, same tokens, same correct answer):**

  | Option                                               | Latency                     | Verdict                                                                           |
  | ---------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
  | Register the 2 GB upload, clip by offsets            | 120 s × 2 (504), then 255 s | Rejected                                                                          |
  | Register a 58 MB 360p whole-video proxy made at prep | 34 s                        | Rejected: the prep transcode of 15 minutes of source likely blows the step budget |
  | Upload and register a 0.8 MB window clip             | 8 s                         | Rejected: an extra upload and registration per window for no gain over inline     |

## R4 · Window length

- **Decision:** `WINDOW_SEC = 60`, replacing 29.5 s.
  - The 29.5 s came from Gemma's 30 s audio cap, which is gone.
  - Chunk count = `ceil(duration / 60)`: 15 windows for a 15-minute video.
- **Rationale:** half the calls and steps. The measured analyst call is 6–8 s.
- **Short hook:** it still picks a window, and ffmpeg's loudness places the cut inside it. `short.ts` already reads `WINDOW_SEC`, so the hook follows the new length.
- **Trade-off:** "What the model heard" and the hook's starting window are coarser (one entry per minute).
- **Removed:** `FRAMES_PER_WINDOW`, and `extractWindow`'s in-memory WAV and frames. They're replaced by the clip cutter `cutWindowClip` and `measureWindow`.

## R5 · Models and per-agent settings

| Agent         | Model (default)                             | `thinking_level` | `max_output_tokens` |
| ------------- | ------------------------------------------- | ---------------- | ------------------- |
| chunk-analyst | `GEMINI_ANALYST_MODEL` = `gemini-3.8-flash` | `low`            | 2048                |
| smart-pick    | `GEMINI_PICK_MODEL` = `gemini-4-argon`      | `medium`         | 8192                |
| hook-pick     | `GEMINI_PICK_MODEL`                         | `low`            | 8192                |
| brand-guide   | `GEMINI_PICK_MODEL`                         | `medium`         | 8192                |

- **Temperature:** not sent. Interactions marks `generation_config.temperature` deprecated, and Gemini's guidance is to keep the default. AGENTS.md's "temperature 0.2" line is replaced.
- **Thinking:** thinking tokens count against `max_output_tokens`, and the cap is a hard cutoff: it returns `incomplete` with empty or truncated output and still bills. So every Argon agent gets 8192, and cost and latency are controlled by `thinking_level` only.
- **Analyst alternative:** `gemini-3.5-flash-lite` by setting `GEMINI_ANALYST_MODEL`. It's cheaper, but there's a risk on genre accuracy.
- **Pick alternatives:**
  - `gemini-3.1-pro-preview`: preview only, can churn. Rejected.
  - `gemini-3.8-flash` at high thinking: cheaper. Rejected per user choice.

## R6 · Cost

| Model                   | Input $/1M | Output $/1M | Price change                 |
| ----------------------- | ---------- | ----------- | ---------------------------- |
| `gemini-3.8-flash`      | 0.75       | 3.75        | 1.50 / 7.50 from 2027-01-01  |
| `gemini-3.5-flash-lite` | 0.30       | 2.50        | none announced               |
| `gemini-4-argon`        | 2.00       | 10.00       | 4.00 / 20.00 from 2026-12-01 |

- **15-minute job (the `MAX_MINUTES` cap) at post-increase prices, from G1's measured tokens:**
  - **Analyze:** 15 windows × ~5.5k input (measured for a 60 s low-res clip) ≈ 82k × $1.50 ≈ $0.12. Output 15 × ~500 × $7.50 ≈ $0.06.
  - **Pick:** about 15k input × $4 ≈ $0.06. Output measured about 0.4k (≈ $0.01), budgeted up to 8k (≈ $0.16).
  - **Typical:** about $0.25. That's under SC-006's $0.50 even with the pick's full output budget (≈ $0.40).
- **Worst case:** every analyst call re-asked at the full 2048 output tokens is 30 × (5.5k × $1.50 + 2048 × $7.50)/1M ≈ $0.71. Pick at up to 4 Argon calls (repeat × unparsed) ≈ $0.88. Total about $1.60. SC-006 states typical cost, not a ceiling.
- **Idle:** $0.

## R7 · Waits and errors

- **Decision:** `APICallError.statusCode` (AI SDK) 429 (`RESOURCE_EXHAUSTED`) or 503 (`UNAVAILABLE`) → throw `ModelBusy` → the step returns the wait `model busy`, keeps finished work and doesn't count a failure. Every other status counts as a failure through today's two-strike path.
- **Daily quota:** a 429 whose error details carry a `QuotaFailure` with a `quotaId` containing `PerDay` throws `ModelQuotaSpent` instead.
  - The details are on `APICallError.data.error.details` (the provider's parsed error schema). When that schema doesn't parse, `responseBody` is read as the fallback.
  - The step sets `limitUntil` to the next midnight Pacific and returns its own wait, `model quota spent`.
  - Later steps wait without calling the provider until then, the same pattern as YouTube's `DAILY_LIMIT`.
  - Brand propose isn't a job and has no `limitUntil`. It returns `{ wait: 'model quota spent' }`, and the brand page stops polling on that wait.
  - The body shape comes from the docs; G1 didn't capture a real one. Verify it on the first real occurrence.
- **Parse failures:**
  - `generateText` with `Output.object` throws `NoObjectGeneratedError` when the text doesn't parse or match the schema. The raw text is on `error.text`.
  - Reading the output of an empty, length-cut result throws `NoOutputGeneratedError`.
  - Both go to the unparsed path: one re-ask while budget allows, then keep the raw text (empty for the second). Neither counts as a hard failure.
- **Re-ask budget:** a re-ask starts only when the time left is at least that agent's minimum call budget. An aborted call is a `TimeoutError`, which is a hard failure.
  - The budgets are G1's p95: analyst ≈ 8 s (inline 60 s clip), smart pick 33 s, hook pick 35 s. Brand uses the smart-pick budget.
- **Analyze order:** `limited()` → `cutWindowClip` → `measureWindow` → the call.
  - `limited()` skips the provider during a spent quota.
  - The clip and measurements read the same window by signed URL.
- **Step budget:** clip cut, measurement and one analyst call (~6–8 s) plus one re-ask sit well inside ~2 minutes. The cut's real time on Cloud Run is checked in the deployed manual run.
- **No pre-flight check:** there's nothing to wake. `modelStatus`, `/health`, `/slots`, `ModelWaking`, and the `waking model` / `waiting on another run` waits are deleted.
- **No retry inside the step:** the page's driver already re-calls with its own backoff, and a step must not block (AGENTS.md).
- **Alternatives:**
  - Retry 429/503 inside the step with `p-retry`: blocks the step. Rejected.
  - Treat 500/504 as waits too: broadens a wait past the user's choice. Rejected; they're failures with retry.

## R8 · Auth and secrets

- **Decision:** one credential, `GEMINI_API_KEY`.
  - It's an AI Studio authorization key, an API key bound to a service account; requests act as that account.
  - It lives in Secret Manager as `soundboard-gemini-api-key`, synced from `.env` by `deploy.sh` like the other app secrets.
  - It's restricted to the Generative Language API.
- **G1 finding:** don't mix credentials.
  - The key plus an OAuth bearer token on one request → 401 "API key … used with other authentication credentials".
  - OAuth alone → 403 "Access to Gemini API is restricted with service accounts. Use authorization keys instead".
  - No `google-auth-library` client is used for model calls.
- **Removed:** the model `GoogleAuth`, the Vertex `aiplatform` invoke binding, and the planned Gemini service-agent bucket grant. Nothing reads the bucket on Gemini's side.

## R9 · Privacy and retention

- `store: false` on every interaction. Interactions are stored for 55 days on paid tier by default; nothing here reads them back.
- Paid-tier terms: content is not used to improve Google products. Abuse-monitoring logging still applies under Google's terms.
- Sentry (see also R13 for YouTube-sourced text and images):
  - Video parts become `{type: 'video', mime, bytes, clip}`: the byte count and the `<start>s–<end>s` range, never the data.
  - Image parts stay `{type, mime, bytes}`.

## R10 · Tracing

- `gen_ai.provider.name` = `gcp.gemini`, the OTel well-known value for the Gemini Developer API.
- `gen_ai.request.model` / `gen_ai.response.model` come from the call's model, so `chat <model>` span names differ per agent. That covers `invokeAgent` too, which today hard-codes `MODEL_NAME` (`tracing.ts:60`).
- Usage comes from the AI SDK result:
  - Fields: `inputTokens`, `outputTokens`, `outputTokenDetails.reasoningTokens` and `inputTokenDetails.cacheReadTokens`, all present in G1.
  - On `NoObjectGeneratedError`, usage is read from the error so the span still records it.
- Finish reason comes from the AI SDK, which maps the interaction's `incomplete` to `length`. A non-`stop` finish is treated as a parse failure (retry once, keep raw).
- **AI SDK telemetry off:** `@sentry/sveltekit` 11.4 turns on `vercelAIIntegration` by default, and it listens on `ai` 7's telemetry channel. `ai` skips telemetry only when `telemetry.isEnabled === false`. Without that, every call adds a second, unredacted `gen_ai` span. So every `generateText` passes `telemetry: { isEnabled: false }`, with a unit test.
- **Scrubbing:** unchanged. `scrubUrl` already strips the credential-bearing query from signed URLs that ffmpeg errors quote, and no provider file IDs exist anymore.

## R11 · Test doubles

- **Unit:**
  - Stub `fetch` at the provider boundary, as today for `llama-server`. The AI SDK sends through `fetch`, so no SDK module is mocked.
  - ffmpeg stays mocked at its process boundary.
  - No internal module mocks.
- **E2E:** drop the `tests/e2e/fakes/model.ts` HTTP server.
  - **Model fake:** under `E2E_FAKES=1`, the existing `e2eDb` `resolveId` plugin in `vite.config.ts` is generalized to also redirect `src/lib/server/ai/model.ts` to `tests/e2e/fakes/gemini.ts`.
    - `resolve.alias` can't do it: `$lib` modules can't be aliased that way, and `chunk-analyst.ts` and `smart-pick.ts` import `./model` by relative path.
    - The fake defines its own `ModelBusy`, `ModelQuotaSpent`, `stepDeadline`, `modelFor`, `chat` and `chatJson`, and never imports the real module (a redirect by resolved file would loop back to the fake).
    - `chat` throws `ModelBusy`, so model steps end at the `model busy` wait, as they end at `waking model` today.
  - **Storage fake:** analyze now runs ffmpeg before the call, so the fake's signed URL can't stay an empty `data:` URL.
    - It points at a 3 s fixture video, generated by Playwright global setup with ffmpeg (`testsrc` + `sine`), not committed.
    - The cut and measurement succeed, and then the fake `chat` waits.
- **Rejected:** pointing the SDK at a fake base URL from a `GEMINI_BASE_URL` setting adds a production setting for tests.

## R12 · Manual gate G1 (constitution V): ran 2026-10-22

- **Setup:** real paid project, `gemini-3.8-flash` and `gemini-4-argon`.
- **Test video:** synthetic, 15 minutes, 1.97 GB, with an on-screen seconds counter and a spoken "Window N" per window.
- **Spend:** under about $0.40 in all. Every test object was deleted afterwards.

| #   | Check                                             | Result                                                                                                                                                                                              |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `registerFiles` on the 2 GB object, ×31           | ✅ all succeeded, 0.3–0.5 s each. No `state` or `expirationTime` is returned. Works with the authorization key alone once its bound service account can read the bucket. Now moot: no registration. |
| 2   | Auth                                              | Key + OAuth → 401; OAuth only → 403 (R8). One credential.                                                                                                                                           |
| 3   | `store: false` and clip offsets on the wire       | ✅ `processing {type: static, start_offset: "885s", end_offset: "900s"}`                                                                                                                            |
| 4   | Clip limits frames **and** audio                  | ✅ heard only "Window 30", saw only 885–899. Window 3 likewise.                                                                                                                                     |
| 5   | Tokens scale with clip length                     | ✅ ~1.4k for 15 s, ~2.7k for 29.5 s, ~5.5k for an inline 60 s clip                                                                                                                                  |
| 6   | Analyst, registered 2 GB file, last window, ≤30 s | ❌ 504 at 120 s twice, one success at 255 s                                                                                                                                                         |
| 7   | Fallbacks, same clip and tokens, correct output   | 58 MB proxy registered 34 s; 0.8 MB window clip registered 8 s; **60 s clip (3.8 MB) inline 6.4 s**. Adopted: inline (R3).                                                                          |
| 8   | Argon smart pick (`medium`), 5 runs               | ✅ p95 32.8 s                                                                                                                                                                                       |
| 9   | Argon hook pick (`low`), 5 runs                   | ✅ p95 34.6 s                                                                                                                                                                                       |
| 10  | Per-day quota 429 body                            | Not captured; the shape comes from the docs (R7)                                                                                                                                                    |

- The pick and hook prompts were synthetic, at recorded-size. Real prompts are checked in the deployed manual run.
- p95s set the minimum call budgets (R7).

## R13 · YouTube API policy compliance (FR-017–FR-021)

Checked against the YouTube API Services Developer Policies (last updated 2026-10-15). Starting point is `main` after #20: genre-search evidence lives in `job_audience` with its retrieval time, every read goes through the `job_audience_fresh` view (rows under 30 days), a daily Neon function deletes the rest, and candidates arrive as up to 10 separate `candidateLists`.

- **FR-017: no YouTube API data in traces (III.E.4).**
  - **Decision:** mark every YouTube-sourced prompt part at construction with `source: 'youtube'`:
    - genre-search candidate lists;
    - top-video titles, descriptions and tags;
    - the artist's recent uploads;
    - thumbnails.
  - **Required split:** today `smart-pick.ts` packs all context into one JSON text part. The YouTube-sourced fields move into their own text parts so they can be marked; song title, notes, windows, facts and feedback stay in the unmarked part. Brand (`brand.ts`) and hook (`short.ts`) mark theirs the same way.
  - **Redaction:** `redactMessages` turns a marked text part into `{type: 'text', source, chars}` and a marked image into `{type, mime, bytes, source}`. Song title, notes and model output stay.
  - **Tool span:** the `hashtag_search` span's `gen_ai.tool.call.result` (`hashtags.ts`, today the full `candidateLists`) records only list and term counts.
  - **Errors:** messages that quote prompt text are redacted the same way before `captureException`.
  - **Rationale:** III.E.4 caps stored API data at 30 days, and a Sentry span is a store this app doesn't control.
  - **Alternatives:**
    - Rely on Sentry's retention setting: not under our control per plan, and still a third-party store. Rejected.
    - Drop prompt tracing: loses the debugging the spans exist for. Rejected.
- **FR-018: privacy page (III.A.2.e).**
  - **Decision:** `/privacy` replaces "the self-hosted model" with the Gemini API as a processor. It runs on the paid tier, `store: false` means it keeps nothing, and it doesn't train on the data. It receives short clips of the artist's video and YouTube metadata.
  - The Sentry paragraph also changes: YouTube-sourced text and images are replaced by placeholders.
- **FR-019: the owner's III.E.4.h position.**
  - **Decision:** drafts informed by YouTube API data are new content for the user's own upload, not metrics, scores or replacements for YouTube data.
  - API data is used per call only. The provider stores nothing (`store: false`), and app storage stays under #20's 30-day view and daily cleanup.
  - The YouTube audit application describes this use.
  - **Risk:** this is a stated position, not a YouTube ruling. A contrary audit answer reopens the spec.
- **FR-020: the artist's own authorized data (III.E.3.b).**
  - **Decision:** recent uploads and thumbnails go to Gemini only inside that artist's own pick or brand request.
  - The `artistJob` gating is unchanged: other users' picks get no artist data.
- **FR-021: pick latency at the #20 prompt size.**
  - **Decision:** re-time the pick before building pick changes. This is a G1 follow-up:
    - 5 Argon runs at `medium`.
    - The prompt is 10 full candidate lists (40 tags and 30 hashtags each), 5 top videos and 3 recent uploads: about 30k input tokens each, about $0.30 total at post-increase prices.
  - **Pass:** p95 ≤ 45 s. If it fails, lower the thinking level before raising any budget.
  - **Status:** passed on 2026-10-23. All 5 runs succeeded at 12.7k input tokens (about 0.4k output) with a p95 of 10.5 s, for $0.15 in total. The smart-pick minimum call budget stays at the G1 value of 33 s, the slower of the two measurements.
