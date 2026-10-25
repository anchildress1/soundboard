---
description: 'Task list for the resumable video upload'
---

# Tasks: Resumable video upload

**Input**: Design documents from `specs/003-resumable-upload/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/upload-session.md](contracts/upload-session.md), [quickstart.md](quickstart.md)

**Tests**: Required. AGENTS.md and constitution V require positive, negative, error and edge-case tests for every new module, and the spec's success criteria call for automated coverage.

- Unit tests go in `tests/unit/`, mirroring `src/`. Import app code through `#lib/*` and `#src/*` with the `.js` extension, never relative paths into `src/`.
- Mock only at process boundaries: `@google-cloud/storage`, `@google-cloud/kms`, `fetch` for GCS session HTTP, `XMLHttpRequest`, `navigator.locks`, `crypto.subtle` only where jsdom lacks it. Never mock internal modules.
- The database is never mocked: `#lib/server/core/db.js` is PGlite with the real migrations (`tests/helpers/db.ts`). Seed rows through it.
- `@sentry/sveltekit` is the global mock in `tests/mocks/sentry.ts`. Assert through it.
- E2E goes in `tests/e2e/` and runs both projects, `chromium` (desktop Chrome) and `mobile` (Pixel 7, the primary path), against the in-repo fakes. Upload tests sign in as a dedicated user (`USER_UPLOAD`) and create every job through `/new`, so each test and project gets its own random job ID and no other spec's job list changes.
- Scope is research R12: test what can break, not GCS's documented behavior or browser APIs we only call.
- Each task's tests are part of the task. Coverage floors 85/85/85/80 hold at every checkpoint.

**Organization**: Tasks are grouped by user story. US1, US2 and US3 are P1; US4 is P3.

**Gates**:

- **FR-017** (T001) lands before any behavior code: code that disagrees with the PRD is a stop.
- **G2** (T006) blocks T011 and T017 (research R13). If it fails, apply its fixed fallback to research, contract and these tasks before T011. Nothing else is designed at implementation time.
- **No deploy.** The live check (T035) runs on the local dev server against the dev bucket.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task serves (US1–US4)
- 👤 Yours to run or approve. Repo config (`deploy.sh`, `playwright.config.ts`) is pre-approved in the plan's Constitution Check except where a task says otherwise; list each change in the PR.

---

## Phase 1: Setup

**Purpose**: The docs agents work from, the config change, test seams, and gate G2.

- [x] T001 Update docs/prd.md (FR-017) before any behavior code:
  - **R1 · Upload:** replace "Browser PUTs straight to GCS via signed URL" and the `x-goog-content-length-range` line with: the browser uploads straight to GCS in a resumable session, created by the server with the declared size (≤ 2 GB, GCS refuses any other size); each session writes its own object and the job records the current one; the session address is encrypted at rest like refresh tokens; after a drop it asks GCS what was saved and sends the rest; moving around the app keeps it sending; after a reload or a closed tab the user picks the same video to continue (matched by a sampled fingerprint), and a different video starts over; the newest pick wins across tabs and devices. Keep the 7-day delete rule, the unguessable job IDs and both checkboxes. Bucket CORS now covers playback only.
  - **UX, Working screens:** "leaving is safe once the browser upload is done" becomes "moving around the app is safe during the browser upload, and closing the tab is safe once it is done". Add that Discard shows during the browser upload.
  - No other PRD line changes.
- [ ] T002 [P] Update AGENTS.md (AI-only, directives only):
  - In the E2E builds line, add that `tests/e2e/fakes/gcs-session.ts` runs as its own Playwright `webServer` on port 4174 and holds every resumable session's offset and landed objects.
  - Under Data and access, beside the refresh-token line: "GCS upload session URIs: KMS ciphertext in `jobs.data.videoUpload.sessionCipher` only. Requests name a session by `generation`. NEVER log, trace, or put a session URI in a request; return it only from `POST /api/jobs` and `POST /api/jobs/{id}/upload-session`."
  - Under Media: "Each upload session writes its own object `uploads/<jobId>/<objectId>`; read the video only through `job.object`. NEVER call GCS or KMS inside a database transaction."
- [x] T003 [P] 👤 In deploy.sh, bucket CORS: drop `"x-goog-content-length-range"` from `responseHeader` (approved) and drop `"PUT"` from `method` (**needs your OK**: nothing PUTs through the XML API any more; research R1). Keep `GET`, the origins and `Content-Type`, `Content-Range`, `Accept-Ranges`, `Range` for playback. Update the comment above it: browsers stream playback from GCS through the XML API; uploads use JSON API sessions, which bucket CORS doesn't govern.
- [x] T004 [P] Add `addBreadcrumb = vi.fn()` to tests/mocks/sentry.ts, so uploader breadcrumbs (FR-015) can be asserted.
- [ ] T005 [P] Add two synthetic E2E video fixtures, each under 1 MB, in tests/e2e/fixtures/: `clip-a.webm` and `clip-b.webm` (VP9 + Opus, so Playwright's Chromium plays them and the Monitor reads a duration; never Nathan's media). Generate with `ffmpeg -f lavfi -i testsrc2=size=320x240:rate=24 -f lavfi -i sine=frequency=440 -t 4 -c:v libvpx-vp9 -b:v 1500k -c:a libopus` (`clip-b` with `frequency=660` and `-vf hue=h=90`, so its bytes and fingerprint differ). Record the commands in a comment at the top of tests/e2e/upload.spec.ts (created in T023).
- [x] T006 👤 Run gate G2 (research R13, quickstart table) on the dev bucket from `.env`, with throwaway objects under `g2-check/` deleted afterwards, in Playwright Chromium, Firefox and WebKit: two clients `PUT` the same bytes from the same offset to one session at once while a third sends a status query. Record the result in specs/003-resumable-upload/quickstart.md. On failure, apply the fixed fallback (a same-file pick from a stale generation gets a fresh session for a new object, restarting from 0) to research R6, the contract and T011 before T011 starts.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Every server piece, the uploader modules and the E2E fake, added beside today's flow. Nothing today's callers import is removed here, and jobs the signed `PUT` creates still complete, so this phase ends green.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T007 [P] In src/lib/server/core/kms.ts give `encrypt` and `decrypt` an optional `{ timeout }` passed as the gax call option (5 s on the upload path; refresh-token callers unchanged). Tests in tests/unit/lib/server/core/kms.test.ts: the option reaches the mocked client; a call past it rejects.
- [x] T008 In src/lib/server/media/gcs.ts (contract "Server ↔ GCS and KMS"). Add only; `signedUploadUrl` and today's `uploadObjectName(jobId)` stay until T022:
  - `newUploadObject(jobId)`: `uploads/<jobId>/<objectId>`, `objectId` 16 random bytes base64url.
  - `createUploadSession(object, { origin, contentType, size })`: `bucket().file(object).createResumableUpload({ origin, metadata: { contentType, contentLength: size } })` with a 10 s timeout and SDK retries bounded inside it; returns the session URI.
  - `uploadOffset(sessionUri, size)`: `fetch` `PUT`, empty body, `Content-Range: bytes */<size>`. `{ done: true }` on `200`/`201`; `{ done: false, saved: N+1 }` on `308` with `Range: bytes=0-N`; `{ done: false, saved: 0 }` on `308` without `Range`; throws on anything else.
  - `cancelUploadSession(sessionUri)`: `fetch` `DELETE`, one retry. `true` on `2xx`, `404`, `410`, `499`; `false` after two failures. Never throws.
  - `sweepUploads(jobId, keep: string | null)`: `getFiles({ prefix: 'uploads/<jobId>/' })`, then `delete({ ignoreNotFound: true })` each name except `keep`; 10 s overall; returns whether every delete succeeded. Never throws.
  - `objectInfo` gains the 5 s timeout. Every `fetch` carries `signal: AbortSignal.timeout(5000)`, or the caller's smaller remaining step deadline when one is passed.
  - Tests in tests/unit/lib/server/media/gcs.test.ts: the exact `createResumableUpload` options and no precondition; name shape and uniqueness; every `uploadOffset` reply plus a network throw and a timeout; cancel's done codes, its retry, and `false` after two `500`s; the sweep keeps `keep`, never touches `uploads/<jobId>-1` (a Short render), reports a failed delete and a listing timeout; a stalled SDK call rejects at its deadline. The session URI never appears in a thrown message.
- [x] T009 [P] In src/lib/server/jobs/jobs.ts add `videoUpload` to `JobDoc` exactly as data-model.md (`sessionCipher`, `generation`, `size`, `fingerprint`, `ops`), with its comments; `newJobDoc` sets it to `null`; `toPublic` doesn't copy it. Add `commitUpload(id, readGeneration, patch)`: one conditional `UPDATE … WHERE state = 'AWAITING_UPLOAD' AND generation = readGeneration RETURNING`, `null` when no row matched; `ops` keeps the last 20. Tests in tests/unit/lib/server/jobs/jobs.test.ts (PGlite): new and Short docs carry `null`; `toPublic` output has no `videoUpload` key; a row without the key reads as null; `commitUpload` at the read generation writes, at a stale one or a non-`AWAITING_UPLOAD` state returns `null` and changes nothing; `ops` caps at 20 and keeps each entry's `restarted`.
- [x] T010 [P] In src/lib/server/jobs/create.ts split today's `parseUpload` into create-only song title and notes checks and an exported `parseMedia({ filename, contentType, size, durationSec })` with today's exact media messages. `create()`'s behavior and response don't change yet. Tests in tests/unit/lib/server/jobs/create.test.ts: `parseMedia` on its own with the documented `pick` payload (no song title) passes; each media cap fails with today's message; create still rejects a missing title.
- [x] T011 Add src/lib/server/jobs/upload-session.ts with `uploadSession(job, body, origin)` and src/routes/api/jobs/[id]/upload-session/+server.ts (`authorizedJob`, `readBody`, `respond`, `event.url.origin`), in the contract's check order. After T006; depends on T007–T010 and T013:
  - Read the job, do every GCS and KMS call outside any transaction, commit with `commitUpload` on the generation read. No row: cancel any session this call made, re-read, and run the checks again from the top, `opId` replay first, before answering a conflict (409 replaced, moved, discarded or done).
  - Every replaced or moved 409 carries `{ error, generation }` with the current generation.
  - `pick` (`opId`, observed `generation`, `size`, `fingerprint`, `filename`, `contentType`, `durationSec`): `opId` replay first (contract); then an observed `generation` that isn't current → 409, nothing changes. Match (size and fingerprint) → same session and object, `generation + 1`. No match → `parseMedia`, `newUploadObject`, `createUploadSession`, encrypt, commit `videoUpload`, `object`, `filename`, `contentType`; after commit, cancel the displaced session.
  - `renew` (`opId`, `generation`, `fingerprint`): replay first. Current generation → new object and session from the stored size and `contentType`, `generation + 1`, cancel the old after commit. Stale → 409 replaced (fingerprint differs) or moved (same fingerprint).
  - `confirm` (`generation`, `fingerprint`): a read. Current → `{ current: true }`; stale → the same two 409s.
  - Before any of these: `DISCARDED` → T013's owed cleanup, then 409 "This job was discarded."; left `AWAITING_UPLOAD`, or `objectInfo(job.object)` finds it landed → 409 "This upload is already done."
  - Tests in tests/unit/lib/server/jobs/upload-session.test.ts and tests/unit/routes/api/jobs/[id]/upload-session/server.test.ts (PGlite; storage, KMS and `fetch` mocked): match bumps the generation and keeps the session; new file commits a new object and cancels exactly the displaced session; **two concurrent picks** (two calls without awaiting) end with one committed session, the loser's session cancelled once and the loser answered 409; **lost pick reply**: pick A commits, pick B from another device commits, A retried with its `opId` gets 409 and changes nothing; A retried before B returns the same session without bumping; **replay after `ops` eviction**: A's `opId` pushed out by 20 later ops, A retried at its old observed generation → 409 with the current generation, nothing changes; **overlapping retries of one `opId`**: the first attempt held on a deferred storage mock past the client's 10 s timeout, the retry commits, then the first's commit misses, re-reads, answers the retry's session (200, not 409) and cancels its own session once; **reload and takeover separately**: a same-fingerprint pick at the current generation resumes the session (`restarted: false`), a same-fingerprint pick at a stale observed generation answers 409 moved; new file over caps 400 with the row unchanged; renew current, renew replayed by `opId` (answers `restarted: true` as the original did), renew stale (replaced and moved); confirm current and stale; already landed; left `AWAITING_UPLOAD`; discarded; malformed bodies 400; another user's job 404; signed out 404; **no transaction is open while a storage, KMS or `fetch` mock is pending** (hold the mock on a deferred promise and assert a direct `db()` update of the same row completes before it is released; PGlite would block it inside an open transaction); a storage mock that never settles rejects at its deadline and the row is unchanged; the stored `sessionCipher` is ciphertext; the URI appears in no thrown message, no `captureException` call and no request schema.
- [x] T012 [P] In src/lib/server/pipeline/pipeline.ts, `startOnceUploaded` (research R6 "Completion"), depends on T008, T009. Route it through the normal step lifecycle, not a pre-claim path: `claimJob` (none → "step running in another tab"), `stepDeadline()`, `objectInfo(job.object)` capped by that deadline (never a fresh one); found → `releaseJob` with the matching token to `PREP` with `videoUpload: null`, guarded on the state still `AWAITING_UPLOAD` and `object` still that name; not found, or the storage call stalls or fails → release with no change, never a failure strike; then `sweepUploads(job.id, job.object)`, best effort, under the same step deadline. Jobs the signed `PUT` creates (no `videoUpload`, object `uploads/<jobId>`) complete exactly as today, so the existing "moves on once uploaded" test stays green. Tests in tests/unit/lib/server/pipeline/pipeline.test.ts: the current object moves on, clears `videoUpload`, sweeps and leaves no claim; an orphan under the prefix with `job.object` absent doesn't move it; `object` replaced between read and commit doesn't move it and the claim is released; nothing landed waits; a failed sweep still moves on; **concurrent completion** (two steps without awaiting) moves the job once and the other answers the other-tab wait; **a stalled storage call** rejects at the step deadline with the job unchanged, unclaimed and with no failure counted.
- [x] T013 [P] In src/lib/server/jobs/actions.ts `discard` (research R10, FR-013), depends on T008, T009:
  - `objectInfo(job.object)` first, outside any transaction; a failed read → 503 "Couldn't check the upload. Try again." with nothing changed.
  - One conditional `UPDATE … RETURNING`: for a job read as `AWAITING_UPLOAD` it requires the inspected `object` and `generation` too; when the object had landed, the same statement clears `videoUpload` (kept). No row → re-read and decide again from the object read, at most 3 times, then 503 "Couldn't check the upload. Try again.".
  - After commit: kept → `sweepUploads(id, job.object)`. Unfinished (`videoUpload` still set) → export and call `finishDiscardCleanup(job)`: cancel, `sweepUploads(id, null)`, clear `videoUpload` only when both succeeded. No queue, no timer. A job without `videoUpload` discards as today.
  - Tests in tests/unit/lib/server/jobs/actions.test.ts and tests/unit/routes/api/jobs/[id]/discard/server.test.ts (PGlite, storage mocked): unfinished → cancel and whole-prefix sweep, `videoUpload` cleared; **finished while the page was closed** → kept, orphans swept, `videoUpload` cleared; a job that moved to `PREP` between the read and the commit → no cleanup; **a completed replacement survives**: a different file B picked and landed between the read and the commit → the retry sees B landed, keeps it and sweeps only the orphans; three misses in a row → 503 with the job unchanged; a failed cancel leaves `videoUpload` set and `finishDiscardCleanup` on the next call finishes it; an object that lands after the discard is deleted on that next call; a failed object read answers 503 and leaves the job as it was; another user's job 404.
- [x] T014 [P] In src/routes/jobs/[id]/+page.server.ts (data-model "Job page data"), after T013: for `AWAITING_UPLOAD` with a `videoUpload`, decrypt (5 s) and `uploadOffset` (5 s) → `uploadSaved: { saved, total: size, done }`; a KMS or GCS failure or timeout, or no session → `null`. `uploadGeneration`: the current `videoUpload.generation`, `0` without one. For a `DISCARDED` job with `videoUpload` set, `finishDiscardCleanup` before returning. It never returns the session URI. Tests in tests/unit/routes/jobs/[id]/page.server.test.ts: `308` with and without `Range`, `done`, a failed or never-settling query and no session give null, no query for other states, owed discard cleanup on load, and the serialized load data contains no session URI.
- [x] T015 [P] Add src/lib/fingerprint.ts: `fingerprint(file: File): Promise<string>`, hex SHA-256 (Web Crypto) over size (8 bytes BE), name (4-byte BE length + UTF-8), `lastModified` (8 bytes BE), the first 1 MiB, the last 1 MiB, and 64 samples of 64 KiB starting at `floor(i * (size - 64 KiB) / 63)` for `i` in 0–63, clamped to the file (research R5). Tests in tests/unit/lib/fingerprint.test.ts: the exact input bytes for a 100 KiB and a 10 MiB file (compare with Node's `crypto.createHash`); a changed byte inside a sample, the first MiB or the last MiB changes it; a different size, name or `lastModified` changes it; a rejected file read rejects; **changed-middle limit:** two equal-size files with the same name and `lastModified` that differ only in a byte between samples get the same fingerprint (the test name says it documents the accepted limit in spec FR-009/SC-004).
- [x] T016 [P] In src/lib/retry.ts add `UPLOAD_BACKOFF = { minTimeout: 1000, factor: 2, maxTimeout: 60_000 }` (research R4) beside `POLL_BACKOFF`, with a one-line why. In src/lib/api.ts add `uploadSession(id, body)` → `POST /api/jobs/{id}/upload-session` with `signal: AbortSignal.timeout(10_000)`, typed per the contract's three ops, throwing `ApiError` with the 409 message and a distinct timeout error. Keep `uploadToGcs` and today's `createJob` until T022. Tests in tests/unit/lib/api.test.ts (mock `fetch`): each op's request shape, a 200, a 409 message, a 404, a fetch that never settles rejects at 10 s.
- [x] T017 Add src/lib/upload.ts, the app-level uploader (research R2–R4, R9, R11; contract "Browser ↔ GCS"). After T006; depends on T015, T016:
  - A module-level Svelte store keyed by job ID, exactly data-model.md's entry and its `state` and `reason` values. No object URL. Nothing goes to browser storage.
  - `nextAction(reply)`: a pure function from an XHR result to the contract's row. A `308` whose `Range` covers every byte is a pause.
  - The loop: `confirm` and a status query (XHR `timeout` 15 s) before every attempt, then one `PUT` of `file.slice(offset)` with `Content-Range: bytes <offset>-<size-1>/<size>`. Never trust its own count over the status query. Live `upload.onprogress` while sending; after a pause `saved` resets to the confirmed offset.
  - Timers: 60 s stall with no progress event while the body is going out; once `loaded === total`, a 60 s no-reply timer. Either aborts the `PUT` and pauses.
  - Pause: `UPLOAD_BACKOFF`; `online` and `visibilitychange` to visible retry at once. Retries never stop while the app is open.
  - Renew on `404`/`410`/`499`: `uploadSession({ op: 'renew', opId, generation, fingerprint })`, one `opId` per renew reused across its retries. Status 0, `5xx` or a timeout from the app backs off and resends the same body. `200` swaps `sessionUri` and `generation`, sets `saved` to 0, and surfaces "The saved upload expired; starting again." `409` replaced → `replaced`, moved → `moved`, discarded or done → `stopped`; each aborts any `PUT`.
  - `start(jobId, { file, sessionUri, generation, size, fingerprint })`, `stop(jobId)` (aborts the in-flight XHR, clears timers, releases the lock).
  - Sentry: `addBreadcrumb` `upload paused` and `upload resumed` with `{ saved, total, reason }` only. No session URI, no file name, no bytes (FR-015).
  - Tests in tests/unit/lib/upload.test.ts with a fake `XMLHttpRequest`, a mocked `fetch` for the app endpoint and fake timers: every `nextAction` row; a drop at 40% resumes from the queried offset, not the local count (SC-002); 20 drops then finish with no call from the page (SC-001 logic); a `PUT` that reaches 100% and never answers is aborted at 60 s and recovers through the status query; the stall timer pauses mid-send; a status query and a `confirm` that never settle pause at their timeouts before any bytes are sent; backoff doubles to the 60 s cap; `online` cuts the wait; a renew whose reply is lost is retried with the same `opId`; each 409 lands in its state and aborts the `PUT`; breadcrumb data has only `saved`, `total`, `reason`; `stop` aborts and no further request goes out.
- [x] T018 The one-sender rules in src/lib/upload.ts (research R6, R8, FR-012), depends on T017:
  - `acquire(jobId)`: `navigator.locks.request('upload:' + jobId, { ifAvailable: true }, …)`. Callers take it after the file is read and **before** any `upload-session` call or `start`.
  - `holder(jobId)`: `navigator.locks.query()` says whether another tab holds it; `waitFor(jobId, signal, onTakeover)` queues a normal request, aborted by `signal`.
  - While sending, `confirm` every 30 s; a 409 aborts the `PUT` at once (state `replaced` or `moved`); a failed or timed-out confirm pauses the `PUT`, so no sender runs unconfirmed past one interval plus the 10 s timeout.
  - The holder releases the lock on done, on a 400 or 409 stop, on `stop`, and when its tab closes.
  - Tests in tests/unit/lib/upload.test.ts with a fake `navigator.locks`: the holder sends and a second store doesn't; `holder` reports another tab without anything picked; the queued tab takes over after release and calls `onTakeover`; an aborted queue never sends; a 409 from the 30 s confirm aborts the in-flight `PUT`; a confirm timeout pauses it.
- [x] T019 [P] Status texts in src/lib/status.ts and src/lib/release.ts, exactly the contract's Page states table and working-screen copy (FR-010):
  - status.ts: every Page states text, including `Upload paused: storage busy, retrying` for reasons `429`/`5xx`, `Upload paused: no connection` for `offline`, `stall`, `no-reply`, `timeout`, `408`, "Couldn't read this video. Pick it again." and "The upload moved to another device or window." `n` is `floor(saved / total * 100)`.
  - release.ts `workCopy` for `AWAITING_UPLOAD`: body "Keep this tab open until the upload finishes. Other pages in the app are fine."
  - Tests in tests/unit/lib/status.test.ts and tests/unit/lib/release.test.ts: each text and reason, `n` at 0, mid and just under total, and an unknown saved amount.
- [x] T020 [P] In src/lib/components/Monitor.svelte add an `onerror` callback prop, fired when the media element can't load the source (research R9). Tests in tests/unit/lib/components/Monitor.test.ts: an `error` event on the video calls it; a loaded file doesn't.
- [x] T021 E2E fake GCS session server, depends on T008:
  - Add tests/e2e/fakes/gcs-session.ts: a Node `http` server on port 4174 that answers CORS for any origin, like the JSON API (allow `PUT`, `DELETE`, request headers `Content-Range`, `Content-Type`; expose `Range`). Per session: object name, declared size, saved bytes. Objects by name, landed or not. It answers the contract's status query and `PUT` exactly (`308` with or without `Range`, `200` on the final byte, `400` on a size mismatch, `499` on `DELETE` then `404`).
  - Control routes: `POST /control/create`; `GET /control/object/<name>` (landed, size); `GET /control/objects?prefix=…`; `GET /control/session/<id>` (saved and total bytes received); `POST /control/drop?session=…&after=N` (the next `PUT` keeps N bytes, then destroys the socket); `POST /control/throttle?session=…&bytesPerSec=N`; `POST /control/fail?session=…&status=503&times=N`.
  - In tests/e2e/fakes/storage.ts: `createResumableUpload` calls `/control/create` and returns a URI on port 4174; `exists` and `getMetadata` report a landed object with its size and type, a name with only an unfinished session as absent, and every other object as today (present unless the name has `expired`); `getFiles({ prefix })` lists the server's names; `delete` removes one.
  - 👤 In playwright.config.ts add a second `webServer`: `node tests/e2e/fakes/gcs-session.ts`, `port: 4174`, `reuseExistingServer: false`, with a one-line comment why it's its own process (the browser and the app server must reach the same session state).
  - In tests/e2e/fakes/fixtures.ts seed one more active, unlinked user `uid-upload` (nothing here approves, so no YouTube connection), and export `USER_UPLOAD = 'uid-upload'` from tests/e2e/session.ts. No fixture jobs: each upload test creates its own through `/new`.

**Checkpoint**: `make ai-checks` green with today's flow still in place: every new server piece and module tested, nothing removed yet, signed-`PUT` jobs still complete.

---

## Phase 3: User Story 1 - A dropped connection doesn't restart the upload (Priority: P1) 🎯 MVP

**Goal**: Drops pause the upload; it resumes on its own from what storage saved and lands like an uninterrupted one.

**Independent Test**: Drop the connection several times mid-upload. It finishes with no tap, and the bytes received are close to the file size.

- [x] T022 [US1] Switch-over, one task so no checkpoint sits on a half-moved caller, depends on Phase 2:
  - src/lib/server/jobs/create.ts: `fingerprint` in `CreateInput` (64 lowercase hex, else 400 'Pick the video again.'); `newUploadObject` and `createUploadSession` before `createJob`, so a failure stores no job; encrypt it (5 s); store `object` and `videoUpload` (`generation: 1`, `ops: []`); `Created` is `{ id, sessionUri, generation }`. src/routes/api/jobs/+server.ts passes `url.origin`.
  - src/lib/api.ts: `createJob` sends `fingerprint` and returns `{ id, sessionUri, generation }`; delete `uploadToGcs`.
  - src/routes/new/+page.svelte: `fingerprint(file)` before create (while Start shows "Starting"); `acquire` the lock; hand `{ file, sessionUri, generation, size, fingerprint }` to `start`; `goto` the job page. It keeps revoking its own object URL on destroy.
  - src/routes/jobs/[id]/+page.svelte: replace `finishUpload`, `takePending` and `uploadPct` with the store. While the store has this job, the status row shows the contract's sending and pause texts by `reason`, never an error toast. On `done`: today's short step poll (`POLL_BACKOFF`, 4 retries), then `run()`. An other-`4xx` stop shows its message.
  - Delete `signedUploadUrl`, `CONTENT_LENGTH_RANGE`, `UPLOAD_TTL_MS` and the one-argument `uploadObjectName` from gcs.ts, src/lib/pending.ts, and their tests (tests/unit/lib/pending.test.ts and the signed-URL cases in gcs.test.ts and page.test.ts).
  - Tests: tests/unit/lib/server/jobs/create.test.ts and tests/unit/routes/api/jobs/server.test.ts (valid create stores ciphertext and an `uploads/<id>/<objectId>` object, returns the URI and generation 1; bad fingerprint, over 2 GB, over 15 minutes, non-video and a session-create failure or timeout store no job; signed out 401); tests/unit/routes/new/page.test.ts (fingerprint sent, lock taken, store started, a 400 starts nothing); tests/unit/routes/jobs/[id]/page.test.ts (sending, each pause reason and done render the contract texts; done drives the step loop; a stop message renders).
- [x] T023 [P] [US1] E2E in tests/e2e/upload.spec.ts (both projects): sign in as `USER_UPLOAD`, pick `clip-a.webm` on `/new`, start; arm `/control/drop` three times at increasing offsets; the page shows `Upload paused: no connection` at least once; with no click the job leaves `AWAITING_UPLOAD` (`GET /api/jobs/<id>` via `page.request`: `PREP` or later; E2E has no ffmpeg, so `FAILED` at `PREP` also counts); `/control/session` reports total bytes received under 2× the file size.
- [x] T024 [P] [US1] E2E in tests/e2e/upload.spec.ts: the link goes offline (`context.setOffline`) until five requests fail with status 0, then comes back; `page.route` was dropped because a routed request loses its Blob body in Chromium, even after `unroute`; and `/control/fail` answers `503` twice, during which the page shows `Upload paused: storage busy, retrying`. Both finish with no click.

**Checkpoint**: US1 works alone: an upload survives drops and storage errors. Today's flow is gone.

---

## Phase 4: User Story 2 - Moving around doesn't stop the upload (Priority: P1)

**Goal**: The upload keeps sending across in-app navigation; a hidden tab that stopped sending says so on return and continues.

**Independent Test**: Start an upload, navigate within the app, come back. Bytes kept arriving. Simulate the browser stopping it: on return the page shows the away message and continues.

- [x] T025 [US2] In src/routes/jobs/[id]/+page.svelte (depends on T022):
  - On mount with a store entry: this page's own object URL from `store.file` for the Monitor, revoked in `onDestroy`.
  - On mount with the store `done` while the user was elsewhere: the post-upload step poll at once (US2 scenario 2).
  - Away (research R9): the store records `saved` when `visibilitychange` goes hidden; on visible (or `resume`), if no progress arrived while hidden, show "The upload paused while you were away." with the saved percentage until bytes flow, and resume at once.
  - Tests in tests/unit/routes/jobs/[id]/page.test.ts: the Monitor gets an object URL from the store; hidden with no progress then visible shows the away text and triggers a resume; hidden with progress shows nothing; done-while-away drives the step.
- [ ] T026 [P] [US2] E2E in tests/e2e/upload.spec.ts (both projects): throttle the session with `/control/throttle` so the upload is mid-flight; click Back to releases, then open `/connections` and assert its heading loaded (`/settings` needs an artist link); return to the job; `/control/session` shows saved bytes grew while away, and no second session was created; the job lands.

**Checkpoint**: US1 and US2 both work alone.

---

## Phase 5: User Story 3 - Continue after a reload or a closed tab (Priority: P1)

**Goal**: With no file in the tab, the job page shows the saved amount and a picker. The same video resumes; a different one starts over. Only one sender runs.

**Independent Test**: Reload at 30% and pick the same file: it continues from about 30%. Reload and pick a different file: it starts from zero, and that file is the one that lands.

- [x] T027 [US3] Page entry and re-pick in src/routes/jobs/[id]/+page.svelte (depends on T014, T018, T020, T025):
  - No store entry, `AWAITING_UPLOAD`, `uploadSaved.done` → no picker: drive the step loop, so a job closed after its last byte moves on (today's recovery, kept).
  - No store entry and `holder(jobId)` says another tab holds the lock → "Uploading in another tab", no picker, and `waitFor` with an `AbortSignal` aborted on destroy. On takeover, re-fetch the view, then show analysis, the discarded text or the prompt.
  - Otherwise: `Upload paused at n%. Pick the video to continue.` from `data.uploadSaved`, or "Pick the video to continue." when it's null, with a file input (`accept="video/*"`).
  - On pick, **read the file before taking the lock** (research R8): object URL into the Monitor; wait for its `duration` (15 s limit) or `onerror`; `fingerprint`. Any failure (Monitor error, the limit, a rejected read) shows "Couldn't read this video. Pick it again.", revokes the object URL and keeps the picker; no lock was taken. Then `acquire` (no lock → the other-tab state); `uploadSession({ op: 'pick', opId, generation, size, fingerprint, filename, contentType: file.type || 'video/mp4', durationSec })` with one `opId` reused across its retries, `generation` the observed one (page load, then the last reply; a 409's `generation` replaces it); `restarted: true` shows "New video: starting the upload over."; then `start`.
  - A 400 shows its message, releases the lock and keeps the prompt; a 409 "already done" re-fetches and drives the step loop; "discarded" re-fetches and shows the discarded state; replaced or moved release the lock and show their texts plus the file prompt. A timeout backs off and resends the same body.
  - Tests in tests/unit/routes/jobs/[id]/page.test.ts: done with no file drives the step (the existing "resumes after a reload when the upload already landed" case, adapted); other-tab on entry with nothing picked; takeover re-fetches; both prompt texts; same file resumes with `restarted: false`; a different file shows the restart text; **corrupt media** (Monitor `onerror`), a duration that never arrives and a rejected fingerprint read each show the unreadable text with the picker back and `navigator.locks.request` never called; the lock is taken before `upload-session` is called; a pick retried after a timeout reuses its `opId`; 400 and every 409.
- [ ] T028 [P] [US3] E2E in tests/e2e/upload.spec.ts (both projects):
  - Reload mid-upload (after a `/control/drop` partial save): the page shows `Upload paused at n%` with `n > 0`; pick `clip-a.webm`: it continues, `/control/session` shows bytes received after the reload under the file size minus the saved amount plus 256 KiB; it lands.
  - Reload and pick `clip-b.webm`: "New video: starting the upload over."; the old session reads `404` at the fake; the landed object is `clip-b`'s size, and after the step `/control/objects?prefix=uploads/<id>/` lists only that one.
  - Pick a non-video file renamed `.webm`: "Couldn't read this video. Pick it again." and the picker is back.
  - Two pages in one context: open the second on the job **without picking**; it shows "Uploading in another tab"; close the first; the second shows the file prompt.
  - Two browser contexts as the same user: the second picks `clip-a.webm`; within 40 s (that assertion's `timeout: 45_000`; the test's own timeout raised to match) the first shows "The upload moved to another device or window." and only the second's session grows.
  - Throttle so the last bytes are in flight, close the page after `/control/object` reports landed but before the reply, reopen: the job moves on with no picker.
  - The job list on `/` still reads "Uploading" for an unfinished upload and its Open link goes to the job page (US3 scenario 4).

**Checkpoint**: All P1 stories work alone.

---

## Phase 6: User Story 4 - Discard stops an unfinished upload (Priority: P3)

**Goal**: Discarding mid-upload stops sending and leaves no object.

**Independent Test**: Discard mid-upload and confirm no object exists for that job.

- [ ] T029 [US4] Discard during the browser upload in src/routes/jobs/[id]/+page.svelte, depends on T013, T027:
  - Show the Discard button on the working screen for `AWAITING_UPLOAD` while the upload runs, is paused, waits on another tab, or waits for a pick, beside today's `publishPaused` case.
  - Its action calls the store's `stop(job.id)` before the request, so the in-flight `PUT` aborts at once, then `act('discard')`. A 503 shows its message and leaves the job as it was.
  - Tests in tests/unit/routes/jobs/[id]/page.test.ts: the button renders in each of those states and not for running model steps; clicking it stops the store before the discard request; a 503 renders its message.
- [ ] T030 [P] [US4] E2E in tests/e2e/upload.spec.ts (both projects): click the visible Discard button mid-upload; `/control/objects?prefix=uploads/<id>/` lists nothing and the session reads `404`; the page shows the discarded state.

**Checkpoint**: Every story works alone.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T031 [P] Comments only: src/lib/components/ReleaseBar.svelte ("leaving mid-upload loses the file" → before Listening nothing is saved to come back to) and src/routes/+page.svelte ("only runs while the release's page is open" → the upload runs while the tab is open, but only the job page finishes it and starts analysis). No copy change: the row text stays true.
- [ ] T032 [P] Cross-user check in tests/unit/routes/isolation.test.ts: user A's `POST /api/jobs/<B's job>/upload-session` (each op) returns 404, creates no session and decrypts nothing; A's job page load for B's job 404s before any status query.
- [ ] T033 Leak sweep: `grep -rn "sessionUri\|sessionCipher\|videoUpload" src` shows them only in gcs.ts, create.ts, jobs.ts, upload-session.ts, actions.ts, pipeline.ts, the two endpoints, the job page load, api.ts, upload.ts, `/new` and the job page's store use. No `console.*`, `captureException` extra, span attribute, breadcrumb or request body carries a session URI.
- [ ] T034 Validation loop per the run brief (max 5 attempts, then stop with the exact errors): `make ai-checks` (format-check, lint, typecheck, coverage 85/85/85/80, build, zero warnings); `pnpm exec playwright test` (both projects); `semgrep scan --config auto --error --metrics=off` on changed files; SonarQube `analyze_code_snippet` on every changed source file (project `anchildress1_soundboard`); `pnpm audit --prod` and `pnpm audit`. Zero findings.
- [ ] T035 👤 Live check per [quickstart, Live](quickstart.md#live-local-dev-against-the-dev-bucket), on `pnpm dev` against the dev bucket from `.env`, no deploy:
  - Build the ~1.2 GB, 14-minute copy of `~/Downloads/main_both wyatt.mp4` in the scratchpad with the quickstart's `ffmpeg` command. Never write to `~/Downloads`.
  - Steps 1–9: 20 simulated drops (DevTools Offline or a headed Playwright `context.setOffline` loop) finish with no click (SC-001); the 211 MB original with no drops is no slower than `main` (SC-005); in-app navigation keeps sending (SC-006); close and reopen, same file resumes within 5 s (SC-003), and closing after the last byte moves on with no pick; a different file restarts and leaves one object under the prefix (SC-004); two tabs; two browsers on the same file, then a different file; Discard leaves no object, and a finished upload survives discard; Sentry carries amounts only and the database holds ciphertext.
  - Run steps 1 and 4 in Chrome, Firefox and Safari (FR-016).
  - Record the results table (date, browser, file size, drops, wall time, pass/fail) in specs/003-resumable-upload/quickstart.md under the Live section.
  - Delete every `uploads/<jobId>/` prefix the run created and discard its jobs.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 first. T002–T005 in parallel after it. T006 (G2) before T011 and T017.
- **Foundational (Phase 2)**: after Setup. Blocks every story. Ends green with today's flow intact.
- **US1 (Phase 3)**: after Phase 2. T022 is the switch-over; T023–T024 after it. MVP.
- **US2 (Phase 4)**: after T022 (same page file).
- **US3 (Phase 5)**: T027 after T025 (same page file).
- **US4 (Phase 6)**: T029 after T027 (same page file).
- **Polish (Phase 7)**: after every story. T035 last.

### Within Phases

- kms.ts (T007), gcs.ts (T008) and jobs.ts (T009) before upload-session.ts (T011), completion (T012), discard (T013) and the page load (T014).
- discard (T013) before T011 and T014, which call `finishDiscardCleanup`.
- upload.ts: T017 → T018 (one file).
- Job page: T022 → T025 → T027 → T029 (one file).
- E2E: T021 before T023, T024, T026, T028, T030; they share tests/e2e/upload.spec.ts, so write them in order even where [P] marks independence from code.

### Parallel Opportunities

- Phase 1: T002, T003, T004, T005.
- Phase 2: T007, T009, T010, T015, T016, T019, T020 together; after T008: T012, T013, then T011 and T014; T017 after T015 and T016; T021 after T008.

## Parallel Example: Phase 2

```text
T007 kms.ts timeouts          T009 jobs.ts videoUpload + commitUpload
T010 parseMedia split         T015 fingerprint.ts
T016 retry.ts + api.ts        T019 status/release texts
T020 Monitor onerror
```

## Implementation Strategy

### MVP (US1)

Phases 1–3: a new upload survives drops and lands. Reload still loses the file (US3).

### Incremental

1. US2: navigation keeps it sending.
2. US3: re-pick after reload, other tab, other device.
3. US4: Discard during the upload.
4. Polish and the live check.

## Notes

- Never write Nathan's surname in fixtures, comments or commits.
- No new dependency, column or migration. No deploy.
- Commit per task or per logical group, signed, Conventional Commits, `Signed-off-by`, one AI footer.
