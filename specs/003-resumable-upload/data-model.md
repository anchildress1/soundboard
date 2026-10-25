# Data Model: Resumable video upload

No schema change and no migration. The new field rides in `jobs.data` (jsonb), beside the existing `object`.

## `JobDoc.object` (existing, `src/lib/server/jobs/jobs.ts`)

- Now names the current session's object, `uploads/<jobId>/<objectId>` (`objectId`: 16 random bytes, base64url), instead of the fixed `uploads/<jobId>`.
- Set at create, and replaced by a different-file pick and by a renew. Never reused.
- Every reader already reads `job.object` (plan, "Readers of the upload object"), so the pipeline, playback, the YouTube upload and a Short's `sourceObject` follow it unchanged.
- It's in `data`, not in `GUARDED`, so `jobSet` patches it.

## `JobDoc.videoUpload` (`src/lib/server/jobs/jobs.ts`)

```ts
videoUpload: {
  sessionCipher: string; // KMS ciphertext of the GCS resumable session URI (core/kms.ts encrypt)
  generation: number; // sender ownership: 1 at create; +1 on every pick and renew
  size: number; // declared to GCS, which rejects any other final size
  fingerprint: string; // hex SHA-256 of the sampled file (research R5)
  ops: { opId: string; generation: number; restarted: boolean }[]; // last 20 applied picks and renews, newest last
} | null;
```

The content type is the existing `JobDoc.contentType`. `newJobDoc` sets `videoUpload: null`, so Short jobs (built through it) carry null too. A job row with no `videoUpload` key reads as null: a pick starts a new upload.

| Rule      | Detail                                                                                                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set       | At create, after the session exists and is encrypted. `generation: 1`, `ops: []`.                                                                                                                                                                                                                                                                  |
| Picked    | Same file: same session and object, `generation + 1`. Different file: a session for a new object, `object` replaced, `generation + 1`, then the displaced session cancelled. `filename` and `contentType` change too.                                                                                                                              |
| Renewed   | `renew` after a `404`, `410` or `499`, only from the current generation: a session for a new object, `object` replaced, `generation + 1`, then the old session cancelled.                                                                                                                                                                          |
| Committed | Every write is one conditional `UPDATE … WHERE state = 'AWAITING_UPLOAD' AND generation = <read>`. No GCS or KMS call runs inside a transaction. A job with no `videoUpload` reads as generation 0. Discard's update also requires the `object` and `generation` it inspected (research R10).                                                      |
| Cleared   | When the job moves to `PREP` (only while `object` is still the landed name). On discard: at once when the current upload had landed (the video is kept); otherwise once the cancel is confirmed and the prefix sweep succeeded. `DISCARDED` with `videoUpload` set means that cleanup is still owed, and the next touch repeats it (research R10). |
| Never     | Plain text at rest. In `toPublic`, `JobView`, page data, a request body, an error message, logs, spans or breadcrumbs.                                                                                                                                                                                                                             |

## GCS objects

- `uploads/<jobId>/<objectId>`: one per session. Only `job.object` counts. Others under the prefix are orphans, deleted by the prefix sweep after completion and on discard, and by the lifecycle rule (`uploads/`, 7 days from each object's write, with Google's unspecified deletion delay).
- Short renders stay `uploads/<shortId>-<n>` (`pipeline/short.ts`). The sweep's prefix ends in `/`, so it never matches them.

## Job page data (`src/routes/jobs/[id]/+page.server.ts`)

- Adds `uploadSaved: { saved: number; total: number; done: boolean } | null` beside `view`, `expired` and `playbackUrl`. Only this load fills it, from a status query, for `AWAITING_UPLOAD` jobs with a `videoUpload`. A failed KMS or GCS call, or no session, leaves it null. `done: true` means GCS answered `200`/`201`: the page drives the step instead of asking for the file.
- Adds `uploadGeneration: number`: `videoUpload.generation` for an `AWAITING_UPLOAD` job, `0` when it has none. A pick sends it as the observed generation (contract). It's not a secret.
- `JobView` and `PublicJob` (`src/lib/types.ts`) are unchanged, so step and action responses never carry it. `uploadProgress` stays YouTube's.

## `CreateInput` (`src/lib/server/jobs/create.ts`)

- Adds `fingerprint`.
- `Created` becomes `{ id, sessionUri, generation }`.
- The media checks move to `parseMedia({ filename, contentType, size, durationSec })`, shared with a new-file pick. Song title and notes stay create-only.

## Browser state (`src/lib/upload.ts`)

- A module-level store, one entry per job uploading in this tab: `{ file, sessionUri, generation, fingerprint, size, saved, state, reason, notice, error }`.
  - `state`: `sending`, `paused`, `away`, `replaced`, `moved`, `stopped`, `done`. "Uploading in another tab" is a page state: that tab has no entry.
  - `notice` (while sending): `new-video` or `renewed`. `error`: the message a stop ended on.
  - `reason` (while paused): `offline`, `stall`, `no-reply`, `timeout`, `408`, `429`, `5xx`.
- Object URLs belong to the page showing the Monitor: each page makes its own from `file` and revokes it on destroy.
- It survives in-app navigation and is empty after a page load. `stop(jobId)` aborts the request in flight and releases the lock.
- Nothing about the upload is written to browser storage.

## Removed

`signedUploadUrl`, `CONTENT_LENGTH_RANGE`, `UPLOAD_TTL_MS`, `uploadToGcs`, `parseUpload` (split into create's own checks and `parseMedia`), `src/lib/pending.ts`, and the fixed `uploads/<jobId>` name (`uploadObjectName(jobId)` becomes `uploadObjectName(jobId, objectId)`).
