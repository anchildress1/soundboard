# Implementation Plan: Gemini API in place of self-hosted Gemma

**Branch**: `002-gemini-api` | **Date**: 2026-10-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-gemini-api/spec.md`

## Summary

Replace `llama-server` + Gemma 4 on the Vertex L4 endpoint with the Gemini API through the AI SDK (`ai` + `@ai-sdk/google`, Interactions), so later agent work and model swaps reuse one client.

- **Analyst:** `gemini-3.8-flash` watches and hears one 60 s window per analyze step. ffmpeg cuts the window from the GCS source into a small 360p clip (temp file, about 4 MB), and it's sent inline. No frames and no WAV. Gate G1 showed registering the full upload is far too slow (research R3, R12).
- **Picks:** smart pick, hook pick and brand guide run on `gemini-4-argon`.
- **Waits:** provider 429/503 become the `model busy` wait. A spent daily quota becomes `model quota spent` until the reset. The scale-to-zero waits and readiness checks are deleted.
- **Removed:** the Vertex endpoint, the model image, `MODEL_URL`, and their deploy steps.
- **Unchanged:** ffmpeg keeps every number. Every R4 output rule and schema stays the same. Windows become 60 s (was 29.5 s), and the Short hook follows `WINDOW_SEC`.

## Technical Context

**Language/Version**: TypeScript 6 strict, Node 24 (`.nvmrc`)

**Primary Dependencies**:

- New: `ai` 7.0.148 and `@ai-sdk/google` 4.0.102 for every model call (research R2)
- Existing, kept: SvelteKit 2 / Svelte 5, `google-auth-library` 11.1.0 (sign-in only), `@sentry/sveltekit` 11.4.0, `p-retry` 8.0.1 (parse re-ask only)
- Removed from runtime: the model container (`model/Dockerfile`, `build-model.sh`)

**Storage**: Neon Postgres, unchanged; no migration. GCS bucket unchanged; Gemini never reads it.

**Testing**: Vitest 5 + coverage floors 85/85/85/80. Provider mocked at `fetch`; ffmpeg mocked at its process boundary. Playwright (desktop Chrome, Pixel 7) with a faked Gemini client module under `E2E_FAKES=1` (research R11).

**Target Platform**: Cloud Run, one service, max 1 instance, us-central1. No GPU anywhere.

**Project Type**: Web application, SvelteKit single project

**Performance Goals**:

- Measured in G1: analyst ≈ 6–8 s per 60 s inline clip; Argon pick p95 32.8 s and hook p95 34.6 s (≤ 45 s).
- Every step under about 2 minutes.
- Warm 30 s video ≤ 2 min to recommendation.

**Constraints**:

- Paid tier only; `store: false`.
- Only one window's small clip passes through the app per call, never the whole video.
- No retries that block a step.
- No token, key, URI or media in Sentry.

**Scale/Scope**:

- 2 users.
- A 15-minute job is 15 analyst calls plus one pick, about $0.25 typical at post-increase prices. The worst case is about $1.60 with every re-ask (research R6).

## Constitution Check

Gates from `.specify/memory/constitution.md` v2.0.0 (amended 2026-10-22 for this spec, 003 and 005).

| Principle                     | Status      | Notes                                                                                                                                                                                                                                    |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data                 | ✅          | The clip is cut from a job already loaded through `authorizedJob` / the claimed step. No new cache or credential crosses users. The API key is app-wide, like the YouTube search key.                                                    |
| II. Truthful Output           | ✅          | Numerics stripping, candidate-only tags, server-built flags and read-back verify are untouched.                                                                                                                                          |
| III. One Service, Page-Driven | ✅ amended  | No new service, queue or worker. "One model endpoint" becomes "one model provider". Waits stay immediate (`model busy`, `model quota spent`). A provider 401/403 is a failure, not a wait, so "unauthorized" must mean user grants only. |
| IV. Domain-Grouped            | ✅ amended  | The client stays in `src/lib/server/ai/model.ts`. IV says every external platform lives in `platforms/<name>/`, with no publishing-only carve-out, so the model provider needs an explicit exemption.                                    |
| V. Tested at the Boundaries   | ✅ amended  | The mock boundary list swaps `llama-server` for the Gemini API. Gate G1 ran 2026-10-22 (research R12).                                                                                                                                   |
| VI. Simplicity                | ✅          | Net deletion: model image, Vertex deploy, readiness checks, ffmpeg frame/WAV extraction. One clip cutter replaces them. No compat path.                                                                                                  |
| Media, Privacy, Secrets       | ✅          | A window clip (a few MB) replaces today's in-memory WAV and frames; the whole video is never buffered. The temp file is deleted in `finally`. The API key lives in Secret Manager. Sentry redacts video to a placeholder.                |
| Workflow                      | ✅ approved | `package.json` (+`ai`, `@ai-sdk/google`), `deploy.sh`, `service.yaml`, `.env.example`, `playwright.config.ts`, `vite.config.ts`, `Makefile`, `cleanup-policy.json` change. These are repo config; the owner approved them on 2026-10-22. |

**Amendment:** done in constitution 2.0.0 (2026-10-22). It covers:

- III: "One Cloud Run service and one model provider." "Unauthorized" in the wait rule means a user's missing or revoked grant; an app credential the provider rejects is a failure.
- IV: the model provider is exempt from `platforms/`, and its calls, scopes and error mapping live only in `src/lib/server/ai/model.ts`.
- V: replace `llama-server` with "the model provider's HTTP API".

**Post-design re-check:** unchanged. No new violations from Phase 1.

## Project Structure

### Documentation (this feature)

```text
specs/002-gemini-api/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/model-client.md
├── checklists/requirements.md
└── tasks.md          # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/server/ai/
├── model.ts            # rewritten: AI SDK client, chat, chatJson, ModelBusy, ModelQuotaSpent, modelFor, per-agent min call budget
├── chunk-analyst.ts    # one inline video part (the window clip); no frames/WAV
├── smart-pick.ts       # ModelRequest; thumbnails as image parts
├── numerics.ts, shape.ts   # unchanged
src/lib/server/artist/brand.ts      # ModelRequest; ModelBusy → 'model busy'; ModelQuotaSpent → 'model quota spent'; no modelStatus
src/routes/brand/+page.svelte, src/routes/api/brand/propose/+server.ts   # new waits; stop polling on 'model quota spent'; no waking-model copy
src/lib/server/pipeline/
├── pipeline.ts         # drop modelWait/NEEDS_MODEL pre-flight; ModelBusy → 'model busy'; ModelQuotaSpent → limitUntil + 'model quota spent'; analyze order limited() → cutWindowClip → measureWindow
└── short.ts            # hook-pick via ModelRequest
src/lib/server/media/ffmpeg.ts      # WINDOW_SEC 60; extractWindow → cutWindowClip (360p MP4 temp file) + measureWindow; drop FRAMES_PER_WINDOW
src/lib/server/core/
├── env.ts              # drop modelUrl; add geminiApiKey, analystModel, pickModel
└── tracing.ts          # Part/ModelRequest, provider gcp.gemini, per-call model on chatSpan and invokeAgent (no MODEL_NAME), video redaction
src/lib/server/jobs/view.ts         # JobView.model
src/lib/types.ts                    # Wait: 'model busy', 'model quota spent'; JobView.model
src/lib/status.ts (text for both new waits), src/lib/components/Short.svelte, src/lib/components/Track.svelte, src/routes/jobs/[id]/+page.svelte  # label from view.model; new wait texts; drop stale model comments
src/routes/+layout.svelte           # meta description drops "self-hosted Gemma 4"
tests/unit/… mirrors the above; tests/helpers/pipeline.ts updated for the new client; tests/e2e/fakes/gemini.ts replaces fakes/model.ts and defines its own ModelBusy, ModelQuotaSpent, stepDeadline, modelFor, chat, chatJson (never imports model.ts); tests/e2e/fakes/storage.ts signed URL points at a 3 s fixture video generated in Playwright global setup; tests/e2e/short.spec.ts updated for the new wait
deploy.sh, service.yaml, .env.example, playwright.config.ts, vite.config.ts   # config (approved); deploy.sh enables generativelanguage.googleapis.com and drops aiplatform; vite.config.ts generalizes the e2eDb resolveId plugin to redirect ai/model.ts
Makefile, cleanup-policy.json      # config (approved): drop the model-image target and its .PHONY entry; drop keep-model-2
model/, build-model.sh             # deleted
docs/prd.md, README.md, AGENTS.md, .specify/memory/constitution.md   # FR-016
```

**Structure Decision**: Single SvelteKit project. The change stays inside the existing `ai`, `pipeline`, `media`, `core` and `jobs` domains. No new folders except one E2E fake.

## Delivery order

1. **Gate G1:** done on 2026-10-22 (research R12). The long-file failure led to inline window clips.
2. **Model client + tracing**, with unit tests. Agents compile against the new `ModelRequest`.
3. **Analyst + ffmpeg `cutWindowClip` and `measureWindow`** (60 s windows).
4. **Pick, hook and brand on the new client.**
5. **Waits:** `model busy` and `model quota spent` through pipeline, brand, view, UI, driver tests.
6. **Config and deploy:** dependency, secret, env, Vertex removal, E2E fakes (model module, storage fixture).
7. **Docs:** PRD, AGENTS.md, README (the constitution is already at 2.0.0).
8. **Deployed manual checks**, then the one-time teardown.

## Complexity Tracking

No violations need justification.
