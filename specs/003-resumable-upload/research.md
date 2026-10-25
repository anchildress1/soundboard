# Research: Resumable video upload

Checked 2026-10-22 against:

- the GCS resumable-upload docs (concept, how-to, JSON API how-to, XML header reference)
- MDN's Background Fetch compatibility data
- the installed `@google-cloud/storage` types

Gate G1 ran the same day on the real bucket (see `quickstart.md`).

Re-checked 2026-10-25 against `main` at `fcee227` (spec 002 Gemini swap, UI v2 guided release): the pick moved from the home page to `/new`, the E2E model fake is now an in-process `fetch` preload, and the job page's load already returns load-only facts (`expired`, `playbackUrl`) beside the view.

Revised 2026-10-25 after review, with the owner's decisions:

- The session URI is KMS-encrypted at rest, like refresh tokens. Requests name a session by its generation, never by its URI.
- A per-job `generation` counter makes "newest pick wins" hold across tabs, devices and app addresses.
- The fingerprint samples the file densely. A file that differs only between samples is accepted as the same file.
- Storage `429`/`5xx` gets its own paused text.
- The 308-means-finalize loop is gone: GCS documents completion only as `200`/`201`.
- The CORS conclusion is corrected (R1): the session URI is not origin-bound.

## R1 · Transport

- **Decision:** a GCS **JSON API** resumable session.
  - The server creates it per job with `file.createResumableUpload({ origin, metadata: { contentType, contentLength: size, metadata: { uploadGeneration } }, preconditionOpts: { ifGenerationMatch: 0 } })`. The installed SDK (8.2.0, `resumable-upload.js`) posts to `<apiEndpoint>/upload/storage/v1/b/<bucket>/o?uploadType=resumable`, the JSON API, and sends `origin` as the `Origin` header.
  - `ifGenerationMatch: 0` means "only if the object doesn't exist." G1 confirmed GCS enforces it at finalize (412), but not at session creation.
  - `uploadGeneration` is custom object metadata naming the job generation the session belongs to (R6). It lets completion tell the current pick's object from a stale one.
  - The browser `PUT`s the bytes straight to the session URI.
- **CORS and security:**
  - Google's CORS page says JSON API endpoints always allow CORS and return default CORS headers whatever the bucket's configuration is. Only XML API endpoints follow bucket CORS.
  - So **bucket CORS does not restrict the session URI**. Anyone holding it can write the object from any origin. The URI is the whole security boundary: it's KMS-encrypted at rest (R6), given only to the owner, and never logged.
  - The resumable how-to asks for an `Origin` header on the initiation when CORS is in play, and G1 saw no CORS headers on a session created without one. So `origin` stays: it's what makes the browser's `PUT`s readable, not an allowlist.
  - Bucket CORS still governs the XML API: the signed `GET` the Monitor and ffmpeg read. Its `PUT` method and `x-goog-content-length-range` header served only the signed `PUT` this feature removes, so both leave the CORS file.
- **Rationale:**
  - Media bytes never touch the app.
  - The session lives 7 days, the same as the bucket's delete rule.
  - The SDK already in the repo creates it, so there's no new dependency.
- **Alternatives:**
  - The browser starts the session through a signed XML API `POST`: the session would follow bucket CORS, but that needs `POST` in bucket CORS, an exposed `Location` and a second protocol. Rejected; the URI stays a bearer credential either way.
  - tus or Uppy with a companion server: a new service. Rejected (constitution III, VI).
  - Many signed single `PUT`s plus `compose`: temporary objects and a compose step. Rejected.

## R2 · One request for the rest, not fixed parts

- **Decision:**
  - Each attempt sends **everything not yet saved** in one `PUT`: `Content-Range: bytes <offset>-<size-1>/<size>`, body `file.slice(offset)`.
  - After any interruption, a status query gives the new offset.
- **Evidence (G1):**
  - 8 MiB parts made a 64 MiB upload 5.9× slower on a fast link (6.2 s vs 1.05 s). Each part costs about 0.65 s of commit latency at GCS.
  - An interrupted single `PUT` kept 40.6 MB of what arrived, aligned to 256 KiB.
- **Rationale:** a drop loses only what GCS hadn't saved, with no per-part tax (SC-005).
- **Alternatives:** 8 MiB parts. Rejected on the measurement.

## R3 · Offset protocol

- **Status query:** `PUT` an empty body with `Content-Range: bytes */<size>`. This is exactly what Google documents for an interrupted or uncertain upload.
  - `200` or `201`: complete.
  - `308` with `Range: bytes=0-N`: resume at `N+1`.
  - `308` without `Range`: resume at 0.
- **When (browser):** before every attempt (start, resume, re-pick), and only while this tab has no `PUT` in flight.
- **A `308` whose `Range` already covers every byte:** Google doesn't document it; completion is documented only as `200`/`201`. The uploader treats it like any other unfinished answer: pause, back off (R4), status query again. No special finalize request.
- **Server-side lookup:** only the job page's server load (`jobs/[id]/+page.server.ts`), with a 5 s timeout (a slow GCS never holds the page; constitution III), for an `AWAITING_UPLOAD` job. It returns `uploadSaved: { saved, total, done }` in page data beside `view`, never in `JobView`. Step and action responses don't query, so polling never queries GCS. A failed lookup leaves `uploadSaved` null, and the prompt drops the percentage. `uploadProgress` stays YouTube's.
  - This lookup can run while another tab or device has a `PUT` in flight. Google doesn't document a status query concurrent with an active upload, so gate G2 proves it doesn't disturb the sender before the lookup is built.
- **`done: true`:** the page doesn't ask for the file. It drives the step endpoint, which moves the job on (R6, completion). That keeps today's "reopened after the upload landed" recovery.
- **Browser:** `XMLHttpRequest`, for `upload.onprogress`. G1 showed that Chromium, Firefox and WebKit all return the `308` to script and can read `Range` cross-origin.
- **Progress:** live `onprogress` while sending. After a pause, the bar resets to the confirmed offset.

## R4 · Pause and resume

- **Pause:**
  - Status 0 (network), `408`, and a stall pause as "no connection".
  - `429` and `5xx` pause as "storage busy, retrying".
  - **Stall:** 60 s with no progress event while the body is going out.
  - **No reply:** once the body is fully sent (`loaded === total`), a 60 s response timer starts. No reply by then aborts the `PUT` and pauses, so a lost final reply always reaches the status query. That query then answers `200`/`201` (done) or `308`.
  - A pause never fails the job (constitution III).
- **Resume triggers:** the `online` event, `visibilitychange` to visible, or a backoff timer (1 s doubling to a 60 s cap). Retries never stop while the app is open.
- **Status 0 always means back off.** A lossy link reports it constantly.
- **Session unusable (`404`, `410`, `412`, `499`):** call `upload-session` with `op: "renew"` (R6). It answers with a new session (start from 0, FR-011 message) or the 409 reason.
- **The app's own endpoint fails** (status 0, `5xx`, timeout): same backoff, same request with the same `opId`, so a lost reply is replayed, never re-run (R6).
- **Any other `4xx` from GCS:** stop with the error. The job stays `AWAITING_UPLOAD` so a re-pick can retry.
- **`409` from `upload-session`:** stop and release the lock (R8). "Replaced" and "moved" show the file prompt; "discarded" and "already done" re-fetch the job view.
- **Overlap is safe:** GCS ignores bytes at offsets it already saved (documented).

## R5 · Same file or new file

- **Fingerprint (owner decision 2026-10-25):** hex SHA-256 (Web Crypto) over the concatenation of:
  1. the size, 8 bytes big-endian;
  2. the name, UTF-8, length-prefixed with 4 bytes big-endian;
  3. `lastModified`, 8 bytes big-endian;
  4. the first 1 MiB;
  5. the last 1 MiB;
  6. 64 samples of 64 KiB, sample `i` starting at `floor(i * (size - 64 KiB) / 63)`, clamped to the file.

  That reads about 6 MiB, so a re-pick still resumes within SC-003's 5 s. Slices can overlap on small files; the result is still deterministic.

- **Accepted limit:** a file that differs only between samples, with the same size, name and `lastModified`, is treated as the same file. Its saved bytes would combine with the new file's remainder. The owner accepted this over hashing up to 2 GB before every resume. A unit test documents it.
- **Side effect:** some pickers (the Android photo picker among them) can return a different name or `lastModified` for the same video. Then a re-pick starts over. That costs a restart, never a wrong video.
- **On re-pick:**
  - The page recomputes the fingerprint and the server compares, with size.
  - **Match:** the server returns the current session under a new generation (R6).
  - **No match:** a new upload. The server checks the media caps, creates a new session, swaps it in (R6), then cancels the old one (R10). It replaces `videoUpload`, `filename` and `contentType`. Song title and notes stay as stored.
- **Why the old partial isn't kept:** both sessions target the job's one object, `uploads/<jobId>`. Keeping both would mean one object per file and choosing between them. YAGNI.

## R6 · Where the session lives, and who may send

- **Decision:** `JobDoc.videoUpload = { sessionCipher, generation, sessionGeneration, size, fingerprint, renewOp } | null` in `jobs.data` (jsonb). No migration. The type is `JobDoc.contentType`, which a new file replaces.
  - `sessionCipher` is the session URI encrypted by `encrypt()` in `src/lib/server/core/kms.ts`, the same path refresh tokens take. It's decrypted only to hand to the owner's browser and for the server's own status query, cancel and cleanup.
  - `generation` is a per-job integer, 1 at create. Every pick and every renew bumps it by one, in the same statement that writes the session. It decides who may send.
  - `sessionGeneration` is the generation the current session was created at, and the `uploadGeneration` stamped on its object. A same-file pick bumps `generation` but keeps the session, so `sessionGeneration` stays.
  - `renewOp` is `{ opId, generation }` of the last renew, so a retried renew replays its result.
  - It's never in `toPublic`, `JobView` or page data.
- **Every write is serialized.** Picks, renews, completion and discard each run in one transaction that row-locks the job (`lockJob`, `SELECT … FOR UPDATE`), reads the current state and `videoUpload`, and writes. The session a swap displaces is the one it read under the lock, so two concurrent picks queue: the second reads the first's session and cancels exactly that one. No session is left live by mistake.
- **A pick always wins.** It bumps the generation whether the file matches or not. The newest pick becomes the only sender, across tabs, devices and app addresses.
- **Senders confirm their generation** with `upload-session` `op: "confirm"` before every attempt and every 30 s while a `PUT` is in flight. A stale generation gets 409, and the sender aborts its `PUT` at once: "A different video replaced this upload." when the current fingerprint differs, "The upload moved to another device or window." when it's the same file. The sender sends its own fingerprint, so the server can tell which. It's a read: no heartbeat is stored and nothing expires.
- **Renew is idempotent.** A renew carries the sender's `generation` and a client `opId`, stable across its retries.
  - `renewOp.opId` equals it and `renewOp.generation` is still the current generation: replay the stored result (current session, current generation). A pick since then makes it stale instead.
  - Else the generation still matches: create a session, bump the generation, store `renewOp`, cancel the old session.
  - Else: 409 replaced or moved; the session just made, if any, is cancelled.
- **Completion** (`startOnceUploaded`): under the lock, the job is still `AWAITING_UPLOAD` and the landed object's `uploadGeneration` metadata equals the row's `sessionGeneration`. Only then does it move to `PREP` and clear `videoUpload`.
  - An object from a stale generation (an old session that finalized before its cancel landed) is deleted, and the job stays `AWAITING_UPLOAD`. The current sender's final `PUT` then gets `412` and renews, so the newest pick is what lands.
- **Already landed:** a pick or renew that finds an object stamped with the current `sessionGeneration` returns 409 "This upload is already done." and the page drives the step.
- **How the browser gets the URI:** only from `create` and from `POST /api/jobs/{id}/upload-session` (`pick`, `renew`), behind `authorizedJob` and RLS. Requests never carry it: they name a session by `generation`, so no request body, error or Sentry event holds it.
- **Why it's protected:** the URI is a bearer credential. Google: anyone holding it can upload to the bucket without further authentication, for a week. A leaked URI could swap the video before analysis or fill the bucket. Bucket CORS doesn't limit it (R1).
- **Alternatives:**
  - Plain text in `jobs.data`, like the existing YouTube `upload.sessionUri`. Rejected by the owner on 2026-10-25. The YouTube session is out of this spec's scope.
  - `localStorage`. Lost with site data, and keeps a credential in browser storage. Rejected.
  - Leases or heartbeats for sender ownership. Rejected: the generation check is enough, and a lease needs expiry handling (constitution VI).

## R7 · Size cap

- **Decision:** the session declares `contentLength` = the size checked by the media caps (≤ 2 GB).
- **Evidence (G1):** GCS rejects any final size that doesn't match the declared length, with `400` "does not match the expected size".
- **Consequence:** no extra server-side size check at landing. `x-goog-content-length-range` goes away with `signedUploadUrl`.
- **Media caps** are one validator, `parseMedia({ filename, contentType, size, durationSec })`, shared by create and a new-file pick. Create checks the song title and notes on its own. A re-pick sends no song details and keeps the stored ones.

## R8 · One sending tab, seen from every tab

- **Decision:** Web Locks, name `upload:<jobId>`. Baseline in every current browser.
  - **On page entry with no file in this tab:** `navigator.locks.query()`. If another tab holds the lock: "Uploading in another tab", no picker, and a queued normal request (not `ifAvailable`) with an `AbortSignal`. Leaving the page aborts it.
  - **On pick:** take the lock with `ifAvailable: true` **before** calling `upload-session`. No lock: "Uploading in another tab". Only the holder mutates the session or sends.
  - **`/new`:** takes the lock right after create and before navigating. No other tab knows the job yet.
  - The holder releases the lock when the upload finishes, on a 409 stop, on discard, or when its tab closes.
  - When a queued request is granted, the tab re-fetches the job view first, then shows what it says: analysis, discarded, or the file prompt.
- **Across devices and app addresses** locks don't reach. There the user takes over by picking the file, and the generation (R6) stops the older sender. Within one browser profile there's no takeover button: the spec has the waiting tab take over when the sender's tab closes.

## R9 · Keep running across the app

- **Today:** leaving the job page doesn't abort the XHR (`uploadToGcs` exposes no abort), but the page that owned it is gone. Nothing shows its progress, a failure is lost, and nothing calls the step endpoint when it lands. Unloading the document does abort it.
- **Decision:** the uploader is a module-level store in `src/lib/upload.ts`, not owned by any page. SvelteKit's client-side navigation keeps it alive. The `/new` page hands the picked file and session to it directly, replacing `pending.ts`.
- **The job page** subscribes to the store for progress and the away message.
- **Away:** the store is alive, the page becomes visible (`visibilitychange` or `resume`), and no progress arrived while hidden. Then the page shows FR-006 and resumes.
- **On a fresh page load** the store is empty and there's no file. That's FR-008 and FR-009, not "away".
- **Monitor:** each page makes its own object URL from `store.file` and revokes it on destroy. On a re-pick, the page measures `durationSec` through the Monitor before calling `upload-session`.

## R10 · Discard and replace

- **Discard:**
  1. One transaction: lock the row, check it's discardable, move it to `DISCARDED`. Cleanup is decided from the state **this transition left**: only a job that was `AWAITING_UPLOAD` gets cleanup. A job that already moved to `PREP` or later keeps its video; a Short may be cutting from it.
  2. Cleanup: `DELETE` the session (`404`, `410`, `499` count as done), with one retry. Then delete the object if one exists. While the job was `AWAITING_UPLOAD`, nothing has read the object, whether it landed before the discard or raced the cancel.
  3. Clear `videoUpload` only when both steps are confirmed. A failed step leaves it set.
- **Best effort, by design:** there's no cleanup queue (constitution III). A discarded job that still has `videoUpload` repeats the cleanup on its next touch: its job page load, or a late `upload-session` call, which answers 409 "This job was discarded." either way. Anything left is deleted by the bucket's 7-day lifecycle rule, the same week the session expires.
- The page's discard action calls `uploader.stop(jobId)`, so its own request aborts at once. Other senders get 409 "This job was discarded." on their next confirm and stop.
- **Replace and renew:** the new session is swapped in under the lock, then the displaced one is cancelled.

## R11 · Sentry

- `scrubUrl` already strips the query from every URL in breadcrumbs, spans and events. The session's `upload_id` lives in that query, so XHR breadcrumbs to the session URI carry no credential.
- No request body carries the URI (R6). The two responses that do are never recorded: Sentry doesn't capture response bodies, and the app never logs them.
- Breadcrumbs: `upload paused` and `upload resumed`, with `{ saved, total, reason }`.

## R12 · Tests: only what can break

- **Unit:**
  - Offset parsing and the next action for each reply (`308` with or without `Range`, `308` covering every byte, `200`/`201`, 0, `408`, `429`, `5xx`, `404`/`410`/`412`/`499`, other `4xx`).
  - The stall and no-reply timers, including a `PUT` that reaches 100% and never answers.
  - Fingerprint input bytes, and the accepted changed-middle limit.
  - The `upload-session` decisions: match (generation bumped), new file (old session cancelled), media caps, another user's job, already landed, discarded, concurrent picks, renew replayed by `opId`, renew from a stale generation, confirm current and stale.
  - Completion: a current-generation object moves to `PREP`; a stale one is deleted.
  - Discard: eligibility from the transitioned state; a finished upload is never touched; failed cleanup leaves `videoUpload` for the next touch.
  - The session URI never appears in `JobView`, page data, a thrown message or a Sentry mock call.
- **E2E (a fake GCS session server, with `page.route` aborting requests to simulate drops; see plan):**
  - Drops then finish.
  - Reload, then the same file resumes.
  - A different file restarts.
  - Navigating within the app keeps sending.
  - A second tab opened with no file shows "Uploading in another tab", then takes over with the re-pick prompt.
  - A second browser context picking the same job stops the first sender.
  - Discard mid-upload stops sending and leaves no object.
- **Not tested:** GCS's own documented behavior, and browser APIs we only call (Web Locks, `crypto.subtle`).

## R13 · Gates (constitution V)

- **G1, ran 2026-10-22** (`quickstart.md`): cross-origin `PUT`, readable `308`/`Range`, progress events, declared-size enforcement, partial saves, parts vs one `PUT`, `ifGenerationMatch: 0` at finalize (412) and not at creation, a session used from a second app address.
  - **Reading corrected 2026-10-25:** the second-address check shows the JSON API's default CORS, not bucket CORS deciding (R1).
- **G2, open, blocks T007 and T013.** Real dev bucket, desktop Chromium, Firefox and WebKit:
  1. A status query sent while another client's `PUT` is in flight returns `308` with a `Range` no further than what was sent, and the in-flight `PUT` still completes `200`.
  2. A session created with custom `metadata.uploadGeneration` lands an object that carries it (`getMetadata().metadata.uploadGeneration`).
  3. After another writer lands the object, the session's next status query answers `412`, `404` or `410`: the uploader's renew path, not a stop.
  4. A session used from an origin **not** in bucket CORS (`http://localhost:5199`) still works, confirming R1's model.
- If G2.1 fails, the job page load stops querying while a sender may be active, and `uploadSaved` comes only from the sender. If G2.2 fails, completion compares the object's size and the session's creation time instead. If G2.3 fails, the stop path takes the observed status. Record results in `quickstart.md`.

## R14 · Background upload: dropped

- **Background Fetch is the only web API that keeps uploading after the tab is gone, and it exists only in Chromium browsers.** MDN marks it not Baseline, with no Firefox or Safari support. That fails FR-016.
- **Chrome's own launch post said it took no request bodies and no CORS preflight.** Every upload here needs both.
- **What remains:** R9 (keep sending across the app while the tab lives), plus FR-006 when a hidden tab comes back.
- **A true background upload needs an installed app.** That's out of scope.
