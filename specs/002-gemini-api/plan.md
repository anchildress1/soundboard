# Implementation Plan: Gemini API in place of self-hosted Gemma

**Branch**: `002-gemini-api` | **Date**: 2026-10-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-gemini-api/spec.md`

## Summary

Replace `llama-server` + Gemma 4 on the Vertex L4 endpoint with the Gemini API through the AI SDK (`ai` + `@ai-sdk/google`, Interactions), so later agent work and model swaps reuse one client.

- **Analyst:** `gemini-3.8-flash` watches and hears one 60 s window per analyze step. ffmpeg cuts the window from the GCS source into a small 360p clip (temp file, at most 8 MB before serialization), and it's sent inline. No frames and no WAV. Gate G1 showed registering the full upload is far too slow (research R3, R12).
- **Picks:** smart pick, hook pick and brand guide run on `gemini-4-argon`.
- **Waits:** provider 429/503 become the `model busy` wait. A spent daily quota becomes `model quota spent` until the reset. The scale-to-zero waits and readiness checks are deleted.
- **Removed:** the Vertex endpoint, the model image, `MODEL_URL`, and their deploy steps.
- **Unchanged:** ffmpeg keeps every number. Every R4 output rule and schema stays the same. Windows become 60 s (was 29.5 s), and the Short hook follows `WINDOW_SEC`.

## Technical Context

**Language/Version**: TypeScript 6 strict, Node 24 (`.nvmrc`)

**Primary Dependencies**:

- New: `ai` 7.0.153 and `@ai-sdk/google` 4.0.105 for every model call (research R2)
- Existing, kept: SvelteKit 2 / Svelte 5, `google-auth-library` 11.1.0 (sign-in only), `@sentry/sveltekit` 11.4.0, `p-retry` 8.0.1 (parse re-ask only)
- Removed from runtime: the model container (`model/Dockerfile`, `build-model.sh`)

**Storage**: Neon Postgres, unchanged; no migration. GCS bucket unchanged; Gemini never reads it.

**Testing**: Vitest 5 + coverage floors 85/85/85/80. Provider mocked at `fetch`; ffmpeg mocked at its process boundary. Playwright (desktop Chrome, Pixel 7) with the real SDK/client, a test-only Gemini HTTP preload, and a faked window-media module (no ffmpeg in E2E) (research R11).

**Target Platform**: Cloud Run, one service, max 1 instance, us-central1. No GPU anywhere.

**Project Type**: Web application, SvelteKit single project

**Performance Goals**:

- Measured in G1: analyst ≈ 6–8 s per 60 s inline clip; Argon pick p95 32.8 s and hook p95 34.6 s (≤ 45 s).
- Every step under about 2 minutes.
- Warm 30 s video ≤ 2 min to recommendation.

**Constraints**:

- Paid tier only; `store: false`.
- Only one window's small clip passes through the app per call, never the whole video.
- No busy/quota retries inside a step; parse re-asks share its deadline.
- No credentials, signed-URL credential queries or media bytes in Sentry; text diagnostics remain.
- Full text traces and provider implicit caching/abuse logs are accepted storage risks (FR-017–FR-019). No deployment until the YouTube request covering the disclosed processing and storage is approved (FR-023).

**Scale/Scope**:

- 2 users.
- A 15-minute job is 15 analyst calls plus one pick, about $0.25 typical at post-increase prices. The worst case is about $1.60 with every re-ask (research R6).

## Constitution Check

Gates from `.specify/memory/constitution.md` v2.0.1 (last amended 2026-10-23).

| Principle                     | Status             | Notes                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data                 | ✅                 | The clip is cut from a job already loaded through `authorizedJob` / the claimed step. No new cache or credential crosses users. The API key is app-wide, like the YouTube search key.                                                                                                     |
| II. Truthful Output           | ✅                 | Numerics stripping, candidate-only tags, server-built flags and read-back verify are untouched.                                                                                                                                                                                           |
| III. One Service, Page-Driven | ✅ amended         | No new service, queue or worker. "One model endpoint" becomes "one model provider". Waits stay immediate (`model busy`, `model quota spent`). A provider 401/403 is a failure, not a wait, so "unauthorized" must mean user grants only.                                                  |
| IV. Domain-Grouped            | ✅ amended         | The client stays in `src/lib/server/ai/model.ts`. IV says every external platform lives in `platforms/<name>/`, with no publishing-only carve-out, so the model provider needs an explicit exemption.                                                                                     |
| V. Tested at the Boundaries   | ✅                 | Real SDK/client in unit and E2E runs; fake Gemini only at HTTP. E2E fakes window media like db, KMS and Storage; no ffmpeg in E2E. G1 is recorded; G2 remains a prerequisite for analyst implementation.                                                                                  |
| VI. Simplicity                | ✅                 | Net deletion: model image, Vertex deploy, readiness checks, ffmpeg frame/WAV extraction. One clip cutter replaces them. No compat path.                                                                                                                                                   |
| Media, Privacy, Secrets       | ✅                 | A window clip (a few MB) replaces today's in-memory WAV and frames; the whole video is never buffered. The temp file is deleted in `finally`. The API key lives in Secret Manager. Sentry redacts video to a placeholder.                                                                 |
| Platform Terms                | Deployment blocked | Full text traces, implicit caching and abuse-log retention are disclosed and accepted by the owner, not presumed approved by YouTube. FR-023 requires the approval reference/scope and actual Sentry retention before any deployment. Existing database retention rules remain unchanged. |
| Workflow                      | Scoped             | Existing dependency/deploy/test configuration approvals remain. The 2026-10-24 review adds only Playwright/Vite/Makefile wiring for the E2E fakes; no Dockerfile or CI change. This design pass changes spec artifacts only; no deployment or teardown is authorized.                     |

**Amendment:** done in constitution 2.0.0 (2026-10-22). It covers:

- III: "One Cloud Run service and one model provider." "Unauthorized" in the wait rule means a user's missing or revoked grant; an app credential the provider rejects is a failure.
- IV: the model provider is exempt from `platforms/`, and its calls, scopes and error mapping live only in `src/lib/server/ai/model.ts`.
- V: replace `llama-server` with "the model provider's HTTP API".

**Post-design re-check:** design gaps below are resolved; G2 passed on 2026-10-24; FR-023 still gates every deployment. Owner risk acceptance is not marked as platform approval.

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
├── smart-pick.ts       # ModelRequest built on #20's candidateLists; thumbnails as image parts
├── numerics.ts, shape.ts   # unchanged
src/lib/server/artist/brand.ts      # ModelRequest; ModelBusy → 'model busy'; ModelQuotaSpent → 'model quota spent'; no modelStatus
src/routes/brand/+page.svelte, src/routes/api/brand/propose/+server.ts   # new waits; stop polling on 'model quota spent'; no waking-model copy
src/lib/server/pipeline/
├── pipeline.ts         # shared deadline and claim-atomic chunk reset; drop modelWait/NEEDS_MODEL pre-flight; ModelBusy → 'model busy'; ModelQuotaSpent → limitUntil + 'model quota spent'; analyze order limited() → cutWindowClip → measureWindow; a stored chunkCount ≠ chunkCount(duration) clears chunks and returns the job to PREP
└── short.ts            # hook-pick via ModelRequest; parent window check on every HOOK, existing absolute cuts remain usable
src/lib/server/pipeline/hashtags.ts # existing diagnostic result and #20 evidence storage/candidateLists unchanged
src/lib/server/media/ffmpeg.ts      # WINDOW_SEC 60; chunkCount keeps its sub-second tail skip; drop extractWindow/FRAMES_PER_WINDOW
src/lib/server/media/window.ts      # new: bounded cutWindowClip + measureWindow sharing the step deadline (own module so E2E can swap it)
src/lib/server/core/
├── env.ts              # drop modelUrl; add geminiApiKey, analystModel, pickModel
└── tracing.ts          # Part/ModelRequest, provider gcp.gemini, per-call model on chatSpan and invokeAgent (no MODEL_NAME), media/secret redaction, full text for every agent; telemetry never replaces thrown errors
src/routes/privacy/+page.svelte     # Gemini API as processor (FR-018)
src/lib/server/jobs/view.ts         # configured-model label, not historical provenance
src/lib/server/jobs/jobs.ts        # releaseJob clears actual jobs.chunks atomically with reset under matching claim/state
src/lib/types.ts                    # Wait: 'model busy', 'model quota spent'; JobView.model
src/lib/status.ts (text for both new waits), src/lib/components/Short.svelte, src/lib/components/Track.svelte, src/routes/jobs/[id]/+page.svelte  # configured role/model label from view.model, separate total time; new wait texts; drop stale model comments
src/routes/+layout.svelte           # meta description drops "self-hosted Gemma 4"
tests/unit/… mirrors the above; tests/helpers/pipeline.ts updated for the new client
tests/e2e/fakes/gemini.ts          # Node preload intercepts provider HTTP; real model.ts/SDK run; dummy key only
tests/e2e/fakes/window.ts         # fake cutWindowClip/measureWindow: dummy temp file, fixed measurements
tests/e2e/…                      # busy/quota waits, desktop Chrome and Pixel 7
playwright.config.ts, vite.config.ts, Makefile # preload on the preview command; resolveId also redirects media/window.ts; drop the model fake server
deploy.sh, service.yaml, .env.example # credential/model config; drop model endpoint deployment
cleanup-policy.json              # remove obsolete model-image retention rule
model/, build-model.sh             # deleted
docs/prd.md, README.md, AGENTS.md, src/routes/privacy/+page.svelte, .specify/memory/constitution.md   # FR-016, FR-018
docs/youtube-audit/architecture.md, docs/youtube-audit/user-flows.md   # FR-016: Gemini in the diagrams and data flow, implicit cache, 55-day abuse log, full-text Sentry retention and approval gate; drop the "planned spec 002" section
```

**Structure Decision**: Single SvelteKit project. The change stays inside the existing `ai`, `pipeline`, `media`, `core` and `jobs` domains. No new application domains or database schema; test-only fakes stay under `tests/e2e/fakes/`.

## Delivery order

1. **Gate G1:** done on 2026-10-22 (research R12). The long-file failure led to inline window clips.
2. **Gate G2: analyst quality on real music:** passed on 2026-10-24 with configuration A (research R14). The analyst defaults are unchanged.
3. **Model client + tracing**, with unit tests. Agents compile against the new `ModelRequest`.
4. **Analyst + ffmpeg `cutWindowClip` and `measureWindow`** (60 s windows).
5. **G1 follow-up: re-time the pick at the full #20 prompt size**: done on 2026-10-23, p95 10.5 s (research R13).
6. **Pick, hook and brand on the new client**, with full-text diagnostics and unchanged media/secret redaction.
7. **Waits:** `model busy` and `model quota spent` through pipeline, brand, view, UI, driver tests.
8. **Config and deploy:** dependency, secret, env, Vertex removal, E2E fakes (Gemini preload, window media); prepare deployment changes without deploying.
9. **Docs:** PRD, AGENTS.md, README, the privacy page, the YouTube audit docs (the constitution is already at 2.0.0).
10. **Approval gate FR-023:** record YouTube approval reference/scope and the actual Sentry retention; no feature deployment before this, including hosted validation.
11. **At the combined release, after approval:** deployed manual checks. No standalone deploy of this feature. The one-time teardown runs any time; the GPU version is never redeployed.

## Complexity Tracking

The storage risk is accepted for design, with deployment blocked pending external approval; no runtime exception to platform terms is claimed. No extra service, queue, purge worker or compatibility layer is introduced.
