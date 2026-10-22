# Research: Resumable video upload

Checked 2026-10-22 against:

- the GCS resumable-upload docs (concept, how-to, JSON API how-to, XML header reference)
- MDN's Background Fetch compatibility data
- the installed `@google-cloud/storage` types

Gate G1 ran the same day on the real bucket (see `quickstart.md`).

## R1 · Transport

- **Decision:** a GCS JSON API resumable session.
  - The server creates it per job with `file.createResumableUpload({ origin, metadata: { contentType, contentLength: size }, preconditionOpts: { ifGenerationMatch: 0 } })`.
  - `ifGenerationMatch: 0` means "only if the object doesn't exist." The installed SDK sends it only when `preconditionOpts` is passed (`resumable-upload.js` 8.2.0). G1 confirmed GCS enforces it at finalize (412), but not at session creation, so `upload-session` still checks for a landed object itself (R6).
  - The browser `PUT`s the bytes straight to the session URI.
- **Rationale:**
  - Media bytes never touch the app.
  - The session lives 7 days, the same as the bucket's delete rule.
  - The SDK already in the repo creates it, so there's no new dependency.
  - `origin` is the app's own origin (`event.url.origin`). Without it, GCS sends no CORS headers on the session's replies. G1 showed a session made for one allowed origin works from any other allowed origin: bucket CORS decides, so the origin isn't stored.
- **Alternatives:**
  - The browser starts the session through a signed `POST`: that needs `POST` in bucket CORS and exposes `Location`. Rejected.
  - tus or Uppy with a companion server: a new service. Rejected (constitution III, VI).
  - Many signed single `PUT`s plus `compose`: temporary objects and a compose step. Rejected.

## R2 · One request for the rest, not fixed parts

- **Decision:**
  - Each attempt sends **everything not yet saved** in one `PUT`: `Content-Range: bytes <offset>-<size-1>/<size>`, body `file.slice(offset)`.
  - After any interruption, a status query gives the new offset.
- **Evidence (G1):**
  - 8 MiB parts made a 64 MiB upload 5.9× slower on a fast link (6.2 s vs 1.05 s). Each part costs about 0.65 s of commit latency at GCS.
  - An interrupted single `PUT` kept 40.6 MB of what arrived, aligned to 256 KiB.
- **Rationale:** a drop loses only what GCS hadn't saved, with no per-part tax. On a slow link the parts tax was small, but on a fast link it made uploads far slower than today's single upload (SC-005).
- **Alternatives:** 8 MiB parts. That's a bounded loss per drop, but it fails SC-005. Rejected on the measurement.

## R3 · Offset protocol

- **Status query:** `PUT` an empty body with `Content-Range: bytes */<size>`.
  - `200` or `201`: complete.
  - `308` with `Range: bytes=0-N`: resume at `N+1`.
  - `308` without `Range`: resume at 0.
- **When:** before every attempt (start, resume, re-pick).
- **Offset equals size** (all bytes saved, final reply lost): send an empty `PUT` with `Content-Range: bytes */<size>` to finish, with the same backoff as R4, capped at 5 tries before falling back to the pause state. Never build `bytes <size>-<size-1>/<size>`.
- **Server-side lookup:** only the job page's server load (`jobs/[id]/+page.server.ts`) sends the same status query (no media) for an `AWAITING_UPLOAD` job and returns `uploadSaved: { saved, total }`. Step and action responses don't, so polling never queries GCS while a `PUT` is in flight. A failed lookup leaves `uploadSaved` null, and the prompt drops the percentage. `uploadProgress` stays YouTube's.
- **Browser:** `XMLHttpRequest`, for `upload.onprogress`. G1 showed that Chromium, Firefox and WebKit all return the `308` to script (no `Location`, so it's not followed) and can read `Range` cross-origin under the bucket's existing CORS.
- **Progress:** live `onprogress` while sending. After a pause, the bar resets to the confirmed offset.

## R4 · Pause and resume

- **Pause:**
  - Status 0 (network) and `408`, `429` and `5xx` replies pause the upload.
  - So does a 60 s stall with no progress event. The stall timer stops once `loaded === total`, while GCS finalizes.
  - A pause never fails the job (constitution III).
- **Resume triggers:** the `online` event, `visibilitychange` to visible, or a backoff timer (1 s doubling to a 60 s cap). Retries never stop while the app is open.
- **Status 0 always means back off.** A lossy link reports it constantly, and G1 ruled out a CORS cause.
- **Session unusable (`404`, `410`, `412`, `499`):** call `upload-session` with `renew: true`. It answers with a new session (start from 0, FR-011 message) or the matching 409 reason (replaced, discarded, already done).
- **Any other `4xx`:** stop with the error. The job stays `AWAITING_UPLOAD` so a re-pick can retry.
- **`409` from `upload-session`:** stop and release the lock (R8). "Replaced" shows the file prompt; "discarded" and "already done" re-fetch the job view.
- **Overlap is safe:** GCS ignores bytes at offsets it already saved.

## R5 · Same file or new file

- **Fingerprint:** SHA-256 over `size ‖ first 1 MiB ‖ last 1 MiB`, hex.
  - It uses `crypto.subtle.digest` on `File.slice`, so it reads 2 MiB.
  - It's computed on the home page before create.
- **On re-pick:**
  - The page recomputes the fingerprint and the server compares.
  - **Match:** the server returns the session.
  - **No match:** a new upload. The server checks the create caps, creates a new session, swaps it in (R6), then cancels the old one (R10). It replaces `videoUpload`, `filename` and `contentType`.
- **Rationale:** the Android photo picker can return a different name or `lastModified` for the same video, so metadata isn't identity. A whole-file hash means reading 2 GB before every resume.
- **Why the old partial isn't kept:**
  - Both sessions target the job's one object, `uploads/<jobId>`. Whichever finishes last would overwrite the other, so a stale tab could replace the new video.
  - Keeping it resumable would mean one object per file and choosing between them. YAGNI.

## R6 · Where the session lives

- **Decision:** `JobDoc.videoUpload = { sessionUri, size, fingerprint } | null` in `jobs.data` (jsonb). No migration. The type is `JobDoc.contentType`, which a new file replaces.
  - It's cleared when the job leaves `AWAITING_UPLOAD`, and on discard.
  - It's never in `toPublic`.
  - Named `videoUpload` so it can't be confused with a Short's `sourceObject` or the YouTube `upload` session.
- **A pick the user makes always wins.** It swaps unconditionally (`WHERE state = 'AWAITING_UPLOAD'`), then cancels the session it replaced. Newest pick wins.
- **Automatic renews swap conditionally.** A `renew: true` call sends the `sessionUri` it was using (`prev`) and swaps only `WHERE state = 'AWAITING_UPLOAD' AND data->'videoUpload'->>'sessionUri' = prev`. Then it cancels the old session.
  - If no row matches, a newer pick won. The server cancels the session it just made and returns 409 "A different video replaced this upload."
  - `prev` is never null in a condition: a tab without a session URI is always making a pick.
  - So a stale tab can't take the upload back automatically, and two renews can't both win.
- **Already landed:** `upload-session` checks `objectInfo` first and returns 409 "This upload is already done." when the object exists.
- **How the browser gets it:** only from `create` and from `POST /api/jobs/{id}/upload-session`, behind `authorizedJob`, and only with a matching fingerprint (or as part of a new upload).
- **Why it's hidden:** the URI is a bearer credential (GCS: it "acts as an authentication token"). For 7 days, anyone holding it can write that job's video without signing in.
  - A leaked URI could swap the video before analysis or publish.
  - It could also fill the bucket.
  - The owner's browser needs it, so the owner gets it. Nobody else does, including Sentry and logs.
- **Alternatives:** `localStorage`. It's lost with site data and keeps a credential in browser storage. Rejected.

## R7 · Size cap

- **Decision:** the session declares `contentLength` = the size checked at create (≤ 2 GB).
- **Evidence (G1):** GCS rejects any final size that doesn't match the declared length, with `400` "does not match the expected size".
- **Consequence:** no extra server-side size check at landing. Today's `x-goog-content-length-range` applies only to a single signed `PUT`, so it goes away with `signedUploadUrl`.

## R8 · One sending tab

- **Decision:** take the lock when a file is picked, with `navigator.locks.request('upload:' + jobId, { ifAvailable: true }, …)`. Only the holder calls `upload-session` and sends. Web Locks is Baseline in every current browser.
  - A tab that doesn't get it shows "Uploading in another tab" and queues a normal lock request (not `ifAvailable`) with an `AbortSignal`. Leaving the page aborts it.
  - The holder releases the lock when the upload finishes, on a 409 stop, on discard, or when its tab closes.
  - When a queued request is granted, the tab re-fetches the job view first, then shows whatever it says (analysis, discarded, or the file prompt).
  - Locks only cover one browser profile. Across devices and app addresses, the newest pick wins (R6).

## R9 · Keep running across the app

- **Decision:** the uploader is a module-level store in `src/lib/upload.ts`, not owned by the job page. SvelteKit's client-side navigation keeps it alive, so moving between pages doesn't stop it. The home page hands the picked file and session to it directly, replacing `pending.ts`.
- **The job page:** subscribes to the store for progress and the away message.
- **Away:** the store is alive, the page becomes visible (`visibilitychange` or `resume`), and no progress arrived while hidden. Then the page shows FR-006 and resumes.
- **On a fresh page load:** the store is empty and there's no file. That's FR-008 and FR-009, not "away": a user reload and a killed tab look the same.
- **Monitor:** the job page builds a new object URL from `store.file` on return, so the local preview survives in-app navigation. On a re-pick, it measures `durationSec` through the Monitor before calling `upload-session`.

## R10 · Discard and replace

- **Discard order:**
  1. Move the job to `DISCARDED`.
  2. `DELETE` the session URI. Failures are ignored; `404`, `410` and `499` count as done.
  3. Only if the job was `AWAITING_UPLOAD` with `videoUpload` set: if the object exists anyway (a final `PUT` raced the cancel), delete it. A finished upload's video is never deleted here; a Short may be cutting from it.
  4. Clear `videoUpload`.
  - The page's discard action calls `uploader.stop(jobId)`, so its own request aborts at once.
  - Other tabs get 409 "This job was discarded." from `upload-session` and stop.
- **Replace and renew:** the new session is swapped in first, then the old one is cancelled.
- **Rationale:** a cancelled session can't finish, and a late landing is deleted. No bytes pass through the app.

## R11 · Sentry

- `scrubUrl` already strips the query from every URL in breadcrumbs, spans and events, and that query is where the session's `upload_id` lives.
- Breadcrumbs: `upload paused` and `upload resumed`, with `{ saved, total, reason }`.

## R12 · Tests: only what can break

- **Unit:**
  - Offset parsing and the next action for each reply (308 with or without `Range`, 200/201, 0, 5xx, 404/410, other 4xx).
  - Fingerprint input bytes.
  - The `upload-session` decisions: match, new file (unconditional, old session cancelled), over caps, another user's job, already landed, discarded, renew with stale `prev` (409, new session cancelled), renew cancels the old session.
  - The finalize case (offset equals size, with its backoff cap) and the stall timer pausing at 100%.
  - Discard order: a late-landed object is deleted only for an unfinished upload, never for a finished one.
  - `sessionUri` never appearing in `JobView`.
- **E2E (a fake GCS session server, with `page.route` aborting requests to simulate drops; see plan):**
  - Drops then finish.
  - Reload, then the same file resumes.
  - A different file restarts.
  - Navigating within the app keeps sending.
  - A second tab waits, then takes over with the re-pick prompt.
- **Not tested:**
  - GCS's own behavior (proven once in G1).
  - Browser APIs we only call (Web Locks, `crypto.subtle`).

## R13 · Gate G1 (constitution V): ran 2026-10-22

Desktop, against the real bucket, from origin `http://localhost:5173` (in bucket CORS). Results are in `quickstart.md`.

Follow-ups, both done 2026-10-22 (results in `quickstart.md`):

- `ifGenerationMatch: 0` is enforced at finalize (412), not at session creation.
- A session made for one allowed origin works from another allowed origin, so the origin isn't stored and status 0 never triggers a renew.

## R14 · Background upload: dropped

- **Background Fetch is the only web API that keeps uploading after the tab is gone, and it exists only in Chromium browsers.** MDN marks it not Baseline, with no Firefox or Safari support. That fails FR-016.
- **Chrome's own launch post said it took no request bodies and no CORS preflight.** Every upload here needs both.
- **What remains:** R9 (keep sending across the app while the tab lives), plus FR-006 when a hidden tab comes back.
- **A true background upload needs an installed app.** That's out of scope.
