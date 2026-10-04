import { bucket } from './clients';

/** The 2 GB cap is enforced by GCS itself through the signed header, not by the app. */
export const CONTENT_LENGTH_RANGE = '1,2147483648';
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const READ_TTL_MS = 2 * 60 * 60 * 1000;

export function uploadObjectName(jobId: string): string {
  return `uploads/${jobId}`;
}

/** Signed PUT the browser uploads to directly; it must send the same content type and range header. */
export async function signedUploadUrl(object: string, contentType: string): Promise<string> {
  const [url] = await bucket()
    .file(object)
    .getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + UPLOAD_TTL_MS,
      contentType,
      extensionHeaders: { 'x-goog-content-length-range': CONTENT_LENGTH_RANGE },
    });
  return url;
}

/** Signed GET used by the monitor, ffmpeg, and the YouTube upload; GCS serves range requests on it. */
export async function signedReadUrl(object: string): Promise<string> {
  const [url] = await bucket()
    .file(object)
    .getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + READ_TTL_MS });
  return url;
}

export type ObjectInfo = { size: number; contentType: string };

/** Size and type of an uploaded object, or null while the browser upload hasn't landed. */
export async function objectInfo(object: string): Promise<ObjectInfo | null> {
  const file = bucket().file(object);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  return {
    size: Number(metadata.size ?? 0),
    contentType: metadata.contentType ?? 'application/octet-stream',
  };
}
