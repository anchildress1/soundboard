import { randomBytes } from 'node:crypto';
import { bucket } from '#lib/server/core/clients.js';
import { budget, within } from '#lib/server/core/deadline.js';

const READ_TTL_MS = 2 * 60 * 60 * 1000;

/** Uploads a rendered file from local disk to the bucket. */
/** One request, not a resumable session: the SDK applies `timeout` only to a single request. */
export async function uploadFile(
  path: string,
  object: string,
  contentType: string,
  timeoutMs: number,
): Promise<void> {
  await bucket().upload(path, {
    contentType,
    destination: object,
    resumable: false,
    timeout: timeoutMs,
  });
}

/** Signed GET used by the monitor, ffmpeg, and the YouTube upload; GCS serves range requests on it. */
export async function signedReadUrl(object: string): Promise<string> {
  const [url] = await bucket()
    .file(object)
    .getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + READ_TTL_MS });
  return url;
}

export type ObjectInfo = { size: number; contentType: string };

const CALL_MS = 5_000;
const SESSION_MS = 10_000;
const SWEEP_MS = 10_000;

/**
 * Size and type of an uploaded object, or null while the browser upload hasn't landed. `deadline`
 * (epoch ms) caps the 5 s budget inside a step.
 */
export async function objectInfo(object: string, deadline?: number): Promise<ObjectInfo | null> {
  const file = bucket().file(object);
  return await within(
    budget(CALL_MS, deadline),
    (async () => {
      const [exists] = await file.exists();
      if (!exists) return null;
      const [metadata] = await file.getMetadata();
      return {
        size: Number(metadata.size ?? 0),
        contentType: metadata.contentType ?? 'application/octet-stream',
      };
    })(),
    'Reading the upload object',
  );
}

/** A fresh object for one upload session; names are random, so no two sessions share one. */
export function newUploadObject(jobId: string): string {
  return `uploads/${jobId}/${randomBytes(16).toString('base64url')}`;
}

/**
 * Opens a GCS JSON API resumable session for `object`; returns its URI, a bearer credential.
 * `origin` makes the browser's PUTs readable cross-origin; GCS refuses any final size but `size`.
 */
export async function createUploadSession(
  object: string,
  { origin, contentType, size }: { origin: string; contentType: string; size: number },
): Promise<string> {
  const [uri] = await within(
    SESSION_MS,
    bucket()
      .file(object)
      .createResumableUpload({ origin, metadata: { contentType, contentLength: size } }),
    'Opening the upload session',
  );
  return uri;
}

export type SessionOffset = { done: true } | { done: false; saved: number };

/** Asks GCS how much of the session it saved: the documented status query. */
export async function uploadOffset(
  sessionUri: string,
  size: number,
  deadline?: number,
): Promise<SessionOffset> {
  // The URI is a credential: errors from fetch can carry it, so none is passed on.
  const response = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'content-range': `bytes */${size}` },
    signal: AbortSignal.timeout(budget(CALL_MS, deadline)),
  }).catch(() => {
    throw new Error('The upload status query failed.');
  });
  await response.body?.cancel();
  if (response.status === 200 || response.status === 201) return { done: true };
  if (response.status !== 308) {
    throw new Error(`The upload status query answered ${response.status}.`);
  }
  const last = /^bytes=0-(\d+)$/.exec(response.headers.get('range') ?? '');
  return { done: false, saved: last ? Number(last[1]) + 1 : 0 };
}

// GCS answers a cancelled session 499, and a gone one 404 or 410: each means it can't write.
const CANCELLED = new Set([404, 410, 499]);

async function cancelOnce(sessionUri: string): Promise<boolean> {
  try {
    const response = await fetch(sessionUri, {
      method: 'DELETE',
      signal: AbortSignal.timeout(CALL_MS),
    });
    await response.body?.cancel();
    return response.ok || CANCELLED.has(response.status);
  } catch {
    return false;
  }
}

/** Cancels the session so it can't write; one retry. False when GCS never confirmed. */
export async function cancelUploadSession(sessionUri: string): Promise<boolean> {
  if (await cancelOnce(sessionUri)) return true;
  return cancelOnce(sessionUri);
}

/**
 * Deletes every object under `uploads/<jobId>/` but `keep`. The trailing slash keeps a Short's
 * renders (`uploads/<shortId>-<n>`) out. False when the listing or any delete failed.
 */
export async function sweepUploads(
  jobId: string,
  keep: string | null,
  deadline?: number,
): Promise<boolean> {
  try {
    return await within(
      budget(SWEEP_MS, deadline),
      (async () => {
        const [files] = await bucket().getFiles({ prefix: `uploads/${jobId}/` });
        const deleted = await Promise.allSettled(
          files
            .filter((file) => file.name !== keep)
            .map((file) => file.delete({ ignoreNotFound: true })),
        );
        return deleted.every((result) => result.status === 'fulfilled');
      })(),
      'Sweeping old uploads',
    );
  } catch {
    return false;
  }
}
