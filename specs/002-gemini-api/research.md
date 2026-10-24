# Research: Gemini API in place of self-hosted Gemma

Checked 2026-10-21 through 2026-10-24 against:

- the Gemini API docs (models, pricing, video understanding, file input methods, Interactions API, structured output, troubleshooting, billing)
- the `ai` 7 and `@ai-sdk/google` 4 source
- the OpenTelemetry GenAI attribute registry

Gate G1 ran on the real project on 2026-10-22 (R12).

## R1 · Provider

- **Decision:** the Gemini Developer API (`generativelanguage.googleapis.com`), paid tier.
- **Rationale:** it hears audio and watches video in one call, so the analyst keeps today's inputs. It runs per token with no idle cost. It's a paid project, so prompts and responses are not used to improve Google's products.
- **Alternatives:**
  - Claude: no audio input, so the analyst can't hear genre, instruments or vocals, and those genre terms seed the audience search (R4). Rejected.
  - Gemini on Vertex AI (`enterprise: true`): same models, service-account auth. Rejected as a retention fallback (checked 2026-10-24):
    - Without a Google Cloud Master Agreement, abuse monitoring logs Gemini prompts for up to 90 days, longer than the Developer API's 55.
    - The 30-day tier covers only "Google Frontier Models". The only Gemini one is `gemini-4-argon-cyber-permissive`, allowlisted for defensive security work.
    - Interactions there is Preview and `global`-endpoint only.

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
  - Encode H.264/AAC MP4, fit within 640×360 with aspect ratio/rotation preserved and even dimensions, at most 30 fps, video maxrate 600 kbit/s with 1200 kbit VBV buffer, AAC 96 kbit/s stereo at 48 kHz, faststart. G2 uses this exact encoding profile.
  - Use a unique temp file under `os.tmpdir()`. `stat` must show at most 8,000,000 bytes before reading it. The bitrate cap bounds the size by construction; the check is the backstop.
  - Do not use an output-size truncation flag or shorten the requested window to fit. Oversize or incomplete output fails the step without calling the provider; deletion still runs.
  - The step reads the file and sends it inline as `{ type: 'file', mediaType: 'video/mp4', data: bytes }`.
  - The temp file is deleted in `finally`.
- **Rationale (measured in G1, R12):**
  - Gemini fetches a registered GCS file on every request. On the 2 GB upload, a 15 s clip of its last window timed out twice at 120 s (504) and answered once at 255 s, far over the ~2-minute step.
  - The same window as a 60 s, 3.8 MB inline clip answered in 6.4 s with the same output.
  - No Files API registration, no GCS write and no stored interaction IDs.
- **Constitution media rule:** a few MB per call, never the whole video. That's the same shape as today's per-window WAV and frames. The temp file follows the Short render pattern.
- **Inline limit:** the docs cap an inline video request at 20 MB in total. 8,000,000 clip bytes are at most 10.7 MB as base64, and the analyst's text is a few KB, so no separate request-size check is needed.
- **Alternatives (all measured on the same clip, same tokens, same correct answer):**

  | Option                                               | Latency                     | Verdict                                                                           |
  | ---------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
  | Register the 2 GB upload, clip by offsets            | 120 s × 2 (504), then 255 s | Rejected                                                                          |
  | Register a 58 MB 360p whole-video proxy made at prep | 34 s                        | Rejected: the prep transcode of 15 minutes of source likely blows the step budget |
  | Upload and register a 0.8 MB window clip             | 8 s                         | Rejected: an extra upload and registration per window for no gain over inline     |

## R4 · Window length

- **Decision:** `WINDOW_SEC = 60`, replacing 29.5 s.
  - The 29.5 s came from Gemma's 30 s audio cap, which is gone.
  - Chunk count keeps today's `chunkCount` helper, which skips a trailing sliver under 1 s: 15 windows for a 15-minute video.
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
- **Analyst row confirmed by G2** (R14, 2026-10-24): configuration A passed.
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
  - Brand propose isn't a job and has no `limitUntil`. It returns `{ wait: 'model quota spent' }`, and the brand page stops polling on that wait. Nothing is persisted; a manual retry before the reset gets the same wait from the provider.
  - The body shape comes from the docs; G1 didn't capture a real one. Verify it on the first real occurrence.
- **Parse failures:**
  - `generateText` with `Output.object` throws `NoObjectGeneratedError` when the text doesn't parse or match the schema. The raw text is on `error.text`.
  - Reading the output of an empty, length-cut result throws `NoOutputGeneratedError`.
  - Both go to the unparsed path: one re-ask while budget allows, then return raw text (empty for the second). The analyst stores stripped raw text; pick/hook turn exhaustion into an ordinary failed step and brand returns its retryable error. All attempts retain raw text in the chat span; no new database diagnostic field.
- **Re-ask budget:** a re-ask starts only when the time left is at least that agent's minimum call budget. An aborted call is a `TimeoutError`, which is a hard failure.
  - The budgets are G1's p95: analyst ≈ 8 s (inline 60 s clip), smart pick 33 s, hook pick 35 s. Brand uses the smart-pick budget.
- **Analyze order:** chunk-count compatibility reset (data-model "Window") → `limited()` → `cutWindowClip` → `measureWindow` → the call.
  - `limited()` skips the provider during a spent quota.
  - The clip and measurements read the same window by signed URL.
- **Step budget:** one `stepDeadline()` starts at claimed-step entry, not inside each helper. Reserve the final 5 s of its 110 s for process termination, temp cleanup and persistence; cut gets at most 45 s and measurement at most 20 s, each clipped to the remaining work budget. Model calls and re-asks share what remains; never reset the deadline. Prep probing/measurement and existing hook/render reserves must also fit their step budget.
- Await ffmpeg termination before removing its file; retain the source format/protocol restrictions. A timeout takes the ordinary failure path and saves no partial chunk.
- **Runtime proof:** after FR-023 approval, measure first and last windows of a maximum-size, 15-minute source on the 2-vCPU Cloud Run service, including seek, encode, measurement and model time. A slow source must return a bounded failure rather than overrun the claim. G1's inference-only timing is not this proof.
- **Error identity:** classify SDK errors before telemetry; keep typed busy/quota errors and reset times intact. Trace recording never replaces the thrown error. Captured events omit SDK bodies, headers and media-bearing causes while retaining safe diagnostics.
- **No pre-flight check:** there's nothing to wake. `modelStatus`, `/health`, `/slots`, `ModelWaking`, and the `waking model` / `waiting on another run` waits are deleted.
- **No busy/quota retry inside the step:** the page's driver already re-calls with its own backoff, and a step must not block (AGENTS.md).
- **Alternatives:**
  - Retry 429/503 inside the step with `p-retry`: blocks the step. Rejected.
  - Treat 500/504 as waits too: broadens a wait past the user's choice. Rejected; they're failures with retry.

## R8 · Auth and secrets

- **Decision:** one credential, `GEMINI_API_KEY`.
  - It's an AI Studio authorization key, an API key bound to a service account; requests act as that account.
  - It lives in Secret Manager as `soundboard-gemini-api-key`, synced from `.env` by `deploy.sh` like the other app secrets.
  - It's restricted to the Generative Language API.
  - One key for dev and prod, the same pattern as the YouTube API key (owner's call, 2026-10-24). Local runs share prod's spend, per-day quota and abuse log. Rejected: a separate paid dev project and key.
- **G1 finding:** don't mix credentials.
  - The key plus an OAuth bearer token on one request → 401 "API key … used with other authentication credentials".
  - OAuth alone → 403 "Access to Gemini API is restricted with service accounts. Use authorization keys instead".
  - No `google-auth-library` client is used for model calls.
- **Removed:** the model `GoogleAuth`, the Vertex `aiplatform` invoke binding, and the planned Gemini service-agent bucket grant. Nothing reads the bucket on Gemini's side.

## R9 · Privacy and retention

- `store: false` on every interaction. Without it, interactions are stored for 55 days on the paid tier. `store: false` turns off that state storage only.
- Abuse monitoring is separate. Google logs prompts and responses for up to 55 days for policy enforcement; its terms permit policy-enforcement model training, not general product improvement. `store: false` does not turn it off. No shorter provider retention was established for this project (R1).
- Implicit caching is enabled by default on stateless Interactions calls too; the docs do not establish a cache TTL or disabling control here. The app requests no explicit cache, file upload or grounding. Never claim the abuse log is the only provider copy.
- Paid-tier terms: content is not used to improve Google products. The owner accepts implicit-cache and abuse-log storage risk, subject to the deployment approval gate (FR-023).
- Sentry (R13): all agents retain text diagnostics; media and secrets stay redacted.
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
- **E2E:** replace the old `tests/e2e/fakes/model.ts` server with an E2E-only Node preload, `tests/e2e/fakes/gemini.ts`, on the preview server command.
  - The preload intercepts `fetch` to the Gemini HTTP endpoint and returns fixture responses (normally a 429 busy response); the real SDK and `ai/model.ts` still execute. No client-module alias, duplicated error classes or production fake-URL setting.
  - Supply a dummy Gemini key, never real credentials. Unhandled Gemini requests fail the test rather than reaching the internet.
  - **Window media fake (owner's call, 2026-10-24):** `cutWindowClip` and `measureWindow` live in their own module, `src/lib/server/media/window.ts`. Under `E2E_FAKES=1` the existing `resolveId` plugin swaps it for `tests/e2e/fakes/window.ts`, like db, KMS and Storage. The fake writes a few dummy bytes to a temp file and returns fixed measurements.
    - E2E runs no ffmpeg, as today. The storage fake's `data:` URL stays.
    - Analyze runs in E2E up to the model call, where the preload's 429 gives `model busy`.
    - Real cuts are covered by unit tests (ffmpeg mocked at the process) and the deployed manual run.
    - Rejected: a Linux container runner, and CI-only ffmpeg. ffmpeg verifies HTTPS certificates by default and the app only allows `https` sources, so both need a fixture HTTPS server plus per-OS certificate trust.
- **Rejected:** a production `GEMINI_BASE_URL` setting solely for tests, and replacing `ai/model.ts` with an internal module fake; the E2E-only HTTP preload needs neither.

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

- **FR-017: text tracing retained (owner decision, 2026-10-24).**
  - Every agent records system/user/assistant text, replies and reasoning. No `recordText` setting, sizes-only text mode or per-agent error replacement. Existing media/secret scrubbing remains, as does the single manually controlled `chatSpan`.
  - Failed parse attempts record available raw text in the chat span before the client returns unparsed output. Pick/brand debugging uses Sentry; the job row is not claimed to store their raw replies.
  - `hashtag_search` keeps its existing diagnostic result. No new text-suppression plumbing.
  - The owner accepts the storage risk and prefers the simpler implementation; FR-023 blocks all deployments until the YouTube request is approved.
- **Hosted Sentry retention, checked 2026-10-24:**
  - Current Developer: errors/spans 30 days. Team: errors 90 days, spans 30 days. Business/Enterprise: errors 90 days; full spans 30 days plus sampled spans up to 13 months.
  - Legacy Team/Business transaction billing: transactions 90 days. The actual organization plan and any negotiated override must be recorded before deployment; they were not inspected during this design review.
  - No self-service shorter-retention setting is documented for hosted Team/Business. Sentry support documents shorter retention through an Enterprise agreement; ask support if desired, without making it an implementation dependency.
  - Sampling controls ingestion, not deletion time; `SENTRY_EVENT_RETENTION_DAYS` applies only to self-hosted Sentry. Plan changes affect newly ingested data, not existing retention deadlines.
  - No application purge worker, plan upgrade or self-hosted Sentry deployment is part of this feature.
- **FR-018: privacy and audit disclosure.** Name Gemini clips/metadata processing, implicit caching, the 55-day abuse log and possible human review; name Sentry text tracing with actual plan retention and deletion limits. Never promise zero retention, no policy-enforcement model use, or that removing Soundboard data deletes all processor copies.
- **FR-019: owner's position and deployment gate.** Drafts are treated as new content for the user's upload, not derived metrics. `store: false` disables interaction history only. Database evidence still expires under #20. The owner accepts provider/Sentry storage risk; this is not a YouTube approval. Record the approval reference and its scope before any feature deployment; a narrower or contrary answer reopens the affected design.
- **FR-020: the artist's own authorized data (III.E.3.b).**
  - **Decision:** recent uploads and thumbnails go to Gemini only inside that artist's own pick or brand request.
  - The `artistJob` gating is unchanged: other users' picks get no artist data.
- **FR-021: pick latency at the #20 prompt size.**
  - **Decision:** re-time the pick before building pick changes. This is a G1 follow-up:
    - 5 Argon runs at `medium`.
    - The prompt is 10 full candidate lists (40 tags and 30 hashtags each), 5 top videos and 3 recent uploads: about 30k input tokens each, about $0.30 total at post-increase prices.
  - **Pass:** p95 ≤ 45 s. If it fails, lower the thinking level before raising any budget.
  - **Status:** passed on 2026-10-23. All 5 runs succeeded at 12.7k input tokens (about 0.4k output) with a p95 of 10.5 s, for $0.15 in total. The smart-pick minimum call budget stays at the G1 value of 33 s, the slower of the two measurements.

## R14 · Manual gate G2: analyst quality on real music (FR-022): passed 2026-10-24 on A

- **Why:** G1 used a synthetic video (a seconds counter and a spoken "Window N"). It proved clip handling, not whether Flash hears genre, instruments and vocals. Those genre terms seed the audience search, so a weak analyst degrades every candidate list.
- **Videos:** 3–5 of Nathan's real uploads, covering different sounds and at least one long video.
- **Baseline:** Gemma's chunk analyses of the same videos, from stored jobs where they exist, otherwise a run on the current endpoint before teardown (FR-014). Each 60 s window is compared with the Gemma windows it covers.
- **Configurations:**

  | #   | Model              | `mediaResolution` | `thinkingLevel` |
  | --- | ------------------ | ----------------- | --------------- |
  | A   | `gemini-3.8-flash` | `low`             | `low`           |
  | B   | `gemini-3.8-flash` | default           | `medium`        |
  | C   | `gemini-4-argon`   | default           | `medium`        |

- **Scoring, per window:** genre terms, instruments, vocals (present, style), and quality flags, each judged at least as good as Gemma, or worse. Nathan's own description of each song breaks ties.
- **Pass:** the analyst ships on the cheapest configuration (A, then B, then C) that's at least as good as Gemma. A pass on B or C updates R5 and R6 before the analyst is built. If none passes, the spec reopens.
- **Cost:** estimate from the selected videos' actual window counts and each configuration's token use, then record actual spend; no fixed $1 claim independent of sample length.
- **Record:** a table here per video/configuration with window-level judgments, tokens, latency and the exact clip encoding/settings, like R12. A chosen B/C configuration must also meet SC-006 and the call budget, and update every default in spec, plan, contract and quickstart before analyst implementation. Quality alone does not waive the cost or time requirements.

### G2 run, 2026-10-24

- **Evidence:** the harness is [gates/g2/g2.mjs](gates/g2/g2.mjs), and every model reply, token count and latency is in [gates/g2/result.json](gates/g2/result.json).
- **Verdict:** configuration A passes. It's at least as good as Gemma on every window and clearly better on one video. The analyst defaults stay as planned (`gemini-3.8-flash`, `mediaResolution: 'low'`, `thinkingLevel: 'low'`); R5, R6 and the 8 s minimum call budget are unchanged.
- **Sample:** 3 of Nathan's videos, all short (49–79 s): 4 Gemini windows against 7 Gemma windows. There was no long video, so the first-and-last-window timing of a 15-minute source stays a deployed check (quickstart step 2).
- **Setup:**
  - Clips used the R3 profile exactly. Portrait sources come out at 202×360; clips were 0.30–1.87 MB, cut in 0.3–0.9 s.
  - Every arm got the same context, with the song title set to "Untitled". Gemini's instructions changed only in their first line, which describes a clip instead of frames.
  - Gemma got today's input: 29.5 s windows, 8 frames, 16 kHz WAV, temperature 0.2, on the existing endpoint (cold start 186 s).
  - B and C used `maxOutputTokens` 8192 to avoid truncation; A used 2048.
- **Ground truth:** the owner listened to every point where the models disagreed.

| Video                            | Point    | Truth (owner)                        | Gemma                                     | A (Flash low)                                   | B (Flash default/medium)              | C (Argon)                                  |
| -------------------------------- | -------- | ------------------------------------ | ----------------------------------------- | ----------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| YouCut 1 (office CCTV, 55 s)     | Intro    | Female spoken intro                  | Missed                                    | Spoken intro heard, wrong gender                | Missed                                | ✅                                         |
|                                  | Vocals   | Robotic male lead                    | ✅ distorted robotic male                 | ✅ deep robotic, vocoded male                   | ✅ deep deadpan, robotic male         | ✅                                         |
|                                  | Visual   | —                                    | Office, then terminal text                | Better: CCTV office, terminal, mazes            | Better: names the computer thrown out | Better                                     |
| YouCut 2 (neon hallway, 49 s)    | Tempo    | Driving four-on-the-floor            | Slow, then driving (half wrong)           | Midtempo (vague)                                | Steady (vague)                        | ✅                                         |
|                                  | Vocals   | —                                    | Muffled, then distorted male              | Better: pitch-shifted baritone plus robot intro | Better: same detail                   | Better                                     |
|                                  | Clipping | Real (ffmpeg: 78 samples, +1.8 dBTP) | Missed                                    | Missed                                          | Missed                                | ✅ flagged                                 |
| VAPORGRAM (green terminal, 79 s) | Genre    | Indie / post-punk with guitar        | ❌ dark ambient / industrial, "no vocals" | ✅ indie rock, post-punk, electric guitar       | ❌ synth-pop, no guitar               | Window 1 ✅; window 0 says industrial rock |
|                                  | Vocals   | Gruff, spoken male                   | ❌ none, then distorted fragments         | ✅ spoken, gruff male                           | ✅ deep semi-spoken male              | ✅ gritty male                             |

- **Scoring against Gemma:**
  - **A:** ties or wins every point: a tie on clipping, which Gemma, A and B all missed; a win on VAPORGRAM and on visuals; a partial win on the YouCut 1 intro.
  - **B:** passes too, but misses VAPORGRAM's genre and costs more.
  - **C:** the most accurate (intro, tempo, clipping), but it costs about 3× more per window and had one 35 s call.
- **Quality flags:** clipping reaches the job anyway through the server-built ffmpeg flags (FR-011), so A missing it doesn't lose information.
- **Latency per call:** A 4.5–5.4 s, B 7.2–9.0 s, C 5.9–35.5 s. Gemma took 9.9–27.9 s per 29.5 s window.
- **Tokens:** a 60 s clip used 4.7–5.7k input tokens on Flash and 5.7–6.8k on Argon. Output was about 200 tokens for A and C, and 440–580 for B (300–370 of them reasoning).
- **Spend:**
  - Gemini about $0.09 at intro prices.
  - GPU time: two endpoint wakes. The first attempt's harness used the bare endpoint ID, got 400s and let the replica scale back down.
- **Gemma baseline:** captured in this run, so the GPU teardown (FR-014) no longer waits on G2.
