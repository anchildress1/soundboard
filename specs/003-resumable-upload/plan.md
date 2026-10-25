# Implementation Plan: Resumable video upload

**Branch**: `003-resumable-upload` | **Date**: 2026-10-22, re-checked against `main` at `fcee227` and revised after review on 2026-10-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-resumable-upload/spec.md`

## Summary

Replace the single 30-minute signed `PUT` with a GCS resumable session per job.

- **Session:** the server creates a GCS JSON API resumable session with `@google-cloud/storage`, with the app origin, content type, declared size and the job's upload generation, and only if the object doesn't exist yet. It's stored KMS-encrypted in `jobs.data.videoUpload`, like refresh tokens.
- **Newest pick wins:** a per-job `generation` counter rises on every pick and renew, under a row lock. Senders confirm their generation on each resume and every 30 s; a stale one stops. Completion accepts only an object stamped with the current generation.
- **Sending:** the browser sends the rest of the file in one `PUT`. After any drop, it asks GCS what was saved and sends from there.
- **The uploader** lives at app level, so navigating doesn't stop it. When a hidden tab comes back having sent nothing, the job page says so and continues.
- **Reloads:** the user re-picks the file. The same file resumes, and a different one starts over.
- **Unchanged:** everything from `PREP` on.

Gate G1 and both follow-ups ran on 2026-10-22 in Chromium, Firefox and WebKit. Gate G2 (research R13) is open and blocks the GCS helpers and the server-side status lookup ([quickstart](quickstart.md)).

## Today's flow (main at `fcee227`)

What this feature replaces, so nothing is left behind:

1. `src/routes/new/+page.svelte` (the guided release's Upload step, UI v2) picks the file, plays it in `Monitor`, and calls `createJob` (`src/lib/api.ts`) → `POST /api/jobs` → `create()` in `src/lib/server/jobs/create.ts`.
2. `create()` signs a V4 write URL with `signedUploadUrl()` (`src/lib/server/media/gcs.ts`: 30 min, `x-goog-content-length-range: 1,2147483648`) for `uploads/<jobId>`, stores the job as `AWAITING_UPLOAD`, and returns `{ id, uploadUrl }`.
3. The `/new` page hands `{ file, uploadUrl, objectUrl, contentType }` to `setPending()` (`src/lib/pending.ts`) and navigates to `/jobs/<id>`.
4. The job page (`src/routes/jobs/[id]/+page.svelte`) `takePending()`s it in `finishUpload()`. `uploadToGcs()` (`src/lib/api.ts`) sends the whole file in one XHR `PUT` **straight to `storage.googleapis.com`** with the signed headers. Then it polls `step` up to 4 times until `startOnceUploaded()` (`src/lib/server/pipeline/pipeline.ts`) sees the object and moves the job to `PREP`.
5. Leaving the job page doesn't abort the XHR (`uploadToGcs` has no abort), but the page that owned it is gone: nothing shows progress, a failure is lost, and nothing calls `step` when it lands. Unloading the document aborts it. A reload lands in `resumeAfterReload()`: "The upload was interrupted. Start a new run from the home page."
6. Discard shows on the working screen only for a paused publish (`publishPaused`), never during the browser upload.
7. Bucket CORS (`deploy.sh`) allows `GET`/`PUT` from the custom domain, every run.app URL and `http://localhost:5173`, with `x-goog-content-length-range` in the header list.
8. E2E has no upload test. `tests/e2e/fakes/storage.ts` reads every object as present except names with `expired`.

## Technical Context

**Language/Version**: TypeScript 6 strict, Node 24 (`.nvmrc`), SvelteKit 3, Svelte 5 runes

**Primary Dependencies**:

- `@google-cloud/storage` 8.2.0 (already present): `file.createResumableUpload` (JSON API, `<apiEndpoint>/upload/storage/v1/b/…?uploadType=resumable`), `file.getMetadata` and `file.delete`.
- `@google-cloud/kms` through `src/lib/server/core/kms.ts` (`encrypt`/`decrypt`, already used for refresh tokens) for the session URI.
- Server-side session status query and cancel: `fetch` to the session URI. The URI is its own credential, so no auth header. This is GCS HTTP, a process boundary.
- `p-retry` (already present) is not used for the uploader: its backoff restarts on `online`/`visibilitychange`, which `p-retry` can't interrupt. The uploader keeps its own timer with `UPLOAD_BACKOFF` (1 s doubling to 60 s) in `src/lib/retry.ts`, beside `POLL_BACKOFF`.
- Browser: `XMLHttpRequest`, `crypto.subtle`, Web Locks. All are Baseline.
- No new packages.

**Storage**: Neon, no migration (`jobs.data.videoUpload`, jsonb). Row-level security already binds every `jobs` read and update to the signed-in owner (`query()` sets `app.user_sub`). Every `videoUpload` write runs under `lockJob` (`SELECT … FOR UPDATE`). Bucket unchanged; objects gain custom metadata `uploadGeneration`.

**Testing**:

- Vitest, mirrored under `tests/unit/`: the uploader's decision logic, the fingerprint, the server endpoints and actions on PGlite (`tests/helpers/db.ts`, real migrations).
- Mocks only at process boundaries: `@google-cloud/storage`, `@google-cloud/kms`, `fetch` for GCS session HTTP, `XMLHttpRequest`, `navigator.locks`. `@sentry/sveltekit` through `tests/mocks/sentry.ts`.
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
- The session URI is KMS ciphertext at rest and never reaches a request body, `JobView`, page data, an error message, logs or traces.
- Bucket CORS does not restrict the session URI (JSON API, research R1); its secrecy is the boundary.

**Scale/Scope**: 2 users.

## Constitution Check

Gates from `.specify/memory/constitution.md` v2.0.1.

| Principle                     | Status      | Notes                                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data                 | ✅          | The session is per job and released only to the owner through `authorizedJob`, with RLS underneath. Another user's job returns 404.                                                                                                                                         |
| I. Owned Data (credentials)   | ✅          | The session URI is a bearer credential. It's KMS-encrypted at rest through `core/kms.ts`, the refresh-token path (owner decision 2026-10-25), and never sent back in a request, logged or traced. The YouTube `upload.sessionUri` stays as it is: out of this spec's scope. |
| II. Truthful Output           | ✅          | After a pause, progress is what GCS confirmed. Connection and storage-busy pauses say which they are; a same-file takeover doesn't claim a different video.                                                                                                                 |
| III. One Service, Page-Driven | ✅          | No worker, queue or lease. A paused upload is a wait and never fails the job. Discard cleanup is best effort, repeated on the job's next touch, with the bucket's 7-day rule as the backstop (research R10).                                                                |
| IV. Domain-Grouped            | ✅          | Server code in `media/gcs.ts`, `jobs/create.ts`, `jobs/jobs.ts`, `jobs/actions.ts`, `pipeline/pipeline.ts`, plus the new `jobs/upload-session.ts`.                                                                                                                          |
| V. Tested at the Boundaries   | ⏳ G2 open  | G1 and both follow-ups ran on 2026-10-22. G2 (concurrent status query, generation metadata, post-412 status, uncorsed origin) blocks T007 and T013 (research R13). Unit and E2E scope per research R12.                                                                     |
| VI. Simplicity                | ✅          | No new dependency, column or service worker. One counter and a row lock in place of leases. `signedUploadUrl`, `CONTENT_LENGTH_RANGE`, `uploadToGcs` and `pending.ts` are deleted; the 308-finalize loop isn't built.                                                       |
| Media, Privacy, Secrets       | ✅          | Bytes go browser → GCS. The session URI is ciphertext in the database, like refresh tokens; no secret lands in the repo.                                                                                                                                                    |
| Workflow                      | ✅ approved | `deploy.sh`: bucket CORS keeps `GET` only and drops `x-goog-content-length-range`. `playwright.config.ts`: start the fake GCS session server.                                                                                                                               |

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
src/lib/server/media/gcs.ts           # + createUploadSession (ifGenerationMatch: 0, uploadGeneration), uploadOffset, cancelUploadSession, objectGeneration, deleteObject; − signedUploadUrl, CONTENT_LENGTH_RANGE
src/lib/server/jobs/create.ts         # parseMedia (shared) + create-only title/notes; fingerprint in; session encrypted; { id, sessionUri, generation } out
src/lib/server/jobs/jobs.ts           # JobDoc.videoUpload (not in toPublic); newJobDoc sets it null
src/lib/server/jobs/upload-session.ts # new: pick / renew / confirm under lockJob (contract order)
src/lib/server/jobs/actions.ts        # discard: locked transition decides cleanup; cancel (one retry) + object delete; clear videoUpload only when both confirmed
src/lib/server/pipeline/pipeline.ts   # startOnceUploaded: current-generation object only, under lockJob; a stale one is deleted
src/routes/api/jobs/+server.ts        # passes url.origin to create
src/routes/api/jobs/[id]/upload-session/+server.ts   # new: authorizedJob → upload-session.ts
src/routes/jobs/[id]/+page.server.ts  # uploadSaved { saved, total, done } in page data (load only); repeats discard cleanup for a DISCARDED job with videoUpload
src/lib/upload.ts                     # new: app-level uploader store; Web Lock before any session call; confirm every 30 s; stall and no-reply timers; stop(jobId)
src/lib/fingerprint.ts                # new: sampled SHA-256 (research R5)
src/lib/retry.ts                      # + UPLOAD_BACKOFF
src/lib/api.ts                        # − uploadToGcs; createJob returns { id, sessionUri, generation }; + uploadSession()
src/lib/pending.ts                    # deleted: folded into the upload store
src/lib/status.ts                     # paused / busy / away / re-pick / moved texts
src/lib/release.ts                    # AWAITING_UPLOAD working copy: moving around the app is safe
src/routes/new/+page.svelte           # fingerprint before create; takes the lock; hands file and session to the upload store
src/routes/+page.svelte               # comment only: the row text stays (finishing still needs the job page)
src/lib/components/ReleaseBar.svelte  # comment only: leaving mid-upload no longer loses the file
src/routes/jobs/[id]/+page.svelte     # subscribes to the store; lock query on entry; re-pick prompt; done → step; Discard during upload
tests/e2e/fakes/gcs-session.ts        # new: fake GCS JSON API session server (own port, CORS for any origin), offsets, generations, landed objects
tests/e2e/fakes/storage.ts            # createResumableUpload / exists / getMetadata / delete ask that server
tests/e2e/fakes/fixtures.ts           # + user uid-upload; upload tests create their own jobs through /new
tests/e2e/session.ts                  # + USER_UPLOAD
tests/e2e/fixtures/clip-a.webm        # new: synthetic VP9/Opus clips under 1 MB (clip-b differs)
tests/e2e/upload.spec.ts              # new
tests/mocks/sentry.ts                 # + addBreadcrumb
playwright.config.ts                  # starts the fake session server (approved)
deploy.sh                             # bucket CORS: GET only, header list (approved)
docs/prd.md                           # R1 and the UX working-screen line
AGENTS.md                             # E2E fake session server; session URI handling
```

`src/lib/types.ts` is unchanged: `uploadSaved` rides in the job page's load data beside `expired` and `playbackUrl`, not in `JobView`, so step and action responses never carry it.

## Delivery order

0. **Gate G2** on the dev bucket (research R13). Blocks the GCS helpers and the status lookup.
1. **Server:** session create, status, cancel, metadata and delete; encrypted `videoUpload` with the generation; `upload-session` (pick, renew, confirm); completion by generation; `uploadSaved`; discard.
2. **Switch-over, one green step:** create's new response, `api.ts`, `/new`, the upload store and the job page land together with the removals, so no checkpoint sits on a half-moved caller.
3. **Browser stories:** navigation, re-pick, other tab, other device, Discard.
4. **E2E:** fake session server first; then each story.
5. **Config and docs:** CORS, PRD R1, AGENTS.md.
6. **Live check:** local dev server against the dev bucket, with a large video and simulated drops ([quickstart](quickstart.md#live-local-dev-against-the-dev-bucket)). No deploy.

## Complexity Tracking

No violations.
