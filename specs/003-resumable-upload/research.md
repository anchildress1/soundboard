# Research: Resumable video upload

Checked 2026-10-22 against:

- the GCS resumable-upload docs (concept, how-to, JSON API how-to, XML header reference)
- MDN's Background Fetch compatibility data
- the installed `@google-cloud/storage` types

Gate G1 ran the same day on the real bucket (see `quickstart.md`).

Re-checked 2026-10-25 against `main` at `fcee227` (spec 002 Gemini swap, UI v2 guided release): the pick moved from the home page to `/new`, the E2E model fake is now an in-process `fetch` preload, and the job page's load already returns load-only facts (`expired`, `playbackUrl`) beside the view.

Revised twice on 2026-10-25 after review, with the owner's decisions:

- **One object per session** (revision 2). Each session writes its own object, `uploads/<jobId>/<objectId>`, and the job records which one is current. A stale or forgotten session can only finish its own orphan, never overwrite or race the current upload. That removed `ifGenerationMatch`, the `uploadGeneration` object metadata, pending-cancel state and most of gate G2.
- The session URI is KMS-encrypted at rest, like refresh tokens. Requests name a session by its `generation`, never by its URI.
- A per-job `generation` counter makes "newest pick wins" hold across tabs, devices and app addresses. Picks and renews carry an `opId`, so a retried request never takes ownership back.
- No GCS or KMS call runs while a job row is locked. Every write is a conditional `UPDATE` on the generation.
- Every network call, server and browser, has an explicit deadline that routes into recovery.
- The fingerprint samples the file densely. A file that differs only between samples is accepted as the same file.
- Storage `429`/`5xx` gets its own paused text.
- GCS documents completion only as `200`/`201`, so no 308-finalize loop.
- The session URI is not origin-bound (R1).

## R1 · Transport

- **Decision:** a GCS **JSON API** resumable session per pick, each for its own object.
  - The server creates it with `bucket().file('uploads/<jobId>/<objectId>').createResumableUpload({ origin, metadata: { contentType, contentLength: size } })`. `objectId` is 16 random bytes, base64url. The installed SDK (8.2.0, `resumable-upload.js`) posts to `<apiEndpoint>/upload/storage/v1/b/<bucket>/o?uploadType=resumable`, the JSON API, and sends `origin` as the `Origin` header.
  - The job's existing `object` field holds the current session's object name. Every reader already reads `job.object` (plan, "Readers of the upload object"), so nothing downstream changes.
  - The browser `PUT`s the bytes straight to the session URI.
- **Why one object per session:** with one shared name, an old session that finalizes late can overwrite or race the newest file, and every fix needs preconditions, metadata and cleanup state. With unique names, an old session can only write an orphan. The job ignores it, and a prefix sweep or the lifecycle rule removes it (R10). The name is random, not the generation, so two concurrent picks never target the same name.
- **CORS and security:**
  - Google's CORS page says JSON API endpoints always allow CORS and return default CORS headers whatever the bucket's configuration is. Only XML API endpoints follow bucket CORS.
  - So **bucket CORS does not restrict the session URI**. Anyone holding it can write that object from any origin. The URI is the whole security boundary: it's KMS-encrypted at rest (R6), given only to the owner, and never logged.
  - The resumable how-to asks for an `Origin` header on the initiation when CORS is in play, and G1 saw no CORS headers on a session created without one. So `origin` stays: it's what makes the browser's `PUT`s readable, not an allowlist.
  - Bucket CORS still governs the XML API: the signed `GET` the Monitor and ffmpeg read. Its `PUT` method and `x-goog-content-length-range` header served only the signed `PUT` this feature removes, so both leave the CORS file.
- **Rationale:**
  - Media bytes never touch the app.
  - The SDK already in the repo creates it, so there's no new dependency.
- **Alternatives:**
  - One shared object name with `ifGenerationMatch` and generation metadata (revision 1). Rejected: each race needed its own patch.
  - The browser starts the session through a signed XML API `POST`. Rejected: a second protocol, and the URI stays a bearer credential either way.
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
- **When (browser):** before every attempt (start, resume, re-pick), and only while this tab has no `PUT` in flight. XHR `timeout` 15 s; a timeout is a pause (R4).
- **A `308` whose `Range` already covers every byte:** Google doesn't document it; completion is documented only as `200`/`201`. The uploader treats it like any other unfinished answer: pause, back off, status query again.
- **Server-side lookup:** only the job page's server load (`jobs/[id]/+page.server.ts`), for an `AWAITING_UPLOAD` job. KMS decrypt and the query each have a 5 s deadline (constitution III). It returns `uploadSaved: { saved, total, done }` in page data beside `view`, never in `JobView`. Step and action responses don't query. A failed lookup leaves `uploadSaved` null, and the prompt drops the percentage. `uploadProgress` stays YouTube's.
  - It can run while another tab or device has a `PUT` in flight. That is covered by gate G2 (R13). If it disturbs the active `PUT`, the sender sees an error, pauses, queries and resumes (R4), so no extra design hangs on it.
- **`done: true`:** the page doesn't ask for the file. It drives the step endpoint, which moves the job on (R6, completion). That keeps today's "reopened after the upload landed" recovery.
- **Browser:** `XMLHttpRequest`, for `upload.onprogress`. G1 showed that Chromium, Firefox and WebKit all return the `308` to script and can read `Range` cross-origin.
- **Progress:** live `onprogress` while sending. After a pause, the bar resets to the confirmed offset.

## R4 · Pause and resume

- **Pause:**
  - Status 0 (network), `408`, a stall, a no-reply and any request timeout pause as "no connection".
  - `429` and `5xx` pause as "storage busy, retrying".
  - **Stall:** 60 s with no progress event while the body is going out.
  - **No reply:** once the body is fully sent (`loaded === total`), a 60 s response timer starts. No reply by then aborts the `PUT` and pauses, so a lost final reply always reaches the status query.
  - A pause never fails the job (constitution III).
- **Resume triggers:** the `online` event, `visibilitychange` to visible, or a backoff timer (1 s doubling to a 60 s cap). Retries never stop while the app is open.
- **Status 0 always means back off.** A lossy link reports it constantly.
- **Session unusable (`404`, `410`, `499`):** call `upload-session` with `op: "renew"` (R6). It answers with a new session for a new object (start from 0, FR-011 message) or the 409 reason.
- **The app's own endpoint** (`pick`, `renew`, `confirm`) has a 10 s `AbortSignal.timeout`. A timeout, status 0 or `5xx` backs off and resends the same body with the same `opId`, so a lost reply is replayed, never re-run (R6).
- **Any other `4xx` from GCS:** stop with the error. The job stays `AWAITING_UPLOAD` so a re-pick can retry.
- **`409` from `upload-session`:** abort any `PUT`, stop, release the lock (R8). "Replaced" and "moved" show the file prompt; "discarded" and "already done" re-fetch the job view.
- **Overlap is safe within one session:** GCS ignores bytes at offsets it already saved (documented). Two concurrent `PUT`s of the same bytes is gate G2.

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
  - **No match:** a new upload. The server checks the media caps, creates a new session for a new object, swaps it in (R6), then cancels the displaced session (R10). It replaces `videoUpload`, `object`, `filename` and `contentType`. Song title and notes stay as stored.
- **Why the old partial isn't kept:** it would mean choosing between partial objects on a later re-pick. YAGNI. It becomes an orphan, swept (R10).

## R6 · Where the session lives, and who may send

- **Decision:** `JobDoc.videoUpload = { sessionCipher, generation, size, fingerprint, ops } | null` in `jobs.data` (jsonb), beside the existing `object`. No migration.
  - `sessionCipher` is the session URI encrypted by `encrypt()` in `src/lib/server/core/kms.ts`, the same path refresh tokens take. It's decrypted only to hand to the owner's browser and for the server's own status query and cancel.
  - `generation` is a per-job integer, 1 at create. Every pick and every renew bumps it by one. It decides who may send.
  - `ops` is the last 20 applied `{ opId, generation, restarted }` from picks and renews, so a retried request is recognized and answered as the original was.
  - It's never in `toPublic`, `JobView` or page data.
- **No network call under a row lock.** Every request reads the job, does its GCS and KMS work outside any transaction, then commits one conditional `UPDATE … WHERE id = ? AND state = 'AWAITING_UPLOAD' AND (data->'videoUpload'->>'generation')::int = <read generation> RETURNING`. No row means something newer committed first: the request cancels the session it just made (if any), re-reads, and answers for the job as it is now. Two concurrent picks: one commits, the other answers 409, and its session is cancelled. Both sessions had their own objects, so nothing collides.
- **A pick always wins over what it read.** It bumps the generation whether the file matches or not. The newest committed pick is the only sender, across tabs, devices and app addresses. A pick that lost the commit race answers "replaced" or "moved"; the user can pick again.
- **Retried requests (`opId`):** each pick and renew carries a client `opId`, stable across its retries.
  - `opId` in `ops` and its generation is current: the request already applied; return the current session, generation and the recorded `restarted`, change nothing.
  - `opId` in `ops` and its generation is stale: something newer won; 409 "replaced" or "moved", change nothing.
  - So a pick whose reply was lost can't take ownership back when it's retried after another device picked.
- **Senders confirm their generation** with `upload-session` `op: "confirm"` before every attempt and every 30 s while a `PUT` is in flight. A stale generation gets 409, and the sender aborts its `PUT` at once: "A different video replaced this upload." when the sender's fingerprint differs from the current one, "The upload moved to another device or window." when it's the same file. A confirm that times out or fails pauses the sender (R4), so it never keeps sending unconfirmed past one interval. Worst-case overlap is one 30 s interval plus one 10 s timeout. Spec FR-012 states this. It's a read: nothing is stored and nothing expires.
- **Same-file takeover reuses the session**, so for up to that overlap two senders may `PUT` identical bytes to one session. Gate G2 proves GCS accepts that cleanly. **Fallback if G2 fails:** a same-file pick from a stale generation gets a fresh session for a new object, like a new file, and starts from 0. The displaced session is cancelled, so the old sender gets `404`/`499`, renews, and stops on the stale generation.
- **Renew:** current generation → new session for a new object, generation + 1, the old session cancelled after commit. Stale → 409.
- **Completion** (`startOnceUploaded`): `objectInfo(job.object)` finds the current object, then a conditional `UPDATE` moves the job to `PREP` and clears `videoUpload` only if `object` is still that name and the state is still `AWAITING_UPLOAD`. Then a best-effort prefix sweep (R10). An orphan never moves a job on: it isn't `job.object`. A job without `videoUpload` (created by the old flow before the switch-over) follows the same rule, since its `object` is today's `uploads/<jobId>`.
- **Already landed:** a pick or renew that finds `job.object` present returns 409 "This upload is already done." and the page drives the step.
- **How the browser gets the URI:** only from `create` and from `POST /api/jobs/{id}/upload-session` (`pick`, `renew`), behind `authorizedJob` and RLS. Requests never carry it: they name a session by `generation`, so no request body, error or Sentry event holds it.
- **Why it's protected:** the URI is a bearer credential. Google: anyone holding it can upload to the bucket without further authentication, for a week. A leaked URI could fill the bucket, but with one object per session it can no longer replace the job's video. Bucket CORS doesn't limit it (R1).
- **Alternatives:**
  - Row locks around GCS and KMS calls (revision 1). Rejected: a slow dependency held the row, and SDK retry budgets run to 600 s.
  - Plain text in `jobs.data`, like the existing YouTube `upload.sessionUri`. Rejected by the owner on 2026-10-25. The YouTube session is out of this spec's scope.
  - `localStorage`. Lost with site data, and keeps a credential in browser storage. Rejected.
  - Leases, heartbeats or an acknowledged handoff for sender ownership. Rejected: the generation check bounds the overlap, and a handoff needs a reachable old sender (constitution VI).

## R7 · Size cap

- **Decision:** the session declares `contentLength` = the size checked by the media caps (≤ 2 GB).
- **Evidence (G1):** GCS rejects any final size that doesn't match the declared length, with `400` "does not match the expected size".
- **Consequence:** no extra server-side size check at landing. `x-goog-content-length-range` goes away with `signedUploadUrl`.
- **Media caps** are one validator, `parseMedia({ filename, contentType, size, durationSec })`, shared by create and a new-file pick. Create checks the song title and notes on its own. A re-pick sends no song details and keeps the stored ones.

## R8 · One sending tab, seen from every tab

- **Decision:** Web Locks, name `upload:<jobId>`. Baseline in every current browser.
  - **On page entry with no file in this tab:** `navigator.locks.query()`. If another tab holds the lock: "Uploading in another tab", no picker, and a queued normal request (not `ifAvailable`) with an `AbortSignal`. Leaving the page aborts it.
  - **On pick:** read the file first (Monitor duration with a 15 s limit, then the fingerprint). Any failure there shows "Couldn't read this video. Pick it again." and keeps the picker; no lock was taken. Then take the lock with `ifAvailable: true` **before** calling `upload-session`. No lock: "Uploading in another tab". Only the holder mutates the session or sends.
  - **`/new`:** takes the lock right after create and before navigating. No other tab knows the job yet.
  - The holder releases the lock when the upload finishes, on a 400 or 409, on discard, on `stop`, or when its tab closes.
  - When a queued request is granted, the tab re-fetches the job view first, then shows what it says: analysis, discarded, or the file prompt.
- **Across devices and app addresses** locks don't reach. There the user takes over by picking the file, and the generation (R6) stops the older sender. Within one browser profile there's no takeover button: the spec has the waiting tab take over when the sender's tab closes.

## R9 · Keep running across the app

- **Today:** leaving the job page doesn't abort the XHR (`uploadToGcs` exposes no abort), but the page that owned it is gone. Nothing shows its progress, a failure is lost, and nothing calls the step endpoint when it lands. Unloading the document does abort it.
- **Decision:** the uploader is a module-level store in `src/lib/upload.ts`, not owned by any page. SvelteKit's client-side navigation keeps it alive. The `/new` page hands the picked file and session to it directly, replacing `pending.ts`.
- **The job page** subscribes to the store for progress and the away message.
- **Away:** the store is alive, the page becomes visible (`visibilitychange` or `resume`), and no progress arrived while hidden. Then the page shows FR-006 and resumes.
- **On a fresh page load** the store is empty and there's no file. That's FR-008 and FR-009, not "away".
- **Monitor:** each page makes its own object URL from `store.file` and revokes it on destroy. On a re-pick, the page measures `durationSec` through the Monitor before calling `upload-session`; `Monitor` gains an `onerror` callback for a file it can't load.

## R10 · Discard, replace, and orphans

- **Orphans** are objects under `uploads/<jobId>/` other than `job.object`: a displaced session that finished anyway, a forgotten session whose cancel failed, an old partial's session. They never move a job on. A **prefix sweep** lists `uploads/<jobId>/` (trailing slash, so a Short render `uploads/<shortId>-<n>` never matches) and deletes every name except the one to keep. Names are never reused, so a delayed delete can't hit a newer upload. Best effort, after completion and on discard. No queue (constitution III).
- **Discard:**
  1. Read `objectInfo(job.object)` (5 s) outside any transaction. That read is the decision point: a current upload that landed by then is finished. A failed read changes nothing and answers 503 "Couldn't check the upload. Try again."
  2. One conditional `UPDATE … SET state = 'DISCARDED' WHERE state IN (DISCARDABLE) RETURNING` the state it left (a `FOR UPDATE` subquery in the same statement). Eligibility comes from that state: only a job that was `AWAITING_UPLOAD` gets upload cleanup. A job that had moved to `PREP` or later keeps its video; a Short may be cutting from it. In the same statement, when the job was `AWAITING_UPLOAD`, the read found the object landed and `object` still has the name read, `videoUpload` is cleared: that video is kept.
  3. Outside any transaction:
     - Kept: sweep the orphans, keeping `job.object`. Best effort.
     - Unfinished (`videoUpload` still set): cancel the current session (5 s, one retry), then sweep the whole prefix. Clear `videoUpload` only when the cancel is confirmed (`2xx`, `404`, `410`, `499`) and the sweep succeeded.
  4. **`DISCARDED` with `videoUpload` set means "delete everything, not done yet".** The job's next touch repeats step 3's unfinished branch: the job page load, or a late `upload-session` call, which then answers 409 "This job was discarded." Once the cancel is confirmed the current session can't write, so the next sweep is final. A displaced session whose cancel failed earlier can still finish an orphan; the lifecycle rule takes it (FR-013).
  5. A job without `videoUpload` (signed-`PUT` jobs before the switch-over) discards as today.
- **Retention:** the lifecycle rule (`gcs-lifecycle.json`: `uploads/`, age 7 days) is the backstop. Age counts from when each object was written, and Google gives no fixed delay for the deletion. So an orphan finished on a session's last day can live about 14 days plus that delay. The session's own 7 days count from its creation.
- The page's discard action calls `uploader.stop(jobId)`, so its own request aborts at once. Other senders get 409 "This job was discarded." on their next confirm and stop.
- **Replace and renew:** the new session is committed first, then the displaced one is cancelled (5 s, one retry). A failed cancel leaves an orphan at worst.

## R11 · Sentry

- `scrubUrl` already strips the query from every URL in breadcrumbs, spans and events. The session's `upload_id` lives in that query, so XHR breadcrumbs to the session URI carry no credential.
- No request body carries the URI (R6). The two responses that do are never recorded: Sentry doesn't capture response bodies, and the app never logs them.
- Breadcrumbs: `upload paused` and `upload resumed`, with `{ saved, total, reason }`.

## R12 · Tests: only what can break

- **Unit:**
  - Offset parsing and the next action for each reply (`308` with or without `Range`, `308` covering every byte, `200`/`201`, 0, `408`, `429`, `5xx`, `404`/`410`/`499`, other `4xx`).
  - The stall, no-reply and request timers, including a `PUT` that reaches 100% and never answers, and control requests that never settle.
  - Fingerprint input bytes, and the accepted changed-middle limit.
  - The `upload-session` decisions: match (generation bumped), new file (new object, displaced session cancelled), media caps, another user's job, already landed, discarded, concurrent picks, a lost pick reply retried after another pick, renew replayed by `opId`, renew from a stale generation, confirm current and stale.
  - No transaction is open while a GCS or KMS mock is pending.
  - Completion: the current object moves on; an orphan doesn't; the sweep keeps `job.object`.
  - Discard: eligibility from the transitioned state; a finished current upload is kept and orphans swept; an unfinished one is cancelled and the prefix swept.
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

- **G1, ran 2026-10-22** (`quickstart.md`): cross-origin `PUT`, readable `308`/`Range`, progress events, declared-size enforcement, partial saves, parts vs one `PUT`, `ifGenerationMatch: 0` at finalize and creation (no longer used), a session used from a second app address.
  - **Reading corrected 2026-10-25:** the second-address check shows the JSON API's default CORS, not bucket CORS deciding (R1).
- **G2, open, blocks T011 and T017.** One gate. Real dev bucket, Playwright Chromium, Firefox and WebKit: two clients `PUT` the same bytes from the same offset to one session at once, and a third sends a status query during it. Pass: the object lands once, byte-identical to the file, and each request either succeeds or fails with a status the uploader already recovers from (`308`, `200`/`201`, `4xx`/`5xx`, status 0); neither corrupts the session.
  - **If G2 fails, the fallback is fixed:** a same-file pick from a stale generation gets a fresh session for a new object and restarts from 0 (R6). The page-load status lookup stays; its disruption is only a pause (R3). Nothing else may be designed at implementation time.
- The gates dropped in revision 2 (generation metadata, post-412 status, uncorsed origin) tested machinery that no longer exists or behavior Google documents.

## R14 · Background upload: dropped

- **Background Fetch is the only web API that keeps uploading after the tab is gone, and it exists only in Chromium browsers.** MDN marks it not Baseline, with no Firefox or Safari support. That fails FR-016.
- **Chrome's own launch post said it took no request bodies and no CORS preflight.** Every upload here needs both.
- **What remains:** R9 (keep sending across the app while the tab lives), plus FR-006 when a hidden tab comes back.
- **A true background upload needs an installed app.** That's out of scope.
