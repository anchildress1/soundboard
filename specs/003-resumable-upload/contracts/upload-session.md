# Contract: upload session

## `POST /api/jobs` (changed)

The request body adds `fingerprint` (64 hex characters). The response becomes `{ id, sessionUri }`.

- The session is created with origin, content type, size and `ifGenerationMatch: 0` before the job is stored. A failure stores no job.
- A bad fingerprint returns 400 alongside today's checks.

## `POST /api/jobs/{id}/upload-session` (new)

Owner-only through `authorizedJob`, so another user's job returns 404. Only the tab holding the upload lock calls it (research R8).

```json
{
  "renew": false,
  "prev": "<sessionUri being renewed; only with renew: true>",
  "size": 123,
  "fingerprint": "<64 hex>",
  "filename": "…",
  "contentType": "video/mp4",
  "durationSec": 180
}
```

- `renew: false` is a pick the user made. It always wins (research R6).
- `renew: true` is the uploader recovering on its own after a 404, 410, 412 or 499. It swaps only if `prev` still matches.

Checks run in this order.

| Response | Body                                                     | When                                                                                                    |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 404      | —                                                        | Not the caller's job.                                                                                   |
| 409      | `{ message: "This job was discarded." }`                 | The job is `DISCARDED`.                                                                                 |
| 409      | `{ message: "This upload is already done." }`            | The job has left `AWAITING_UPLOAD`, or the object already landed.                                       |
| 400      | `{ message }`                                            | A pick of a different file that fails the create caps. Nothing changes.                                 |
| 200      | `{ sessionUri, restarted: false }`                       | A pick whose size and fingerprint match: the current session.                                           |
| 200      | `{ sessionUri, restarted: true }`                        | A pick of a different file that passes the caps: unconditional swap, then the old session is cancelled. |
| 200      | `{ sessionUri, restarted: true }`                        | A renew whose `prev` matches: a new session is swapped in, then the old one is cancelled.               |
| 409      | `{ message: "A different video replaced this upload." }` | A renew whose `prev` no longer matches. The session just made is cancelled.                             |

- `sessionUri` appears only in these two responses. It never appears in `JobView`, logs or traces.

## Server ↔ GCS

| Call                                                  | When                                                 | Notes                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Create session (`createResumableUpload`)              | create, pick of a new file, renew                    | `origin`, `contentType`, `contentLength`, `preconditionOpts: { ifGenerationMatch: 0 }` |
| Status query (`PUT`, `Content-Range: bytes */<size>`) | job page server load for `AWAITING_UPLOAD`           | fills `JobView.uploadSaved`; no media; a failure leaves it null                        |
| Cancel (`DELETE` session URI)                         | after any swap, and on discard                       | `404`, `410`, `499` count as done; other failures ignored                              |
| Delete object                                         | discard of an unfinished upload, if it landed anyway | never for a job whose upload finished                                                  |

## Browser ↔ GCS (session URI)

All requests are `XMLHttpRequest` from the app origin. G1 confirmed them in Chromium, Firefox and WebKit, including from an app address other than the one the session was made for.

| Request                                                           | Reply                                    | Uploader does                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `PUT` empty, `Content-Range: bytes */<size>`                      | `308` + `Range: bytes=0-N`, `N+1 < size` | Send from `N+1`.                                                                    |
|                                                                   | `308` + `Range: bytes=0-(size-1)`        | Finish: repeat the empty `PUT` with backoff, up to 5 tries, until `200`/`201`.      |
|                                                                   | `308`, no `Range`                        | Send from 0.                                                                        |
|                                                                   | `200`/`201`                              | Done: release the lock, call the step endpoint.                                     |
| `PUT` `file.slice(o)`, `Content-Range: bytes <o>-<size-1>/<size>` | `200`/`201`                              | Done.                                                                               |
| Any                                                               | status 0, `408`, `429`, `5xx`            | Pause with backoff, then status query (research R4).                                |
| Any                                                               | `404`, `410`, `412`, `499`               | `upload-session` with `renew: true` and `prev`.                                     |
| Any                                                               | other `4xx`                              | Stop and show the message. The job stays `AWAITING_UPLOAD`.                         |
| `upload-session`                                                  | `409`                                    | Stop, release the lock. "Replaced" shows the file prompt; others re-fetch the view. |

## Page states

This is the canonical list (spec FR-010).

| State                                      | Text                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Sending                                    | `Uploading n%`                                                                           |
| Network pause                              | `Upload paused: no connection`                                                           |
| Hidden tab back, nothing sent while hidden | "The upload paused while you were away." (until bytes flow)                              |
| No file in this tab                        | `Upload paused at n%. Pick the video to continue.` + file input (`n` from `uploadSaved`) |
| No file, saved amount unknown              | "Pick the video to continue." + file input                                               |
| New file picked                            | "New video: starting the upload over."                                                   |
| Another tab sending                        | "Uploading in another tab"                                                               |
| Session renewed                            | "The saved upload expired; starting again."                                              |
| Replaced elsewhere                         | "A different video replaced this upload." + file input                                   |
| Discarded elsewhere                        | "This job was discarded."                                                                |
