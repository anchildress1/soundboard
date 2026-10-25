# Contract: upload session

The session URI is a bearer credential (research R6). It appears only in the two responses marked below, never in a request, `JobView`, page data, an error message, a log or a trace. Requests name a session by its `generation`.

## `POST /api/jobs` (changed)

Called by `/new` (`createJob` in `src/lib/api.ts`). The request body adds `fingerprint` (64 lowercase hex characters, research R5). The response becomes `{ id, sessionUri, generation: 1 }` (today: `{ id, uploadUrl }`). **Carries the URI.**

- Song title and notes are checked as today; the file through `parseMedia` (research R7).
- The session is created with origin, content type, size, `metadata.uploadGeneration: "1"` and `ifGenerationMatch: 0`, then encrypted, before the job is stored. A failure stores no job.
- A bad fingerprint returns 400 alongside today's checks.

## `POST /api/jobs/{id}/upload-session` (new)

Owner-only through `authorizedJob` (and RLS), so another user's job returns 404. Every call runs in one transaction that row-locks the job (research R6).

One JSON body per op:

```text
{ "op": "pick", "size": 123, "fingerprint": "<64 hex>", "filename": "…", "contentType": "video/mp4", "durationSec": 180 }
{ "op": "renew", "generation": 4, "fingerprint": "<64 hex>", "opId": "<random, stable across retries>" }
{ "op": "confirm", "generation": 4, "fingerprint": "<64 hex>" }
```

- `pick` is a file the user chose. Only the tab holding the Web Lock sends it (research R8). It always wins and always bumps the generation.
- `renew` is the uploader recovering on its own after a `404`, `410`, `412` or `499` from GCS. The new session uses the stored size and `contentType`.
- `confirm` is a read. Senders send it before every attempt and every 30 s while a `PUT` is in flight.

Checks run in this order.

| Response | Body                                                           | When                                                                                                                                                 |
| -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 404      | —                                                              | Not the caller's job.                                                                                                                                |
| 400      | `{ message }`                                                  | Malformed body: unknown `op`, missing `generation` or `opId`, bad fingerprint.                                                                       |
| 409      | `{ message: "This job was discarded." }`                       | The job is `DISCARDED`. Repeats any unfinished discard cleanup first (research R10).                                                                 |
| 409      | `{ message: "This upload is already done." }`                  | The job has left `AWAITING_UPLOAD`, or an object stamped with the current `sessionGeneration` already landed.                                        |
| 200      | `{ sessionUri, generation, restarted: false }`                 | `pick` whose size and fingerprint match: the current session, generation bumped. **Carries the URI.**                                                |
| 400      | `{ message }`                                                  | `pick` of a different file that fails `parseMedia`. Nothing changes.                                                                                 |
| 200      | `{ sessionUri, generation, restarted: true }`                  | `pick` of a different file that passes: new session swapped in, generation bumped, then the displaced session cancelled. **Carries the URI.**        |
| 200      | `{ sessionUri, generation, restarted: true }`                  | `renew` whose `opId` equals the stored `renewOp.opId` while `renewOp.generation` is still current: the stored result, replayed. **Carries the URI.** |
| 200      | `{ sessionUri, generation, restarted: true }`                  | `renew` whose `generation` is current: new session swapped in, generation bumped, `renewOp` stored, old session cancelled. **Carries the URI.**      |
| 200      | `{ current: true }`                                            | `confirm` whose `generation` is current.                                                                                                             |
| 409      | `{ message: "A different video replaced this upload." }`       | `renew` or `confirm` from a stale generation whose `fingerprint` differs from the current one. A session just made is cancelled.                     |
| 409      | `{ message: "The upload moved to another device or window." }` | `renew` or `confirm` from a stale generation with the current `fingerprint` (the same file, picked elsewhere).                                       |

## Server ↔ GCS

| Call                                                  | When                                                                               | Notes                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Create session (`createResumableUpload`, JSON API)    | create, pick of a new file, renew                                                  | `origin`, `contentType`, `contentLength`, `metadata.uploadGeneration`, `preconditionOpts: { ifGenerationMatch: 0 }`         |
| Status query (`PUT`, `Content-Range: bytes */<size>`) | job page server load for `AWAITING_UPLOAD`                                         | fills page data `uploadSaved`; no media; 5 s timeout; a failure leaves it null. Gate G2.1                                   |
| Cancel (`DELETE` session URI)                         | after any swap, and on discard                                                     | `404`, `410`, `499` count as done; 5 s timeout; one retry; on discard a failure leaves `videoUpload` set for the next touch |
| Object metadata (`getMetadata`)                       | completion, pick, renew, discard                                                   | `metadata.uploadGeneration` tells the current pick's object from a stale one. Gate G2.2                                     |
| Delete object                                         | stale-generation object at completion; discard of a job that was `AWAITING_UPLOAD` | never for a job that had moved to `PREP` or later                                                                           |

## Browser ↔ GCS (session URI)

All requests are `XMLHttpRequest` from the app origin. JSON API endpoints answer CORS for any origin (research R1), so these work from every app address; bucket CORS doesn't apply. G1 confirmed them in Chromium, Firefox and WebKit.

| Request                                                           | Reply                                    | Uploader does                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PUT` empty, `Content-Range: bytes */<size>`                      | `308` + `Range: bytes=0-N`, `N+1 < size` | Send from `N+1`.                                                                                    |
|                                                                   | `308` + `Range` covering every byte      | Not documented: pause, back off, query again.                                                       |
|                                                                   | `308`, no `Range`                        | Send from 0.                                                                                        |
|                                                                   | `200`/`201`                              | Done: release the lock, call the step endpoint.                                                     |
| `PUT` `file.slice(o)`, `Content-Range: bytes <o>-<size-1>/<size>` | `200`/`201`                              | Done.                                                                                               |
|                                                                   | no reply 60 s after the body is sent     | Abort, pause, status query (research R4).                                                           |
| Any                                                               | status 0, `408`, stall                   | Pause "no connection", back off, then status query.                                                 |
| Any                                                               | `429`, `5xx`                             | Pause "storage busy, retrying", back off, then status query.                                        |
| Any                                                               | `404`, `410`, `412`, `499`               | `upload-session` `renew` with `generation` and a new `opId`.                                        |
| Any                                                               | other `4xx`                              | Stop and show the message. The job stays `AWAITING_UPLOAD`.                                         |
| `upload-session`                                                  | status 0, `5xx`, timeout                 | Back off, retry the same body (same `opId`).                                                        |
| `upload-session`                                                  | `409`                                    | Abort any `PUT`, stop, release the lock. Replaced or moved: file prompt. Others: re-fetch the view. |

## Page states

This is the canonical list (spec FR-010). `n` is `floor(saved / total × 100)`, from what GCS confirmed after a pause.

| State                                      | Text                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Sending                                    | `Uploading n%`                                                                           |
| Network pause (status 0, stall, `408`)     | `Upload paused: no connection`                                                           |
| Storage busy (`429`, `5xx`)                | `Upload paused: storage busy, retrying` (at the confirmed amount)                        |
| Hidden tab back, nothing sent while hidden | "The upload paused while you were away." (until bytes flow)                              |
| No file in this tab                        | `Upload paused at n%. Pick the video to continue.` + file input (`n` from `uploadSaved`) |
| No file, saved amount unknown              | "Pick the video to continue." + file input                                               |
| No file, upload already complete           | none: the page drives the step and moves on                                              |
| New file picked                            | "New video: starting the upload over."                                                   |
| Another tab sending                        | "Uploading in another tab"                                                               |
| Session renewed                            | "The saved upload expired; starting again."                                              |
| Replaced elsewhere                         | "A different video replaced this upload." + file input                                   |
| Same file picked elsewhere                 | "The upload moved to another device or window." + file input                             |
| Discarded elsewhere                        | "This job was discarded."                                                                |

The working screen for `AWAITING_UPLOAD` shows a Discard button while the upload runs or is paused (US4). Its copy (`workCopy` in `src/lib/release.ts`) changes with FR-005:

| Field | Text                                                                             |
| ----- | -------------------------------------------------------------------------------- |
| Title | "Uploading your video" (unchanged)                                               |
| Body  | "Keep this tab open until the upload finishes. Other pages in the app are fine." |
