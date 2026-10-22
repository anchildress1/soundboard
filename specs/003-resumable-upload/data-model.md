# Data Model: Resumable video upload

No schema change and no migration. The new field rides in `jobs.data` (jsonb), like the YouTube `upload` session.

## `JobDoc.videoUpload` (`src/lib/server/jobs/jobs.ts`)

```ts
videoUpload: {
  sessionUri: string; // GCS resumable session; a bearer credential for this object
  size: number; // declared to GCS, which rejects any other final size
  fingerprint: string; // hex SHA-256(size ‖ first 1 MiB ‖ last 1 MiB)
} | null;
```

The content type is the existing `JobDoc.contentType`.

| Rule     | Detail                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set      | At create, after the session exists (`ifGenerationMatch: 0`).                                                                                         |
| Replaced | A user pick with a different file: unconditional swap (newest pick wins), then the old session is cancelled. `filename` and `contentType` change too. |
| Renewed  | Automatic `renew: true` after a 404, 410, 412 or 499 reply: swapped only if `prev` still matches, then the old session is cancelled.                  |
| Cleared  | When the job moves to `PREP`, and on discard (after the `DELETE`).                                                                                    |
| Never    | In `toPublic`, `JobView`, logs, spans or breadcrumbs.                                                                                                 |

## `JobView` (`src/lib/types.ts`)

- Adds `uploadSaved: { saved: number; total: number } | null`. Only the job page's server load fills it, from a status query, for `AWAITING_UPLOAD` jobs. Step and action responses leave it null. `uploadProgress` stays YouTube's.

## `CreateInput` (`src/lib/server/jobs/create.ts`)

- Adds `fingerprint`.
- `Created` becomes `{ id, sessionUri }`.

## Browser state (`src/lib/upload.ts`)

- A module-level store, one entry per job uploading in this tab: `{ file, objectUrl, sessionUri, saved, sending, state }`. The home page hands the picked file to it directly, so `src/lib/pending.ts` is removed.
- It survives in-app navigation and is empty after a page load. `stop(jobId)` aborts the request in flight and releases the lock.
- Nothing about the upload is written to browser storage.

## Removed

`signedUploadUrl`, `CONTENT_LENGTH_RANGE`, `uploadToGcs`, `src/lib/pending.ts`.
