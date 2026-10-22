# Implementation Plan: Resumable video upload

**Branch**: `003-resumable-upload` | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-resumable-upload/spec.md`

## Summary

Replace the single 30-minute signed `PUT` with a GCS resumable session per job.

- **Session:** the server creates it with `@google-cloud/storage`, bound to the app origin, content type and declared size, and only if the object doesn't exist yet. It's stored owner-only in `jobs.data.videoUpload`. A user's pick always wins; automatic renews swap only if nothing newer replaced them.
- **Sending:** the browser sends the rest of the file in one `PUT`. After any drop, it asks GCS what was saved and sends from there.
- **The uploader** lives at app level, so navigating doesn't stop it. When a hidden tab comes back having sent nothing, the job page says so and continues.
- **Reloads:** the user re-picks the file. The same file resumes, and a different one starts over.
- **Unchanged:** everything from `PREP` on.

Gate G1 and both follow-ups ran on 2026-10-22 in Chromium, Firefox and WebKit ([quickstart](quickstart.md)).

## Technical Context

**Language/Version**: TypeScript 6 strict, Node 24 (`.nvmrc`)

**Primary Dependencies**:

- `@google-cloud/storage` (already present).
- Browser: `XMLHttpRequest`, `crypto.subtle`, Web Locks. All are Baseline.
- No new packages.

**Storage**: Neon, no migration (`jobs.data.videoUpload`). Bucket unchanged.

**Testing**: Vitest for the uploader's decision logic and the server endpoints (PGlite). Playwright runs against a fake GCS session server, a separate process like the existing model fake, because the browser's bytes and the app's status queries and cancels must reach the same state. `page.route` aborts requests to simulate drops. Scope is [research R12](research.md#r12--tests-only-what-can-break).

**Target Platform**: Current Chrome, Edge, Firefox and Safari, desktop and mobile. Cloud Run, one service.

**Project Type**: Web application, SvelteKit single project

**Performance Goals**:

- No slower than today on a stable link.
- A drop resends only what wasn't saved.
- Re-pick resumes within 5 s.

**Constraints**:

- No media bytes through the app.
- No background upload on the web (research R14).
- The session URI never reaches `JobView`, logs or traces.

**Scale/Scope**: 2 users.

## Constitution Check

Gates from `.specify/memory/constitution.md` v2.0.0.

| Principle                     | Status            | Notes                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data                 | ✅                | The session is per job and released only to the owner through `authorizedJob`. Another user's job returns 404.                                                                                                                                                                                                                                  |
| II. Truthful Output           | ✅                | After a pause, progress is what GCS confirmed.                                                                                                                                                                                                                                                                                                  |
| III. One Service, Page-Driven | ✅                | No worker of any kind. A paused upload is a wait and never fails the job.                                                                                                                                                                                                                                                                       |
| IV. Domain-Grouped            | ✅                | Server code in `media/gcs.ts`, `jobs/create.ts`, `jobs/actions.ts`.                                                                                                                                                                                                                                                                             |
| V. Tested at the Boundaries   | ✅                | G1 and both follow-ups ran on 2026-10-22 and are recorded.                                                                                                                                                                                                                                                                                      |
| VI. Simplicity                | ✅                | No new dependency, column or service worker. `signedUploadUrl`, `CONTENT_LENGTH_RANGE` and `uploadToGcs` are deleted.                                                                                                                                                                                                                           |
| Media, Privacy, Secrets       | ✅                | Bytes go browser → GCS. The session URI is kept out of views, logs and traces.                                                                                                                                                                                                                                                                  |
| I. Owned Data (credentials)   | ⚠️ interpretation | GCS and YouTube session URIs are bearer credentials for one upload, valid up to 7 days. They're treated as upload sessions, not platform credentials under I, so they're stored in plain text like the existing YouTube `upload.sessionUri`, and kept out of views, logs and traces. You may override this and require KMS encryption for both. |
| Workflow                      | ✅ approved       | `deploy.sh`: drop `x-goog-content-length-range` from the bucket CORS header list. `playwright.config.ts`: start the fake GCS session server.                                                                                                                                                                                                    |

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
└── tasks.md          # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/server/media/gcs.ts          # + createUploadSession (ifGenerationMatch: 0), uploadOffset, cancelUploadSession; − signedUploadUrl, CONTENT_LENGTH_RANGE
src/lib/server/jobs/create.ts        # fingerprint in, sessionUri out, videoUpload stored
src/lib/server/jobs/jobs.ts          # JobDoc.videoUpload (not in toPublic); unconditional swap for picks, conditional on prev for renews
src/routes/jobs/[id]/+page.server.ts # uploadSaved from a status query for AWAITING_UPLOAD (load only)
src/lib/server/jobs/actions.ts       # discard: transition, cancel session, delete a late-landed object only for an unfinished upload
src/lib/server/pipeline/pipeline.ts  # startOnceUploaded clears videoUpload
src/routes/api/jobs/[id]/upload-session/+server.ts   # new
src/lib/upload.ts                    # new: app-level uploader store (holds the picked file); lock on pick; stop(jobId)
src/lib/types.ts                     # JobView.uploadSaved
src/lib/fingerprint.ts               # new
src/lib/api.ts                       # − uploadToGcs; + uploadSession()
src/lib/pending.ts                   # deleted: folded into the upload store
src/lib/status.ts                    # paused / away / re-pick texts
src/routes/+page.svelte              # fingerprint before create
src/routes/jobs/[id]/+page.svelte    # subscribes to the store; object URL from store.file; re-pick measures duration; discard calls uploader.stop
tests/e2e/fakes/gcs-session.ts       # new: fake GCS session HTTP server (own port, CORS), holds offsets and landed objects
tests/e2e/fakes/storage.ts           # createResumableUpload returns a URI on that server; exists/getMetadata ask it
playwright.config.ts                 # starts the fake session server (approved)
deploy.sh                            # CORS header list (approved)
docs/prd.md                          # R1
```

## Delivery order

1. **Server:** session create, offset and cancel, `videoUpload` with compare-and-swap, `upload-session`, `uploadSaved`, discard.
2. **Browser:** fingerprint, uploader store with the lock, status texts, job page.
3. **E2E:** fake session server first; then drops, reload re-pick, new file, in-app navigation, second-tab takeover.
4. **Config and docs:** CORS header list, PRD R1.
5. **Deployed manual checks.**

## Complexity Tracking

No violations.
