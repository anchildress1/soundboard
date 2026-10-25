# Contract: upload session

The session URI is a bearer credential (research R6). It appears only in the responses marked **Carries the URI**, never in a request, `JobView`, page data, an error message, a log or a trace. Requests name a session by its `generation`.

Each session writes its own object, `uploads/<jobId>/<objectId>` (`objectId`: 16 random bytes, base64url). `job.object` names the current one (research R1).

## `POST /api/jobs` (changed)

Called by `/new` (`createJob` in `src/lib/api.ts`). The request body adds `fingerprint` (64 lowercase hex characters, research R5). The response becomes `{ id, sessionUri, generation: 1 }` (today: `{ id, uploadUrl }`). **Carries the URI.**

- Song title and notes are checked as today; the file through `parseMedia` (research R7).
- The session is created for a new object with origin, content type and size, then encrypted, before the job is stored with that `object`. A failure stores no job.
- A bad fingerprint returns 400 alongside today's checks.

## `POST /api/jobs/{id}/upload-session` (new)

Owner-only through `authorizedJob` (and RLS), so another user's job returns 404. Each call reads the job, does its GCS and KMS work outside any transaction, and commits with one conditional `UPDATE` on the generation it read (research R6). No row means something newer committed: a session it made is cancelled, and the reply is for the job as it is now.

One JSON body per op:

```text
{ "op": "pick", "opId": "<random>", "size": 123, "fingerprint": "<64 hex>", "filename": "…", "contentType": "video/mp4", "durationSec": 180 }
{ "op": "renew", "opId": "<random>", "generation": 4, "fingerprint": "<64 hex>" }
{ "op": "confirm", "generation": 4, "fingerprint": "<64 hex>" }
```

- `pick` is a file the user chose. Only the tab holding the Web Lock sends it (research R8). It bumps the generation.
- `renew` is the uploader recovering on its own after a `404`, `410` or `499` from GCS. The new session uses the stored size and `contentType`.
- `confirm` is a read. Senders send it before every attempt and every 30 s while a `PUT` is in flight.
- `opId` is stable across one request's retries. The server keeps the last 20 applied `{ opId, generation, restarted }` in `videoUpload.ops`.

Checks run in this order.

| Response | Body                                                           | When                                                                                                                                                        |
| -------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 404      | —                                                              | Not the caller's job.                                                                                                                                       |
| 400      | `{ message }`                                                  | Malformed body: unknown `op`, missing `opId` or `generation`, bad fingerprint.                                                                              |
| 409      | `{ message: "This job was discarded." }`                       | The job is `DISCARDED`. Repeats any owed discard cleanup first (research R10).                                                                              |
| 409      | `{ message: "This upload is already done." }`                  | The job has left `AWAITING_UPLOAD`, or `job.object` already landed.                                                                                         |
| 200      | `{ sessionUri, generation, restarted }`                        | `pick` or `renew` whose `opId` is in `ops` at the current generation: already applied, nothing changes; `restarted` as recorded. **Carries the URI.**       |
| 409      | replaced or moved (below)                                      | `pick` or `renew` whose `opId` is in `ops` at a stale generation: superseded, nothing changes.                                                              |
| 200      | `{ sessionUri, generation, restarted: false }`                 | `pick` whose size and fingerprint match: the current session, generation bumped. **Carries the URI.**                                                       |
| 400      | `{ message }`                                                  | `pick` of a different file that fails `parseMedia`. Nothing changes.                                                                                        |
| 200      | `{ sessionUri, generation, restarted: true }`                  | `pick` of a different file that passes: a session for a new object committed, generation bumped, then the displaced session cancelled. **Carries the URI.** |
| 200      | `{ sessionUri, generation, restarted: true }`                  | `renew` from the current generation: a session for a new object committed, generation bumped, old session cancelled. **Carries the URI.**                   |
| 200      | `{ current: true }`                                            | `confirm` from the current generation.                                                                                                                      |
| 409      | `{ message: "A different video replaced this upload." }`       | `renew`, `confirm`, or a `pick` that lost the commit race, whose `fingerprint` differs from the current one.                                                |
| 409      | `{ message: "The upload moved to another device or window." }` | The same, with the current `fingerprint` (the same file, picked elsewhere).                                                                                 |

If gate G2 fails, a `pick` whose fingerprint matches gets a session for a new object, like a different file, with `restarted: true` (research R13).

## Server ↔ GCS and KMS

No call runs inside a database transaction. Each has an explicit deadline; inside a step, the smaller of it and the step's remaining deadline.

| Call                                                  | When                                                           | Deadline       | Notes                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Create session (`createResumableUpload`, JSON API)    | create, pick of a new file, renew                              | 10 s           | `origin`, `contentType`, `contentLength`; a new object name each time                                                             |
| KMS `encrypt` / `decrypt`                             | after create; pick, renew, status, cancel                      | 5 s            | `core/kms.ts`, gax `timeout`                                                                                                      |
| Status query (`PUT`, `Content-Range: bytes */<size>`) | job page server load for `AWAITING_UPLOAD`                     | 5 s            | fills page data `uploadSaved`; no media; a failure leaves it null                                                                 |
| Cancel (`DELETE` session URI)                         | after a swap or renew commits; discard of an unfinished upload | 5 s, one retry | `2xx`, `404`, `410`, `499` count as done; after a swap a failure leaves an orphan at worst; on discard it leaves the cleanup owed |
| `objectInfo(job.object)`                              | completion, pick, renew; discard, before its commit            | 5 s            | today's `exists` + `getMetadata`; a failed read on discard answers 503 and changes nothing                                        |
| Prefix sweep (`getFiles({ prefix })` + `delete` each) | after completion; on discard                                   | 10 s           | `uploads/<jobId>/`; keeps the named object; best effort                                                                           |

## Browser ↔ GCS (session URI)

All requests are `XMLHttpRequest` from the app origin. JSON API endpoints answer CORS for any origin (research R1), so these work from every app address; bucket CORS doesn't apply. G1 confirmed them in Chromium, Firefox and WebKit.

| Request                                                           | Reply                                                    | Uploader does                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PUT` empty, `Content-Range: bytes */<size>` (15 s timeout)       | `308` + `Range: bytes=0-N`, `N+1 < size`                 | Send from `N+1`.                                                                                    |
|                                                                   | `308` + `Range` covering every byte                      | Not documented: pause, back off, query again.                                                       |
|                                                                   | `308`, no `Range`                                        | Send from 0.                                                                                        |
|                                                                   | `200`/`201`                                              | Done: release the lock, call the step endpoint.                                                     |
| `PUT` `file.slice(o)`, `Content-Range: bytes <o>-<size-1>/<size>` | `200`/`201`                                              | Done.                                                                                               |
|                                                                   | 60 s without progress, or 60 s without a reply once sent | Abort, pause "no connection", status query (research R4).                                           |
| Any                                                               | status 0, `408`, timeout                                 | Pause "no connection", back off, then status query.                                                 |
| Any                                                               | `429`, `5xx`                                             | Pause "storage busy, retrying", back off, then status query.                                        |
| Any                                                               | `404`, `410`, `499`                                      | `upload-session` `renew` with `generation` and a new `opId`.                                        |
| Any                                                               | other `4xx`                                              | Stop and show the message. The job stays `AWAITING_UPLOAD`.                                         |
| `upload-session` (10 s timeout)                                   | status 0, `5xx`, timeout                                 | Pause, back off, resend the same body (same `opId`). A failed `confirm` pauses any `PUT` in flight. |
| `upload-session`                                                  | `409`                                                    | Abort any `PUT`, stop, release the lock. Replaced or moved: file prompt. Others: re-fetch the view. |

## Page states

This is the canonical list (spec FR-010). `n` is `floor(saved / total × 100)`, from what GCS confirmed after a pause.

| State                                           | Text                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sending                                         | `Uploading n%`                                                                           |
| Network pause (status 0, stall, `408`, timeout) | `Upload paused: no connection`                                                           |
| Storage busy (`429`, `5xx`)                     | `Upload paused: storage busy, retrying` (at the confirmed amount)                        |
| Hidden tab back, nothing sent while hidden      | "The upload paused while you were away." (until bytes flow)                              |
| No file in this tab                             | `Upload paused at n%. Pick the video to continue.` + file input (`n` from `uploadSaved`) |
| No file, saved amount unknown                   | "Pick the video to continue." + file input                                               |
| No file, upload already complete                | none: the page drives the step and moves on                                              |
| Picked file can't be read                       | "Couldn't read this video. Pick it again." + file input                                  |
| New file picked                                 | "New video: starting the upload over."                                                   |
| Another tab sending                             | "Uploading in another tab"                                                               |
| Session renewed                                 | "The saved upload expired; starting again."                                              |
| Replaced elsewhere                              | "A different video replaced this upload." + file input                                   |
| Same file picked elsewhere                      | "The upload moved to another device or window." + file input                             |
| Discarded elsewhere                             | "This job was discarded."                                                                |

The working screen for `AWAITING_UPLOAD` shows a Discard button while the upload runs, is paused, waits on another tab, or waits for a pick (US4). Its copy (`workCopy` in `src/lib/release.ts`) changes with FR-005:

| Field | Text                                                                             |
| ----- | -------------------------------------------------------------------------------- |
| Title | "Uploading your video" (unchanged)                                               |
| Body  | "Keep this tab open until the upload finishes. Other pages in the app are fine." |
