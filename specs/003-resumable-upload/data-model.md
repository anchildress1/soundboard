# Data Model: Resumable video upload

No schema change and no migration. The new field rides in `jobs.data` (jsonb).

## `JobDoc.videoUpload` (`src/lib/server/jobs/jobs.ts`)

```ts
videoUpload: {
  sessionCipher: string; // KMS ciphertext of the GCS resumable session URI (core/kms.ts encrypt)
  generation: number; // sender ownership: 1 at create; +1 on every pick and renew, in the same locked write
  sessionGeneration: number; // the generation the current session was created at; stamped on its object
  size: number; // declared to GCS, which rejects any other final size
  fingerprint: string; // hex SHA-256 of the sampled file (research R5)
  renewOp: { opId: string; generation: number } | null; // the last renew and the generation it produced, replayed on retry while still current
} | null;
```

The content type is the existing `JobDoc.contentType`. `newJobDoc` sets `videoUpload: null`, so Short jobs (built through it) carry null too. The field lives in `data`, not in `GUARDED`, so `jobSet` patches it like any other data field. A job row with no `videoUpload` key reads as null: a pick starts a new upload.

| Rule    | Detail                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set     | At create, after the session exists and is encrypted. `generation: 1`, `sessionGeneration: 1`.                                                                                                                        |
| Picked  | Same file: same session, `generation + 1`, `sessionGeneration` kept. Different file: new session swapped in, both set to `generation + 1`, then the displaced one cancelled. `filename` and `contentType` change too. |
| Renewed | `renew` after a `404`, `410`, `412` or `499`: only from the current generation, or replayed by `renewOp.opId`. `generation + 1`, then the old session cancelled.                                                      |
| Cleared | When the job moves to `PREP` (current-generation object only), and on discard once cancel and object delete are both confirmed.                                                                                       |
| Kept    | On discard with a failed cleanup step: the next touch repeats it (research R10).                                                                                                                                      |
| Locked  | Every write runs in one transaction under `lockJob` (`SELECT … FOR UPDATE`).                                                                                                                                          |
| Never   | Plain text at rest. In `toPublic`, `JobView`, page data, a request body, an error message, logs, spans or breadcrumbs.                                                                                                |

## GCS object metadata

- `uploads/<jobId>` carries custom metadata `uploadGeneration` (string), set when its session is created. Completion moves the job on only when it equals `videoUpload.sessionGeneration` (gate G2.2). A same-file pick bumps `generation` but keeps the session, so it doesn't change `sessionGeneration`.

## Job page data (`src/routes/jobs/[id]/+page.server.ts`)

- Adds `uploadSaved: { saved: number; total: number; done: boolean } | null` beside `view`, `expired` and `playbackUrl`. Only this load fills it, from a status query with a 5 s timeout, for `AWAITING_UPLOAD` jobs with a `videoUpload`. A failed query or no session leaves it null. `done: true` means GCS answered `200`/`201`: the page drives the step instead of asking for the file.
- `JobView` and `PublicJob` (`src/lib/types.ts`) are unchanged, so step and action responses never carry it. `uploadProgress` stays YouTube's.

## `CreateInput` (`src/lib/server/jobs/create.ts`)

- Adds `fingerprint`.
- `Created` becomes `{ id, sessionUri, generation }`.
- The media checks move to `parseMedia({ filename, contentType, size, durationSec })`, shared with a new-file pick. Song title and notes stay create-only.

## Browser state (`src/lib/upload.ts`)

- A module-level store, one entry per job uploading in this tab: `{ file, sessionUri, generation, size, saved, state, reason }`.
  - `state`: `sending`, `paused`, `away`, `other-tab`, `replaced`, `moved`, `stopped`, `done`.
  - `reason` (while paused): `offline`, `stall`, `no-reply`, `408`, `429`, `5xx`.
- Object URLs belong to the page showing the Monitor: each page makes its own from `file` and revokes it on destroy.
- It survives in-app navigation and is empty after a page load. `stop(jobId)` aborts the request in flight and releases the lock.
- Nothing about the upload is written to browser storage.

## Removed

`signedUploadUrl`, `CONTENT_LENGTH_RANGE`, `UPLOAD_TTL_MS`, `uploadToGcs`, `parseUpload` (split into create's own checks and `parseMedia`), `src/lib/pending.ts`.
