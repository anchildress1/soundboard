# Implementation Plan: Resumable video upload

**Branch**: `003-resumable-upload` | **Date**: 2026-10-22, re-checked against `main` at `fcee227` on 2026-10-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-resumable-upload/spec.md`

## Summary

Replace the single 30-minute signed `PUT` with a GCS resumable session per job.

- **Session:** the server creates it with `@google-cloud/storage`, bound to the app origin, content type and declared size, and only if the object doesn't exist yet. It's stored owner-only in `jobs.data.videoUpload`. A user's pick always wins; automatic renews swap only if nothing newer replaced them.
- **Sending:** the browser sends the rest of the file in one `PUT`. After any drop, it asks GCS what was saved and sends from there.
- **The uploader** lives at app level, so navigating doesn't stop it. When a hidden tab comes back having sent nothing, the job page says so and continues.
- **Reloads:** the user re-picks the file. The same file resumes, and a different one starts over.
- **Unchanged:** everything from `PREP` on.

Gate G1 and both follow-ups ran on 2026-10-22 in Chromium, Firefox and WebKit ([quickstart](quickstart.md)).

## Today's flow (main at `fcee227`)

What this feature replaces, so nothing is left behind:

1. `src/routes/new/+page.svelte` (the guided release's Upload step, UI v2) picks the file, plays it in `Monitor`, and calls `createJob` (`src/lib/api.ts`) → `POST /api/jobs` → `create()` in `src/lib/server/jobs/create.ts`.
2. `create()` signs a V4 write URL with `signedUploadUrl()` (`src/lib/server/media/gcs.ts`: 30 min, `x-goog-content-length-range: 1,2147483648`) for `uploads/<jobId>`, stores the job as `AWAITING_UPLOAD`, and returns `{ id, uploadUrl }`.
3. The `/new` page hands `{ file, uploadUrl, objectUrl, contentType }` to `setPending()` (`src/lib/pending.ts`) and navigates to `/jobs/<id>`.
4. The job page (`src/routes/jobs/[id]/+page.svelte`) `takePending()`s it in `finishUpload()`. `uploadToGcs()` (`src/lib/api.ts`) sends the whole file in one XHR `PUT` **straight to `storage.googleapis.com`** with the signed headers. Then it polls `step` up to 4 times until `startOnceUploaded()` (`src/lib/server/pipeline/pipeline.ts`) sees the object and moves the job to `PREP`.
5. Leaving the job page stops the upload. A reload lands in `resumeAfterReload()`: "The upload was interrupted. Start a new run from the home page."
6. Bucket CORS (`deploy.sh`) allows `GET`/`PUT` from the custom domain, every run.app URL and `http://localhost:5173`, with `x-goog-content-length-range` in the header list.
7. E2E has no upload test. `tests/e2e/fakes/storage.ts` reads every object as present except names with `expired`.

## Technical Context

**Language/Version**: TypeScript 6 strict, Node 24 (`.nvmrc`), SvelteKit 3, Svelte 5 runes

**Primary Dependencies**:

- `@google-cloud/storage` 8.2.0 (already present): `file.createResumableUpload` and `file.delete`.
- Server-side session status query and cancel: `fetch` to the session URI. The URI is its own credential, so no auth header. This is GCS HTTP, a process boundary.
- `p-retry` (already present) is not used for the uploader: its backoff restarts on `online`/`visibilitychange`, which `p-retry` can't interrupt. The uploader keeps its own timer with `UPLOAD_BACKOFF` (1 s doubling to 60 s) in `src/lib/retry.ts`, beside `POLL_BACKOFF`.
- Browser: `XMLHttpRequest`, `crypto.subtle`, Web Locks. All are Baseline.
- No new packages.

**Storage**: Neon, no migration (`jobs.data.videoUpload`, jsonb). Row-level security already binds every `jobs` read and update to the signed-in owner (`query()` sets `app.user_sub`). Bucket unchanged.

**Testing**:

- Vitest, mirrored under `tests/unit/`: the uploader's decision logic, the fingerprint, the server endpoints and actions on PGlite (`tests/helpers/db.ts`, real migrations).
- Mocks only at process boundaries: `@google-cloud/storage`, `fetch` for GCS session HTTP, `XMLHttpRequest`, `navigator.locks`. `@sentry/sveltekit` through `tests/mocks/sentry.ts`.
- Playwright, both projects (`chromium` desktop and `mobile` Pixel 7), against a fake GCS session server: a second `webServer` process on its own port. It must be a separate HTTP server, not a `fetch` preload like `tests/e2e/fakes/gemini.ts`, because the browser's `PUT`s and the app's status queries and cancels must reach the same state. `page.route` aborts requests to simulate drops.
- Scope is [research R12](research.md#r12--tests-only-what-can-break).

**Target Platform**: Current Chrome, Edge, Firefox and Safari, desktop and mobile. Cloud Run, one service.

**Project Type**: Web application, SvelteKit single project

**Performance Goals**:

- No slower than today on a stable link.
- A drop resends only what wasn't saved.
- Re-pick resumes within 5 s.

**Constraints**:

- No media bytes through the app.
- No background upload on the web (research R14).
- The session URI never reaches `JobView`, page data, logs or traces.

**Scale/Scope**: 2 users.

## Constitution Check

Gates from `.specify/memory/constitution.md` v2.0.1.

| Principle                     | Status            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data                 | ✅                | The session is per job and released only to the owner through `authorizedJob`, with RLS underneath. Another user's job returns 404.                                                                                                                                                                                                                                                                                                                                           |
| II. Truthful Output           | ✅                | After a pause, progress is what GCS confirmed.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| III. One Service, Page-Driven | ✅                | No worker of any kind. A paused upload is a wait and never fails the job.                                                                                                                                                                                                                                                                                                                                                                                                     |
| IV. Domain-Grouped            | ✅                | Server code in `media/gcs.ts`, `jobs/create.ts`, `jobs/jobs.ts`, `jobs/actions.ts`, plus the new `jobs/upload-session.ts`.                                                                                                                                                                                                                                                                                                                                                    |
| V. Tested at the Boundaries   | ✅                | G1 and both follow-ups ran on 2026-10-22 and are recorded. Unit and E2E scope per research R12.                                                                                                                                                                                                                                                                                                                                                                               |
| VI. Simplicity                | ✅                | No new dependency, column or service worker. `signedUploadUrl`, `CONTENT_LENGTH_RANGE`, `uploadToGcs` and `pending.ts` are deleted.                                                                                                                                                                                                                                                                                                                                           |
| Media, Privacy, Secrets       | ✅                | Bytes go browser → GCS. The session URI is kept out of views, logs and traces.                                                                                                                                                                                                                                                                                                                                                                                                |
| I. Owned Data (credentials)   | ✅ interpretation | The GCS session URI is a bearer credential for one object, valid up to 7 days. GCS is the app's own storage, not a platform under IV, so I's "platform credentials MUST be encrypted" doesn't reach it. It's stored in plain text in `jobs.data` (owner-only under RLS), like the existing YouTube `upload.sessionUri`, and kept out of views, page data, logs and traces. Requiring KMS for both session kinds is an owner call (listed as an open question), not a blocker. |
| Workflow                      | ✅ approved       | `deploy.sh`: drop `x-goog-content-length-range` from the bucket CORS header list. `playwright.config.ts`: start the fake GCS session server.                                                                                                                                                                                                                                                                                                                                  |

## Project Structure

### Documentation (this feature)

```text
specs/003-resumable-upload/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/upload-session.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/lib/server/media/gcs.ts           # + createUploadSession (ifGenerationMatch: 0), uploadOffset, cancelUploadSession, deleteObject; − signedUploadUrl, CONTENT_LENGTH_RANGE
src/lib/server/jobs/create.ts         # fingerprint in, sessionUri out, videoUpload stored; caps parser shared with upload-session
src/lib/server/jobs/jobs.ts           # JobDoc.videoUpload (not in toPublic); newJobDoc sets it null; swapVideoUpload (unconditional for picks, conditional on prev for renews)
src/lib/server/jobs/upload-session.ts # new: the upload-session decisions (contract order)
src/lib/server/jobs/actions.ts        # discard: transition, cancel session, delete a late-landed object only for an unfinished upload, clear videoUpload
src/lib/server/pipeline/pipeline.ts   # startOnceUploaded clears videoUpload
src/routes/api/jobs/[id]/upload-session/+server.ts   # new: authorizedJob → upload-session.ts
src/routes/jobs/[id]/+page.server.ts  # uploadSaved in page data, from a status query, for AWAITING_UPLOAD (load only)
src/lib/upload.ts                     # new: app-level uploader store (holds the picked file); lock on pick; stop(jobId)
src/lib/fingerprint.ts                # new
src/lib/retry.ts                      # + UPLOAD_BACKOFF
src/lib/api.ts                        # − uploadToGcs; createJob returns sessionUri; + uploadSession()
src/lib/pending.ts                    # deleted: folded into the upload store
src/lib/status.ts                     # paused / away / re-pick texts
src/lib/release.ts                    # AWAITING_UPLOAD working copy: moving around the app is safe
src/routes/new/+page.svelte           # fingerprint before create; hands file and session to the upload store
src/routes/+page.svelte               # comment only: the row text stays (finishing still needs the job page)
src/lib/components/ReleaseBar.svelte  # comment only: leaving mid-upload no longer loses the file
src/routes/jobs/[id]/+page.svelte     # subscribes to the store; object URL from store.file; re-pick prompt measures duration; discard calls uploader.stop
tests/e2e/fakes/gcs-session.ts        # new: fake GCS session HTTP server (own port, CORS), holds offsets and landed objects
tests/e2e/fakes/storage.ts            # createResumableUpload returns a URI on that server; exists/getMetadata/delete ask it
tests/e2e/fakes/fixtures.ts           # + user uid-upload; upload tests create their own jobs through /new
tests/e2e/session.ts                  # + USER_UPLOAD
tests/e2e/fixtures/clip-a.webm        # new: synthetic VP9/Opus clips under 1 MB (clip-b differs)
tests/e2e/upload.spec.ts              # new
tests/mocks/sentry.ts                 # + addBreadcrumb
playwright.config.ts                  # starts the fake session server (approved)
deploy.sh                             # CORS header list (approved)
docs/prd.md                           # R1 and the UX working-screen line
AGENTS.md                             # E2E fake session server; session URI handling
```

`src/lib/types.ts` is unchanged: `uploadSaved` rides in the job page's load data beside `expired` and `playbackUrl`, not in `JobView`, so step and action responses never carry it.

## Delivery order

1. **Server:** session create, offset, cancel and delete; `videoUpload` with compare-and-swap; `upload-session`; `uploadSaved`; discard.
2. **Browser:** fingerprint, uploader store with the lock, status texts, `/new` and job page.
3. **E2E:** fake session server first; then drops, reload re-pick, new file, in-app navigation, second-tab takeover, discard.
4. **Config and docs:** CORS header list, PRD R1.
5. **Live check:** local dev server against the dev bucket, with a large video and simulated drops ([quickstart](quickstart.md#live-local-dev-against-the-dev-bucket)). No deploy.

## Complexity Tracking

No violations.
