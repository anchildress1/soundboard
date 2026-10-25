---
description: 'Task list for the Gemini API swap'
---

# Tasks: Gemini API in place of self-hosted Gemma

**Input**: Design documents from `specs/002-gemini-api/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/model-client.md](contracts/model-client.md), [quickstart.md](quickstart.md)

**Tests**: Required. SC-004, SC-005 and SC-007 call for automated coverage, and AGENTS.md requires positive, negative, error and edge-case tests for every new module. Unit tests go in `tests/unit/` mirroring `src/`; E2E tests go in `tests/e2e/`. Mock only at process boundaries: Gemini HTTP via `fetch`, ffmpeg's process, GCS. The database runs as PGlite with real migrations, never mocked. Each task's tests are part of the task.

**Organization**: Tasks are grouped by user story. US1 and US2 are P1; US3 and US4 are P2.

**Gates**:

- **G2** (T001) blocks Phase 2 and everything after it. Phase 2 removes exports that today's callers import, so the code goes red as soon as it starts, and it isn't green again until the analyst G2 is meant to gate has been built.
- **FR-023** (T045) blocks every deployment, including hosted validation. Local work is not blocked.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task serves (US1–US4)
- 👤 Yours to run or approve. For repo config files, I draft the diff and you OK it before anything changes.

---

## Phase 1: Setup

**Purpose**: The G2 gate, the docs agents work from, and dependency and config changes.

- [x] T001 👤 Run gate G2 (research R14, FR-022):
  - **Videos:** 3–5 of Nathan's real uploads.
  - **Configurations:** A, B and C, using the exact R3 clip encoding profile.
  - **Scoring:** score each window against the Gemma baseline for genre terms, instruments, vocals and quality flags.
  - **Record:** the per-video, per-configuration table in specs/002-gemini-api/research.md R14, with tokens, latency and actual spend.
  - **If B or C wins:** before T002, update the analyst defaults (model, `mediaResolution`, `thinkingLevel`) and the analyst's minimum call budget (8 s), plus R5, R6 and the SC-006 math, in spec.md, plan.md, data-model.md, contracts/model-client.md and quickstart.md.
  - **If nothing passes:** stop and reopen the spec.
  - **Keep the Gemma endpoint** until the baseline is captured.
- [x] T002 Update docs/prd.md (FR-016) before any behavior code; the constitution treats code that disagrees with the PRD as a stop:
  - The provider and model lines (T001's analyst choice).
  - The "audio stays in the project" line and the third-party-inference non-goal.
  - System Design and cost.
  - Wait names and the model label.
- [x] T003 Update AGENTS.md (AI-only, directives only) before any code task, so agents don't follow Gemma rules:
  - Replace the Model architecture line with Gemini API via `src/lib/server/ai/model.ts`.
  - Replace the Gemma call settings (temperature 0.2, `max_tokens`, `reasoning_content`, 29.5 s windows) with the per-agent R5 settings and 60 s windows.
  - Replace "scaled to zero (429), loading" with `model busy` / `model quota spent`.
  - Replace `llama-server` in the mock list with Gemini HTTP.
  - In the E2E lines, add the window-media fake and replace the "waking model" stop with `model busy`.
- [x] T004 👤 Add exact pins to package.json and pnpm-lock.yaml: `pnpm add ai@7.0.153 @ai-sdk/google@4.0.105` (research R2)
- [x] T005 [P] 👤 Config in .env.example and service.yaml:
  - Remove `MODEL_URL`.
  - Add `GEMINI_API_KEY`, from Secret Manager `soundboard-gemini-api-key` in service.yaml.
  - Add `GEMINI_ANALYST_MODEL` (default `gemini-3.8-flash`, or T001's choice) and `GEMINI_PICK_MODEL` (default `gemini-4-argon`).
- [x] T006 [P] 👤 In vite.config.ts, extend the `E2E_FAKES=1` `resolveId` redirect (today only `src/lib/server/core/db.ts`) so `src/lib/server/media/window.ts` resolves to `tests/e2e/fakes/window.ts`. The `#lib` alias rewrites specifiers first, so match the resolved file the same way the db plugin does.
- [x] T007 [P] 👤 In playwright.config.ts:
  - Delete the `node tests/e2e/fakes/model.ts` webServer on port 4174 and the `MODEL_URL` env.
  - Add `--import ./tests/e2e/fakes/gemini.ts` to the preview server's Node command.
  - Set a dummy `GEMINI_API_KEY`, never a real one.
- [x] T008 [P] 👤 Remove the `model-image` target and its `.PHONY` entry from Makefile, and remove the `keep-model-2` rule from cleanup-policy.json.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The new client, request types, waits and tracing that every agent compiles against.

**Blocked by**: T001.

**⚠️ Red tree**: T010 and T012 remove `ModelWaking`, `modelStatus` and the old waits, which `pipeline.ts` and `brand.ts` still import. Those modules and their tests stay red until T021, T025 and T031. Full `make ai-checks` passes only at the end of US3.

- [x] T009 [P] In src/lib/server/core/env.ts:
  - Drop `modelUrl`.
  - Add `geminiApiKey()` (required), `analystModel()` (default `gemini-3.8-flash`) and `pickModel()` (default `gemini-4-argon`).
  - Tests in tests/unit/lib/server/core/env.test.ts: defaults, overrides, missing key throws.
- [x] T010 [P] In src/lib/types.ts:
  - In `Wait`, remove `waking model` and `waiting on another run`; add `model busy` and `model quota spent`.
  - Add `model: string` to `JobView`.
- [x] T011 Rewrite the model request types and spans in src/lib/server/core/tracing.ts:
  - Replace `ChatMessage[]` with the data-model types. `Part` is `text | image {data: base64, mime_type} | video {data: Uint8Array, mime_type, start, end}`. Add `Turn {role: 'user' | 'assistant', parts}` and `ModelRequest {system, turns}`.
  - Provider: `gen_ai.provider.name = 'gcp.gemini'`.
  - Per-call model on both `chatSpan` and `invokeAgent`; drop `MODEL_NAME`.
  - Redaction:
    - `image` → `{type, mime, bytes}`; `video` → `{type, mime, bytes, clip: '<start>s–<end>s'}`; never `data`.
    - System, user and assistant text, replies and reasoning are kept for every agent. No `recordText` switch.
    - Captured exceptions exclude SDK request bodies, headers and media-bearing causes. Safe messages still pass `scrubUrl`.
  - Telemetry never replaces or mutates the thrown error.
  - Tests in tests/unit/lib/server/core/tracing.test.ts and tests/helpers/agent-span.ts.
- [x] T012 Rewrite src/lib/server/ai/model.ts to [contracts/model-client.md](contracts/model-client.md):
  - **Exports:** `Agent`, `ModelBusy`, `ModelQuotaSpent` (with `until`), `chat`, `chatJson`, `stepDeadline`, `modelFor`.
  - **Client:** `createGoogle({ apiKey })`. Every call goes through `gemini.interactions(modelFor(agent))`.
  - **Call settings:**
    - `instructions` for the system prompt.
    - `Output.object({ schema: jsonSchema(schema) })`.
    - `maxRetries: 0`.
    - `telemetry: { isEnabled: false }`.
    - `providerOptions.google`: `{ store: false, thinkingLevel }`, plus `mediaResolution: 'low'` for `chunk-analyst` only.
  - **Per-agent settings** (R5 table): thinking level and `maxOutputTokens` 2048 / 8192. No temperature.
  - **Video parts:** inline `{ type: 'file', mediaType: 'video/mp4', data }`, never a URL.
  - **Timeout:** `min(CALL_TIMEOUT_MS = 90_000, deadline - now)`. Throw before calling at ≤ 0.
  - **Errors:**
    - 429 with a `PerDay` `QuotaFailure` → `ModelQuotaSpent`, until next midnight Pacific. Check `data.error.details`, else `responseBody`.
    - Any other 429, or 503 → `ModelBusy`.
    - Everything else → hard failure.
  - **Parse failures:**
    - `NoObjectGeneratedError` (raw = `error.text`), `NoOutputGeneratedError`, empty text and a non-`stop` finish all mean unparsed: one re-ask, sent as an `assistant` turn plus a user follow-up.
    - The re-ask runs only when the time left is at least the agent's minimum budget (analyst 8 s, smart pick and brand 33 s, hook 35 s). Otherwise return `{ value: null, raw, ms }`.
    - Record each failed attempt's raw text, finish reason and usage on the span.
  - **Remove** `modelStatus`, `ModelStatus`, `ModelWaking`, `SchemaName`, `TEMPERATURE` and `MAX_TOKENS`.
  - **Tests** in tests/unit/lib/server/ai/model.test.ts: every Unit bullet in quickstart.md that names the client.
- [x] T013 [P] Create tests/e2e/fakes/gemini.ts:
  - A Node preload that wraps `globalThis.fetch`. It returns a 429 `RESOURCE_EXHAUSTED` fixture for `generativelanguage.googleapis.com` and throws on any other Gemini request it doesn't handle.
  - Delete tests/e2e/fakes/model.ts.
- [x] T014 Update tests/helpers/pipeline.ts: replace the `llama-server` `fetch` stubs with Gemini Interactions HTTP fixtures (success, unparsed, 429 busy, 429 per-day, 503, 400). Every pipeline, short and brand test uses them.
- [x] T015 [P] Add a claim-guarded chunk reset to `releaseJob` in src/lib/server/jobs/jobs.ts:
  - The new operation sets `jobs.chunks` to empty in the same transaction as the state patch.
  - It applies only when the claim token and the claimed state still match. An ordinary `JobPatch` still can't clear `chunks`.
  - Tests in tests/unit/lib/server/jobs/jobs.test.ts: a matching claim clears both chunks and state; a stolen claim or a concurrent discard changes neither; a transaction failure rolls both back.

**Checkpoint**: T009–T015 pass their own unit tests.

---

## Phase 3: User Story 1 - A job reaches review with no GPU running (Priority: P1) 🎯 MVP

**Goal**: Prep, one 60 s inline clip per analyze step, and the pick, all on Gemini, ending at review with today's outputs.

**Independent Test**: Unit and E2E: analyze reaches the model call through the faked window module, and the pipeline tests drive a job to review on HTTP fixtures. After FR-023, run a 3-minute and a 15-minute video on the deployed app, with no Vertex call anywhere in the request path.

- [x] T016 [US1] In src/lib/server/media/ffmpeg.ts:
  - Set `WINDOW_SEC = 60`.
  - Delete `FRAMES_PER_WINDOW`, `extractWindow`, `splitJpegs` and the `Window` type.
  - Keep `chunkCount` as `max(1, ceil((duration − 1) / 60))`.
  - Tests in tests/unit/lib/server/media/ffmpeg.test.ts: 60 → 1, 60.5 → 1, 61.5 → 2, 900 → 15.
- [x] T017 [US1] Create src/lib/server/media/window.ts:
  - **`cutWindowClip(url, startSec, endSec, deadline)`:**
    - Reads the GCS source by signed URL, keeping the `https,tls,tcp` protocol whitelist.
    - Encodes H.264/AAC MP4: within 640×360, aspect ratio and rotation kept, even dimensions, at most 30 fps, video maxrate 600 kbit/s with a 1200 kbit buffer, AAC 96 kbit/s stereo at 48 kHz, faststart.
    - Writes a unique temp file in `os.tmpdir()`.
    - Caps at 45 s, clipped to the remaining budget. Never truncates output or shortens the window.
    - `stat` must show at most 8,000,000 bytes before the file is read; otherwise throw.
  - **`measureWindow(url, startSec, endSec, deadline)`:** today's window measurements, capped at 20 s.
  - **On abort:** wait for ffmpeg to exit before deleting the file.
  - **Tests** in tests/unit/lib/server/media/window.test.ts, ffmpeg mocked at the process:
    - Exactly 8,000,000 bytes is accepted; 8,000,001 is rejected before the read.
    - A timeout kills ffmpeg and deletes the file.
    - Incomplete output fails.
    - The encode args match the profile.
- [x] T018 [P] [US1] Create tests/e2e/fakes/window.ts: `cutWindowClip` writes a few dummy bytes to a temp file; `measureWindow` returns fixed `Measurements`. Same exports as window.ts.
- [x] T019 [US1] Rewrite src/lib/server/ai/chunk-analyst.ts:
  - Build a `ModelRequest` with one inline `video/mp4` part (the clip, with `start`/`end`), plus the window's ffmpeg measurements, song title and notes.
  - No image or audio parts.
  - After the re-ask is exhausted, store `numerics.ts`-stripped raw text on the chunk.
  - Tests in tests/unit/lib/server/ai/chunk-analyst.test.ts.
- [x] T020 [P] [US1] Rewrite src/lib/server/ai/smart-pick.ts:
  - Build a `ModelRequest` from #20's `candidateLists`, with thumbnails as `image` parts and the re-ask as an `assistant` turn.
  - Take the caller's `deadline` and pass it to `chatJson`; never start a fresh one.
  - A null value after exhaustion fails the step.
  - Keep the R4 candidate-only rule and `ARTIST_VOICE` unchanged.
  - Tests in tests/unit/lib/server/ai/smart-pick.test.ts.
- [x] T021 [US1] Rework analyze and pick in src/lib/server/pipeline/pipeline.ts:
  - **Deadline:** analyze and pick each start one 110 s `stepDeadline()` on claimed-step entry, with the last 5 s reserved for cleanup and persistence. The pick's re-ask shares it.
  - **Order:** compatibility check → `limited()` → `cutWindowClip` → `measureWindow` → `chatJson`.
  - **Cleanup:** delete the temp file in `finally`. Never save a partial chunk.
  - **Compatibility reset:** a stored `chunkCount` ≠ `chunkCount(sourceDurationSec)` calls T015's reset. That means `PREP`, `chunkIndex: 0`, cleared error and failure fields, and empty chunks, with no ffmpeg or provider call.
  - **Removed:** the `modelWait`/`NEEDS_MODEL` pre-flight.
  - **Tests** in tests/unit/lib/server/pipeline/pipeline.test.ts:
    - The order above.
    - Deletion when the call throws.
    - Reset under a matching vs. a stolen claim.
    - One simulated clock covers cut, measure and inference, and no helper renews the deadline.
- [x] T022 [US1] In src/lib/server/jobs/view.ts, set `JobView.model` from current config:
  - Analyst during `PREP`/`ANALYZE`, picker otherwise and for Shorts.
  - For `FAILED`, pick the role from `failedState`.
  - Tests in tests/unit/lib/server/jobs/view.test.ts, including a config change while viewing an old result.
- [x] T023 [P] [US1] Render the model label in src/lib/components/Track.svelte and src/routes/jobs/[id]/+page.svelte:
  - Show `Configured analyst: <model>` or `Configured picker: <model>`, separate from `Total model time: <seconds>s`.
  - Remove stale Gemma comments and copy.
  - Tests in tests/unit/lib/components/Track.test.ts and tests/unit/routes/jobs/[id]/page.test.ts.
- [x] T024 [US1] Add an E2E analyze spec in tests/e2e/pipeline.spec.ts: a seeded prepared job runs analyze through the faked window module to the model call. Give it its own job IDs per Playwright project in tests/e2e/fakes/fixtures.ts.

**Checkpoint**: A job goes from prep to review on HTTP fixtures; E2E reaches the model call.

---

## Phase 4: User Story 2 - The model provider is busy or rate-limited (Priority: P1)

**Goal**: 429/503 return `model busy` immediately. A per-day quota returns `model quota spent` until the reset. Neither counts as a failure.

**Independent Test**: Force each response at the `fetch` boundary during analyze and during pick. The step returns the wait, finished chunks remain, `consecutiveFailures` doesn't change, and the job continues once the fixture answers.

- [x] T025 [US2] Map the waits in src/lib/server/pipeline/pipeline.ts:
  - `ModelBusy` → `model busy`. Keep finished work and leave `consecutiveFailures` alone.
  - `ModelQuotaSpent` → set `limitUntil = until` and return `model quota spent`.
  - Apply the job cooldown before analyze, pick and hook side effects. Clear an expired model limit when work resumes.
  - 400, 403 and 500 count toward the existing two-strike `FAILED` path.
  - Tests in tests/unit/lib/server/pipeline/pipeline.test.ts.
- [x] T026 [P] [US2] Add plain-label text for `model busy` and `model quota spent` in src/lib/status.ts and remove the old waits. Tests in tests/unit/lib/status.test.ts.
- [x] T027 [P] [US2] Make src/lib/driver.ts keep calling on `model busy` and `model quota spent`. Tests in tests/unit/lib/driver.test.ts.
- [x] T028 [P] [US2] Update the wait responses in tests/unit/routes/api/jobs/[id]/step/server.test.ts.
- [x] T029 [US2] In tests/e2e/pipeline.spec.ts (and tests/e2e/short.spec.ts for the hook), check that analyze and pick show `model busy` from the T013 preload on desktop Chrome and Pixel 7, and that no `waking model` text remains.

**Checkpoint**: SC-005 holds: no forced rate limit fails a job.

---

## Phase 5: User Story 3 - Shorts and the brand guide run on the new models (Priority: P2)

**Goal**: Hook pick and brand propose on `gemini-4-argon` with today's outputs.

**Independent Test**: Make a Short from a reviewed job and propose a brand guide as the artist-linked user, on HTTP fixtures. Re-pick avoids skipped hooks.

- [x] T030 [US3] Rework the hook step in src/lib/server/pipeline/short.ts:
  - **Deadline:** one 110 s `stepDeadline()` on claimed-step entry. Loudness, the hook pick with its re-ask, and the existing render reserves all fit inside it; nothing renews it.
  - Build the `ModelRequest` with the re-ask as an `assistant` turn.
  - New Shorts and every `HOOK` retry or re-pick compare the parent's stored chunk count with `chunkCount(sourceDurationSec)`, not the Short job's default count. A mismatch takes "new upload required" before the hook pick.
  - An existing absolute cut may still render, re-cut, review and publish.
  - A null value after exhaustion fails the step.
  - Tests in tests/unit/lib/server/pipeline/short.test.ts.
- [x] T031 [P] [US3] Rework src/lib/server/artist/brand.ts:
  - Build a `ModelRequest` with thumbnails as `image` parts.
  - `ModelBusy` → `{ wait: 'model busy' }`; `ModelQuotaSpent` → `{ wait: 'model quota spent' }`; nothing persisted.
  - Exhaustion returns the existing retryable error. Remove `modelStatus`.
  - Tests in tests/unit/lib/server/artist/brand.test.ts.
- [x] T032 [US3] In src/routes/api/brand/propose/+server.ts and src/routes/brand/+page.svelte:
  - Pass both waits through.
  - The page keeps polling on `model busy` and stops on `model quota spent`.
  - Remove the waking-model copy.
  - Tests in tests/unit/routes/api/brand/propose/server.test.ts and tests/unit/routes/brand/page.test.ts.
- [x] T033 [P] [US3] In src/lib/components/Short.svelte, show `Configured picker: <model>` and the new wait text, and drop the Gemma copy. Tests in tests/unit/lib/components/Short.test.ts.
- [x] T034 [US3] Update tests/e2e/brand.spec.ts for `model busy` via the preload. Add a Short from a job with a mismatched chunk count to tests/e2e/short.spec.ts: it shows "new upload required".

**Checkpoint**: Shorts and the brand guide work on fixtures; old-window Shorts are refused. `make ai-checks` passes.

---

## Phase 6: User Story 4 - Nothing of the GPU deployment remains (Priority: P2)

**Goal**: Deploys create no model endpoint or image. Teardown deletes the old ones.

**Independent Test**: `deploy.sh` has no model-endpoint step. The removal sweep is empty. After FR-023 and teardown, the Vertex endpoint and model lists show nothing for Soundboard.

- [x] T035 [US4] 👤 Delete model/ (including model/Dockerfile) and build-model.sh.
- [x] T036 [US4] 👤 In deploy.sh:
  - Remove the model image build, the endpoint create/deploy, the `aiplatform` invoke role binding and `MODEL_URL`.
  - Sync `GEMINI_API_KEY` from `.env` to Secret Manager `soundboard-gemini-api-key` like the other app secrets, never echoing it.
- [x] T037 [US4] Run the removal sweep: `grep -rn "llama\|gemma\|MODEL_URL\|waking model\|another run\|vertex" src tests deploy.sh service.yaml .env.example` must return nothing. Fix what remains, including the meta description in src/routes/+layout.svelte ("self-hosted Gemma 4").

**Checkpoint**: The repo carries no GPU path.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: The rest of the FR-016/FR-018 docs, final validation and the gates before and after deploy.

**No standalone deploy**: 002 ships in the next combined release, after Google approves the request (FR-023). Building continues meanwhile; T045 and T046 run at that release and block nothing here. The GPU version is never redeployed, so T047 doesn't wait on either.

- [x] T038 [P] Update src/routes/privacy/+page.svelte (FR-018):
  - Name paid-tier Gemini as the processor of video clips and YouTube metadata, and Sentry as the processor of text traces.
  - Explain that `store: false` turns off interaction storage only, that implicit caching happens, and that abuse logs are kept up to 55 days.
  - Say that authorized Google staff may review flagged prompts, that a deletion request can't reach Google's abuse-monitoring copy, and what Sentry's actual retention is.
  - Say content is not used to improve Google products.
  - No zero-retention claim, no cache expiry.
  - Tests in tests/unit/routes/privacy.test.ts.
- [x] T039 [P] Update README.md for the same FR-016 lines as T002.
- [x] T040 [P] Update docs/youtube-audit/architecture.md and docs/youtube-audit/user-flows.md:
  - Show Gemini in the diagram and data flow.
  - Cover implicit caching, the 55-day abuse log, full-text Sentry retention and the approval gate.
  - Drop the "planned spec 002" section.
  - Validate every Mermaid diagram with mcp-mermaid.
- [x] T041 Confirm .specify/memory/constitution.md already carries the 2.0.0 III/IV/V amendments the plan lists; change nothing if it does.
- [ ] T042 Run `make ai-checks`: format, lint, typecheck, unit coverage floors at 85/85/85/80, build. Zero warnings.
- [ ] T043 Run `make e2e` on desktop Chrome and Pixel 7, then the Semgrep and Sonar scans.
- [ ] T044 Walk every Automated bullet in specs/002-gemini-api/quickstart.md and confirm a test covers it.
- [ ] T045 👤 FR-023 gate:
  - Record YouTube's approval reference, date and scope.
  - Record the actual Sentry plan, billing model and retention for errors, full spans and sampled spans.
  - Confirm the Gemini project bills on the paid tier, not the free tier (FR-002).
  - Record any restrictions.
  - Put it all under "Manual: deployment gate" in specs/002-gemini-api/quickstart.md (SC-010).
  - No deploy before this. A narrower or contrary approval reopens the spec.
- [ ] T046 👤 At the combined release, after T045, run quickstart "Manual: deployed" steps 1–5:
  - Deploy.
  - The 3- and 15-minute runs, including the first and last windows of a 2 GB source.
  - The pick checks, a Short and a brand guide, and `/privacy`.
  - Sentry text with no media.
  - Read the 15-minute job's actual Gemini cost from billing and confirm it's under SC-006's $0.50.
- [ ] T047 👤 Any time, run the one-time GPU teardown in quickstart step 6. Then confirm the endpoint and model lists are empty and GPU spend is $0 the next full week (SC-001).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 first. T002 and T003 follow T001. T004–T008 can start any time.
- **Foundational (Phase 2)**: needs T001–T005. It blocks every story and leaves the tree red (see Phase 2).
- **US1 (Phase 3)**: needs Phase 2.
- **US2 (Phase 4)**: needs US1. T025 edits the same pipeline.ts code as T021.
- **US3 (Phase 5)**: needs Phase 2. The tree is green only after US1, US2 and US3 are all done.
- **US4 (Phase 6)**: T035 and T036 need only Phase 1. T037 runs after US3.
- **Polish (Phase 7)**: T038–T041 can start any time after Phase 2. T042–T044 need all stories. T045 → T046 at the combined release. T047 any time.

### Within Phases

- T011 → T012 → T014 (helpers use the client and span shapes).
- T015 and T016 → T021.
- T006 → T018 → T024. T007 and T013 → T024, T029 and T034.
- T017 → T019 → T021.

### Parallel Opportunities

- Phase 1: T002 and T003 together after T001; T005–T008 together, any time.
- Phase 2: T009, T010, T013 and T015 together; T011 → T012 → T014 alongside.
- US1: T018 and T020 alongside T017/T019. T023 once T022 lands.
- US2: T026, T027 and T028 together.
- US3: T031 and T033 alongside T030.
- Polish: T038–T041 together.

---

## Parallel Example: Phase 2

```bash
Task: "env.ts gemini settings + tests (T009)"
Task: "types.ts waits and JobView.model (T010)"
Task: "tests/e2e/fakes/gemini.ts preload (T013)"
Task: "releaseJob chunk reset + tests (T015)"
```

---

## Implementation Strategy

### MVP (US1 + US2)

1. G2 (T001), then the PRD and AGENTS.md (T002, T003) and config.
2. Phase 2. Only its own unit tests pass here.
3. US1, then US2. Both are P1: without the busy wait, any provider blip fails a job.
4. US3, so the tree is green again and `make ai-checks` passes.
5. **Stop and validate** locally on fixtures. No deploy; FR-023 still applies.

### Incremental

1. US4 (removal).
2. Polish docs and validation.
3. At the combined release: T045 approval → T046 deployed checks. T047 teardown any time.

---

## Notes

- Commit after each task or logical group, on `002-gemini-api`. Commits made while the tree is red pass the hooks (format, lint, secret scan) but not `make ai-checks`.
- G2 can change analyst defaults; T001 updates the docs before T002 writes them into the PRD.
- Never write Nathan's surname in fixtures, prompts, tests or docs.
