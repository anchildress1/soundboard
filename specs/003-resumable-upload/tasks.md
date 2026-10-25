---
description: 'Task list for the resumable video upload'
---

# Tasks: Resumable video upload

**Input**: Design documents from `specs/003-resumable-upload/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/upload-session.md](contracts/upload-session.md), [quickstart.md](quickstart.md)

**Tests**: Required. AGENTS.md and constitution V require positive, negative, error and edge-case tests for every new module, and the spec's success criteria call for automated coverage.

- Unit tests go in `tests/unit/`, mirroring `src/`. Import app code through `#lib/*` and `#src/*` with the `.js` extension, never relative paths into `src/`.
- Mock only at process boundaries: `@google-cloud/storage`, `fetch` for GCS session HTTP, `XMLHttpRequest`, `navigator.locks`, `crypto.subtle` only where jsdom lacks it. Never mock internal modules.
- The database is never mocked: `#lib/server/core/db.js` is PGlite with the real migrations (`tests/helpers/db.ts`). Seed rows through it.
- `@sentry/sveltekit` is the global mock in `tests/mocks/sentry.ts`. Assert through it.
- E2E goes in `tests/e2e/` and runs both projects, `chromium` (desktop Chrome) and `mobile` (Pixel 7, the primary path), against the in-repo fakes. Upload tests sign in as a dedicated user (`USER_UPLOAD`) and create every job through `/new`, so each test and project gets its own random job ID and no other spec's job list changes.
- Scope is research R12: test what can break, not GCS or browser APIs we only call.
- Each task's tests are part of the task. Coverage floors 85/85/85/80 hold after every task.

**Organization**: Tasks are grouped by user story. US1, US2 and US3 are P1; US4 is P3.

**Gates**:

- **FR-017** (T001) lands before any behavior code: code that disagrees with the PRD is a stop.
- G1 already ran (quickstart). No new gate blocks code.
- **No deploy.** The live check (T035) runs on the local dev server against the dev bucket.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task serves (US1–US4)
- 👤 Yours to run or approve. Repo config (`deploy.sh`, `playwright.config.ts`) is pre-approved in the plan's Constitution Check; list each change in the PR.

---

## Phase 1: Setup

**Purpose**: The docs agents work from, the approved config change, and the test seams every later task uses.

- [ ] T001 Update docs/prd.md (FR-017) before any behavior code:
  - **R1 · Upload:** replace "Browser PUTs straight to GCS via signed URL" and the `x-goog-content-length-range` line with: the browser uploads straight to GCS in a resumable session per job, created by the server with the declared size (≤ 2 GB, GCS refuses any other size) and only if the object doesn't exist; after a drop it asks GCS what was saved and sends the rest; moving around the app keeps it sending; after a reload or a closed tab the user picks the same video to continue, and a different video starts over. Keep the CORS and 7-day delete rule sentence, the unguessable job IDs and both checkboxes.
  - **UX, Working screens:** "leaving is safe once the browser upload is done" becomes "moving around the app is safe during the browser upload, and closing the tab is safe once it is done".
  - No other PRD line changes.
- [ ] T002 [P] Update AGENTS.md (AI-only, directives only):
  - In the E2E builds line, add that `tests/e2e/fakes/gcs-session.ts` runs as its own Playwright `webServer` on port 4174 and holds every resumable session's offset and landed objects.
  - Add under Media: "Browser video uploads: one GCS resumable session per job (`jobs.data.videoUpload`). The session URI is a bearer credential: NEVER log, trace, or return it outside `POST /api/jobs` and `POST /api/jobs/{id}/upload-session`."
- [ ] T003 [P] 👤 In deploy.sh, drop `"x-goog-content-length-range"` from the bucket CORS `responseHeader` list. Keep `GET`/`PUT`, the origins and `Content-Type`, `Content-Range`, `Accept-Ranges`, `Range` (research R3: the browser sends `Content-Range` and reads `Range`).
- [ ] T004 [P] Add `addBreadcrumb = vi.fn()` to tests/mocks/sentry.ts, so uploader breadcrumbs (FR-015) can be asserted.
- [ ] T005 [P] Add two synthetic E2E video fixtures, each under 1 MB, in tests/e2e/fixtures/: `clip-a.webm` and `clip-b.webm` (VP9 + Opus, so Playwright's Chromium plays them and the Monitor reads a duration; never Nathan's media). Generate with `ffmpeg -f lavfi -i testsrc2=size=320x240:rate=24 -f lavfi -i sine=frequency=440 -t 4 -c:v libvpx-vp9 -b:v 1500k -c:a libopus` (`clip-b` with `frequency=660` and `-vf hue=h=90`, so its bytes and fingerprint differ). Record the commands in a comment at the top of tests/e2e/upload.spec.ts (created in T018).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Server session calls, the stored session, create, the uploader core and the E2E fake. Every story needs them.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete. Removing `signedUploadUrl` and `uploadToGcs` turns callers red until T011–T014 land.

- [ ] T006 [P] In src/lib/server/media/gcs.ts (contract "Server ↔ GCS"):
  - Add `createUploadSession(object, { origin, contentType, size })`: `bucket().file(object).createResumableUpload({ origin, metadata: { contentType, contentLength: size }, preconditionOpts: { ifGenerationMatch: 0 } })`, returns the session URI.
  - Add `uploadOffset(sessionUri, size)`: `fetch` `PUT`, empty body, `Content-Range: bytes */<size>`. Returns `{ done: true }` on `200`/`201`, `{ done: false, saved: N+1 }` on `308` with `Range: bytes=0-N`, `{ done: false, saved: 0 }` on `308` without `Range`, and throws on anything else.
  - Add `cancelUploadSession(sessionUri)`: `fetch` `DELETE`. `404`, `410` and `499` count as done; any other failure is swallowed (research R10).
  - Both `fetch` calls carry `signal: AbortSignal.timeout(5000)`, so a slow GCS never holds a page load or a discard (constitution III).
  - Add `deleteObject(object)`: `bucket().file(object).delete({ ignoreNotFound: true })`.
  - Delete `signedUploadUrl`, `CONTENT_LENGTH_RANGE` and `UPLOAD_TTL_MS`.
  - Tests in tests/unit/lib/server/media/gcs.test.ts: the exact `createResumableUpload` options; every `uploadOffset` reply above plus a network throw and a timeout; cancel's done codes and a swallowed `500`; delete on a missing object; the removed exports' tests deleted. The session URI never appears in a thrown message.
- [ ] T007 [P] In src/lib/server/jobs/jobs.ts:
  - Add `videoUpload: { sessionUri: string; size: number; fingerprint: string } | null` to `JobDoc`, with the data-model comments ("a bearer credential for this object"; "declared to GCS, which rejects any other final size"; "hex SHA-256(size ‖ first 1 MiB ‖ last 1 MiB)"). `newJobDoc` sets it to `null`. `toPublic` does not copy it.
  - Add `swapVideoUpload(id, next, fields, prev?)`: one `UPDATE … RETURNING` on `jobs` that writes `videoUpload` plus `filename` and `contentType` through `jobSet`, `WHERE state = 'AWAITING_UPLOAD'`, and with `prev` also `AND data->'videoUpload'->>'sessionUri' = prev`. Returns whether a row matched. `prev` is never null in the condition (research R6).
  - Tests in tests/unit/lib/server/jobs/jobs.test.ts (PGlite): `newJobDoc` and Short docs carry `null`; `toPublic` output has no `videoUpload` key and no session URI anywhere in its JSON; unconditional swap wins over a stored session; conditional swap with a matching `prev` wins and with a stale `prev` changes nothing; no swap once the job left `AWAITING_UPLOAD`; a row with no `videoUpload` key reads as `undefined`/null and a conditional swap against it changes nothing.
- [ ] T008 In src/lib/server/jobs/create.ts (depends on T006, T007):
  - Add `fingerprint` to `CreateInput`; reject anything but 64 lowercase hex characters with `400 'Pick the video again.'` alongside today's checks.
  - Export the caps parser (today's `parseUpload` checks) so upload-session reuses the same messages.
  - Create the session with `createUploadSession(uploadObjectName(id), { origin, contentType, size })` before `createJob`, so a failure stores no job. `origin` is the request's `event.url.origin`, passed in from src/routes/api/jobs/+server.ts.
  - Store `videoUpload: { sessionUri, size, fingerprint }` on the new job. `Created` becomes `{ id, sessionUri }`.
  - Tests in tests/unit/lib/server/jobs/create.test.ts and tests/unit/routes/api/jobs/server.test.ts: a valid create stores `videoUpload` and returns the URI; bad fingerprint, over 2 GB, over 15 minutes and a non-video type each 400 with no session created and no job stored; a session-create failure stores no job; signed out 401.
- [ ] T009 [P] In src/lib/server/pipeline/pipeline.ts, `startOnceUploaded` moves to `PREP` with `videoUpload: null` in the same `transitionJob` patch. Test in tests/unit/lib/server/pipeline/pipeline.test.ts: a landed object clears `videoUpload`; an unlanded one leaves the job and its session as they were.
- [ ] T010 [P] Add src/lib/fingerprint.ts: `fingerprint(file: File): Promise<string>`, hex SHA-256 over the file size as 8 bytes big-endian, then the first 1 MiB, then the last 1 MiB (`File.slice`, `crypto.subtle.digest`). Tests in tests/unit/lib/fingerprint.test.ts: equal for the same bytes under a different name and `lastModified`; different for one changed byte inside the first or last MiB; different for a different size; the exact input bytes for a small and a 3 MiB file (compare against Node's `crypto.createHash`).
- [ ] T011 [P] In src/lib/retry.ts add `UPLOAD_BACKOFF = { minTimeout: 1000, factor: 2, maxTimeout: 60_000 }` (research R4) beside `POLL_BACKOFF`, with a one-line why. In src/lib/api.ts delete `uploadToGcs`, change `createJob`'s body to include `fingerprint` and its result to `{ id: string; sessionUri: string }`, and add `uploadSession(id, body)` → `POST /api/jobs/{id}/upload-session` returning `{ sessionUri: string; restarted: boolean }` and throwing `ApiError` with the 409 message. Tests in tests/unit/lib/api.test.ts (mock `fetch`): the request shape, a 200, a 409 message, a 404.
- [ ] T012 Add src/lib/upload.ts, the app-level uploader (research R2–R4, R9, R11; contract "Browser ↔ GCS"), depends on T010, T011:
  - A module-level Svelte store keyed by job ID: `{ file, sessionUri, size, saved, state }`, with `state` one of `sending`, `paused`, `away`, `other-tab`, `replaced`, `stopped`, `done` (data-model, verbatim), plus the pause `reason` (`offline`, `stall`, `408`, `429`, `5xx`). No object URL: each page makes and revokes its own. Nothing goes to browser storage.
  - `nextAction(reply)`: a pure function from an XHR result to the contract's row: `308` + `Range` below size → send from `N+1`; `308` + `Range` at `size-1` → finalize; `308` no `Range` → send from 0; `200`/`201` → done; status 0, `408`, `429`, `5xx` → pause; `404`, `410`, `412`, `499` → renew; other `4xx` → stop with the message.
  - The loop: status query before every attempt, then one `PUT` of `file.slice(offset)` with `Content-Range: bytes <offset>-<size-1>/<size>`. Never trust its own count over the status query. Live `upload.onprogress` while sending; after a pause `saved` resets to the confirmed offset.
  - Finalize (offset equals size): empty `PUT` with `Content-Range: bytes */<size>`, `UPLOAD_BACKOFF`, at most 5 tries, then pause. Never build `bytes <size>-<size-1>/<size>`.
  - Pause: backoff timer on `UPLOAD_BACKOFF`; `online` and `visibilitychange` to visible retry at once. Retries never stop while the app is open. A 60 s stall with no progress event aborts the `PUT` and pauses; the stall timer stops once `loaded === total`.
  - `start(jobId, { file, sessionUri, size })`, `stop(jobId)` (aborts the in-flight XHR, clears timers, releases the lock).
  - Sentry: `addBreadcrumb` `upload paused` and `upload resumed` with `{ saved, total, reason }` only. No session URI, no file name, no bytes (FR-015).
  - Tests in tests/unit/lib/upload.test.ts with a fake `XMLHttpRequest` and fake timers: every `nextAction` row; a drop at 40% resumes from the queried offset, not the local count (SC-002); 20 drops then finish with no call from the page (SC-001 logic); finalize with a lost reply finishes without resending bytes and gives up after 5 tries into pause; the stall timer pauses mid-send and stays off at 100%; backoff doubles to the 60 s cap; `online` cuts the wait; breadcrumb data has only `saved`, `total`, `reason`; `stop` aborts and no further request goes out.
- [ ] T013 Add the one-sender lock to src/lib/upload.ts (research R8, FR-012), depends on T012:
  - `start` takes `navigator.locks.request('upload:' + jobId, { ifAvailable: true }, …)`. Only the holder sends.
  - No lock: state `other-tab`, and a queued normal request with an `AbortSignal`; `stop` and leaving the page abort it. When granted, the store calls the page's `onTakeover` hook, which re-fetches the job view before showing anything.
  - The holder releases the lock on done, on a `409` stop, on `stop`, and when its tab closes (the lock callback's promise settles).
  - Tests in tests/unit/lib/upload.test.ts with a fake `navigator.locks`: the holder sends and the second store doesn't; the second takes over after release and calls `onTakeover`; an aborted queued request never sends.
- [ ] T014 In src/routes/new/+page.svelte (depends on T008, T010–T012):
  - Compute `fingerprint(file)` before `createJob`, while Start shows "Starting".
  - Hand `{ file, sessionUri, size }` to the upload store's `start` instead of `setPending`, then `goto` the job page. The page keeps revoking its own object URL on destroy.
  - Delete src/lib/pending.ts and tests/unit/lib/pending.test.ts.
  - Tests in tests/unit/routes/new/page.test.ts: create receives the fingerprint; the store holds the file and session after create; a create 400 shows its message and starts nothing.
- [ ] T015 [P] Status texts in src/lib/status.ts and src/lib/release.ts, exactly the contract's Page states table and working-screen copy (FR-010):
  - status.ts: `Uploading n%` (also held at the confirmed offset during a `429`/`5xx` backoff), `Upload paused: no connection` (reasons `offline`, `stall`, `408` only), "The upload paused while you were away.", `Upload paused at n%. Pick the video to continue.`, "Pick the video to continue.", "New video: starting the upload over.", "Uploading in another tab", "The saved upload expired; starting again.", "A different video replaced this upload.", "This job was discarded." `n` is `Math.floor(saved / total * 100)`, so 100% shows only when done.
  - release.ts `workCopy` for `AWAITING_UPLOAD`: body "Keep this tab open until the upload finishes. Other pages in the app are fine."
  - Tests in tests/unit/lib/status.test.ts and tests/unit/lib/release.test.ts: each text, `n` at 0, mid and just under total, and an unknown saved amount.
- [ ] T016 E2E fake GCS session server, depends on T006:
  - Add tests/e2e/fakes/gcs-session.ts: a Node `http` server on port 4174 with CORS for `http://localhost:4173` (allow `PUT`, `DELETE`, request headers `Content-Range`, `Content-Type`; expose `Range`). Per session: object, declared size, saved bytes, landed flag. It answers the contract's status query and `PUT` exactly (`308` with or without `Range`, `200` on the final byte, `400` on a size mismatch, `404` after `DELETE`, `412` when the object already landed). `POST /control/create` makes a session; `GET /control/object/<name>` reports landed; `POST /control/drop?session=…&after=N` makes the next `PUT` keep N bytes and then destroy the socket, so the browser sees status 0 after a partial save. `POST /control/throttle?session=…&bytesPerSec=N` slows reads of that session's `PUT` bodies, so a test can act mid-upload. `GET /control/session/<id>` reports saved and total bytes received.
  - In tests/e2e/fakes/storage.ts: `file(object).createResumableUpload()` calls `/control/create` and returns a URI on port 4174; `exists` and `getMetadata` report a landed object as present with its size and type, an object with an unfinished session as absent, and every other object as today (present unless the name has `expired`); `delete` removes a landed object.
  - 👤 In playwright.config.ts add a second `webServer`: `node tests/e2e/fakes/gcs-session.ts`, `port: 4174`, `reuseExistingServer: false`, with a one-line comment why it's its own process (the browser and the app server must reach the same session state).
  - In tests/e2e/fakes/fixtures.ts seed one more active, unlinked user `uid-upload` (no YouTube connection needed: nothing here approves), and export `USER_UPLOAD = 'uid-upload'` from tests/e2e/session.ts. No fixture jobs: each upload test creates its own through `/new`.

**Checkpoint**: Server and uploader core green under `make ai-checks`; `/new` creates a session and hands the file to the store.

---

## Phase 3: User Story 1 - A dropped connection doesn't restart the upload (Priority: P1) 🎯 MVP

**Goal**: Drops pause the upload; it resumes on its own from what storage saved and lands like an uninterrupted one.

**Independent Test**: Drop the connection several times mid-upload. It finishes with no tap, and the bytes received are close to the file size.

- [ ] T017 [US1] In src/routes/jobs/[id]/+page.svelte, replace `finishUpload`, `resumeAfterReload`, `takePending` and `uploadPct` with the upload store (depends on T012–T015):
  - While the store has this job: the status row shows `Uploading n%` while sending (and while backing off from `429`/`5xx`) and `Upload paused: no connection` with the saved amount for an `offline`, `stall` or `408` pause, never an error toast.
  - On `done`: the same short step poll as today (`POLL_BACKOFF`, 4 retries until the job leaves `AWAITING_UPLOAD`), then `run()`.
  - A stop with an other-`4xx` message shows it; the job stays `AWAITING_UPLOAD`.
  - Tests in tests/unit/routes/jobs/[id]/page.test.ts: sending, each pause reason and done render the contract texts; done drives the step loop; a stop message renders.
- [ ] T018 [P] [US1] E2E in tests/e2e/upload.spec.ts (both projects): pick `clip-a.webm` on `/new`, start; arm `/control/drop` three times at increasing offsets; the page shows `Upload paused: no connection` at least once; with no click the job leaves `AWAITING_UPLOAD` (`GET /api/jobs/<id>` via `page.request`, state is `PREP` or later; E2E has no ffmpeg, so `FAILED` at `PREP` also counts); the fake reports total bytes received under 2× the file size.
- [ ] T019 [P] [US1] E2E in tests/e2e/upload.spec.ts: `page.route` aborts the session `PUT` five times with `failed` (status 0), then lets it through; the upload finishes with no click.

**Checkpoint**: US1 works alone: an upload survives drops.

---

## Phase 4: User Story 2 - Moving around doesn't stop the upload (Priority: P1)

**Goal**: The upload keeps sending across in-app navigation; a hidden tab that stopped sending says so on return and continues.

**Independent Test**: Start an upload, navigate within the app, come back. Bytes kept arriving. Simulate the browser stopping it: on return the page shows the away message and continues.

- [ ] T020 [US2] In src/routes/jobs/[id]/+page.svelte (depends on T017):
  - On mount with a store entry: build this page's own object URL from `store.file` for the Monitor, revoked in `onDestroy`.
  - On mount with the store `done` while the user was elsewhere: run the post-upload step poll at once (US2 scenario 2).
  - Away (research R9): the store records `saved` when `visibilitychange` goes hidden; on visible (or `resume`), if no progress event arrived while hidden, show "The upload paused while you were away." with the saved percentage until bytes flow, and resume at once.
  - Tests in tests/unit/routes/jobs/[id]/page.test.ts: the Monitor gets an object URL from the store; hidden with no progress then visible shows the away text and triggers a resume; hidden with progress shows nothing; done-while-away drives the step.
- [ ] T021 [P] [US2] E2E in tests/e2e/upload.spec.ts (both projects): throttle the session with `/control/throttle` so the upload is mid-flight, click Back to releases, open `/settings`, return to the job; the fake's saved bytes grew while away and no second session was created; the job lands.

**Checkpoint**: US1 and US2 both work alone.

---

## Phase 5: User Story 3 - Continue after a reload or a closed tab (Priority: P1)

**Goal**: With no file in the tab, the job page shows the saved amount and a picker. The same video resumes; a different one starts over.

**Independent Test**: Reload at 30% and pick the same file: it continues from about 30%. Reload and pick a different file: it starts from zero, and that file is the one that lands.

- [ ] T022 [US3] Add src/lib/server/jobs/upload-session.ts with `uploadSession(job, body, origin)`, checks in the contract's order (depends on T006–T008):
  - `DISCARDED` → `409 'This job was discarded.'`; left `AWAITING_UPLOAD` or `objectInfo` finds the object → `409 'This upload is already done.'`.
  - `renew: false`, size and fingerprint match the stored `videoUpload` → `200 { sessionUri, restarted: false }` with the current session.
  - `renew: false`, anything else (including no stored `videoUpload`) → run the create caps parser (400 with its message, nothing changes), create a session, `swapVideoUpload` unconditionally with the new `filename` and `contentType`, then `cancelUploadSession(old)` → `200 { restarted: true }`.
  - A pick's swap that matches no row (discarded or landed meanwhile) → cancel the session just made, re-read the job, and return the 409 for its state now.
  - `renew: true` with `prev` (required, a non-empty string; else 400) → create a session with the stored `videoUpload.size` and `job.contentType` (body file fields ignored), `swapVideoUpload` with `prev`; matched → cancel `prev`, `200 { restarted: true }`; not matched → cancel the session just made, `409 'A different video replaced this upload.'`.
  - Add src/routes/api/jobs/[id]/upload-session/+server.ts: `authorizedJob` (another user's job → 404), `readBody`, `respond`, `event.url.origin`.
  - Tests in tests/unit/lib/server/jobs/upload-session.test.ts and tests/unit/routes/api/jobs/[id]/upload-session/server.test.ts (PGlite, GCS mocked): match; new file swaps and cancels the old; new file over caps 400 with the row unchanged; another user's job 404 with nothing created; signed out 404; already landed 409; left `AWAITING_UPLOAD` 409; discarded 409; renew with matching `prev` cancels the old; renew with stale `prev` 409 and cancels the new; renew without `prev` 400; a pick racing a discard (swap matches no row) cancels the new session and 409s; the session URI appears in no thrown message and no `captureException` call.
- [ ] T023 [P] [US3] In src/routes/jobs/[id]/+page.server.ts add `uploadSaved` to the load data (data-model "Job page data"): for `AWAITING_UPLOAD` with a `videoUpload`, `uploadOffset(sessionUri, size)` → `{ saved, total: size }` (`done` → `{ saved: size, total: size }`); a throw or no session → `null`. It never returns the session URI. Tests in tests/unit/routes/jobs/[id]/page.server.test.ts: saved from a `308` with `Range`, `0` without, `null` on a failed query and on no session, no query for other states, and the serialized load data contains no session URI.
- [ ] T024 [US3] Re-pick prompt in src/routes/jobs/[id]/+page.svelte (depends on T020, T022, T023):
  - No store entry and `AWAITING_UPLOAD`: show `Upload paused at n%. Pick the video to continue.` from `data.uploadSaved`, or "Pick the video to continue." when it's null, with a file input (`accept="video/*"`).
  - On pick: object URL into the Monitor, wait for its `duration`, compute `fingerprint`, call `uploadSession` with `renew: false`, size, fingerprint, filename, `file.type || 'video/mp4'` and `durationSec`; `restarted: true` shows "New video: starting the upload over."; then `start` the store.
  - A 400 shows its message and keeps the prompt; a 409 "already done" re-fetches the view and drives the step loop (the page moves on to analysis); "discarded" re-fetches and shows the discarded state.
  - Tests in tests/unit/routes/jobs/[id]/page.test.ts: both prompt texts; the same file resumes with `restarted: false`; a different file shows the restart text; 400 and 409 handling.
- [ ] T025 [US3] Renew and 409 handling in src/lib/upload.ts (depends on T012, T022): a `renew` action calls `uploadSession` with `renew: true` and `prev`; `200` swaps the store's `sessionUri`, sets `saved` to 0 and surfaces "The saved upload expired; starting again."; `409` replaced → state `replaced` (the page shows "A different video replaced this upload." and the file prompt); `409` discarded or done → state `stopped` and the page re-fetches. Each 409 releases the lock. Tests in tests/unit/lib/upload.test.ts: each branch, and that automatic retries never send `renew: false`.
- [ ] T026 [US3] Other-tab state in src/routes/jobs/[id]/+page.svelte (depends on T013, T024): state `other-tab` shows "Uploading in another tab" and no picker; `onTakeover` re-fetches the view, then shows analysis, the discarded text or the file prompt. Tests in tests/unit/routes/jobs/[id]/page.test.ts.
- [ ] T027 [P] [US3] E2E in tests/e2e/upload.spec.ts (both projects):
  - Reload mid-upload (after a `/control/drop` partial save): the page shows `Upload paused at n%` with `n > 0`; pick `clip-a.webm`: it continues and the fake's received bytes after the reload are under the file size minus the saved amount plus one 256 KiB (only the rest was sent); it lands.
  - Reload and pick `clip-b.webm`: "New video: starting the upload over."; the old session reads 404 at the fake; the landed object's size is `clip-b`'s.
  - Two pages in one context on one job: the second shows "Uploading in another tab"; close the first; the second shows the file prompt.
  - The job list on `/` still reads "Uploading" for an unfinished upload and its Open link goes to the job page (US3 scenario 4).

**Checkpoint**: All P1 stories work alone.

---

## Phase 6: User Story 4 - Discard stops an unfinished upload (Priority: P3)

**Goal**: Discarding mid-upload stops sending and leaves no object.

**Independent Test**: Discard mid-upload and confirm no object exists for that job.

- [ ] T028 [US4] In src/lib/server/jobs/actions.ts `discard` (research R10, FR-013), depends on T006, T007:
  - Move to `DISCARDED` (today's transition); then, only if the job was `AWAITING_UPLOAD` with a `videoUpload`: `cancelUploadSession`, then `deleteObject(job.object)` if `objectInfo` finds it (a final `PUT` raced the cancel); then clear `videoUpload`.
  - A finished upload's video is never deleted here.
  - Tests in tests/unit/lib/server/jobs/actions.test.ts and tests/unit/routes/api/jobs/[id]/discard/server.test.ts (PGlite, GCS mocked): order of calls; a late-landed object is deleted; a cancel failure still discards; a `PREP` or later job deletes nothing and cancels nothing; another user's job 404.
- [ ] T029 [US4] In src/routes/jobs/[id]/+page.svelte, the discard action calls the store's `stop(job.id)` before the request, so the in-flight `PUT` aborts at once. Test in tests/unit/routes/jobs/[id]/page.test.ts.
- [ ] T030 [P] [US4] E2E in tests/e2e/upload.spec.ts (both projects): discard mid-upload; the fake reports no landed object for the job and the session reads 404; the page shows the discarded state.

**Checkpoint**: Every story works alone.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T031 [P] Comments only: src/lib/components/ReleaseBar.svelte ("leaving mid-upload loses the file" → before Listening nothing is saved to come back to) and src/routes/+page.svelte ("only runs while the release's page is open" → the upload runs while the tab is open, but only the job page finishes it and starts analysis). No copy change: the row text stays true.
- [ ] T032 [P] Cross-user check in tests/unit/routes/isolation.test.ts: user A's `POST /api/jobs/<B's job>/upload-session` returns 404 and creates no session; A's job page load for B's job 404s before any status query.
- [ ] T033 Leak sweep: `grep -rn "sessionUri\|videoUpload" src` shows them only in gcs.ts, create.ts, jobs.ts, upload-session.ts, actions.ts, pipeline.ts, the two endpoints, api.ts, upload.ts and the job page's store use. No `console.*`, `captureException` extra, span attribute or breadcrumb carries one.
- [ ] T034 Validation loop per the run brief (max 5 attempts): `make ai-checks` (format-check, lint, typecheck, coverage 85/85/85/80, build, zero warnings); `pnpm exec playwright test` (both projects); `semgrep scan --config auto --error --metrics=off` on changed files; SonarQube `analyze_code_snippet` on every changed source file (project `anchildress1_soundboard`); `pnpm audit --prod` and `pnpm audit`. Zero findings.
- [ ] T035 👤 Live check per [quickstart, Live](quickstart.md#live-local-dev-against-the-dev-bucket), on `pnpm dev` against the dev bucket from `.env`, no deploy:
  - Build the ~1.2 GB, 14-minute copy of `~/Downloads/main_both wyatt.mp4` in the scratchpad with the quickstart's `ffmpeg` command. Never write to `~/Downloads`.
  - Steps 1–8: 20 simulated drops (DevTools Offline or a headed Playwright `context.setOffline` loop) finish with no click (SC-001); the 211 MB original with no drops is no slower than `main` (SC-005); in-app navigation keeps sending (SC-006); close and reopen, same file resumes within 5 s (SC-003); a different file restarts (SC-004); two tabs; discard leaves no object; Sentry breadcrumbs carry amounts only.
  - Run steps 1 and 4 in Chrome, Firefox and Safari (FR-016).
  - Record the results table (date, browser, file size, drops, wall time, pass/fail) in specs/003-resumable-upload/quickstart.md under the Live section.
  - Delete every `uploads/<jobId>` the run created and discard its jobs.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 first. T002–T005 in parallel after it.
- **Foundational (Phase 2)**: after Setup. Blocks every story.
- **US1 (Phase 3)**: after Phase 2. MVP.
- **US2 (Phase 4)**: after T017 (same page file).
- **US3 (Phase 5)**: after Phase 2; T024 and T026 after T020 (same page file).
- **US4 (Phase 6)**: T028 after Phase 2; T029 after T024 (same page file).
- **Polish (Phase 7)**: after every story. T035 last.

### Within Phases

- gcs.ts (T006) and jobs.ts (T007) before create.ts (T008) and upload-session.ts (T022).
- upload.ts: T012 → T013 → T025, in that order (one file).
- Job page: T017 → T020 → T024 → T026 → T029 (one file).
- E2E: T016 before T018, T019, T021, T027, T030; the spec tasks share tests/e2e/upload.spec.ts, so write them in order even where [P] marks independence from code.

### Parallel Opportunities

- Phase 1: T002, T003, T004, T005.
- Phase 2: T006, T007, T009, T010, T011, T015 together; then T008, T012, T016.
- US3: T023 beside T022.

## Parallel Example: Phase 2

```text
T006 gcs.ts session calls        T007 jobs.ts videoUpload + swap
T009 pipeline clears videoUpload  T010 fingerprint.ts
T011 retry.ts + api.ts            T015 status/release texts
```

## Implementation Strategy

### MVP (US1)

Phases 1–3: a new upload survives drops and lands. Reload still loses the file (US3).

### Incremental

1. US2: navigation keeps it sending.
2. US3: re-pick after reload, renew, other tab.
3. US4: discard cleanup.
4. Polish and the live check.

## Notes

- Never write Nathan's surname in fixtures, comments or commits.
- No new dependency, column or migration. No deploy.
- Commit per task or per logical group, signed, Conventional Commits, `Signed-off-by`, one AI footer.
