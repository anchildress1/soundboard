import { TITLE_MAX } from '#lib/metadata.js';
import { ActionError } from '#lib/server/core/errors.js';
import { num, text } from '#lib/server/core/http.js';
import { encrypt, UPLOAD_KMS_MS } from '#lib/server/core/kms.js';
import { startJobTrace } from '#lib/server/core/tracing.js';
import { createUploadSession, newUploadObject } from '#lib/server/media/gcs.js';
import { createJob, MAX_MINUTES, newJobId } from './jobs';

export const NOTES_MAX = 1000;
export const MAX_BYTES = 2 * 1024 ** 3;

export type CreateInput = {
  songTitle: string;
  notes?: string;
  filename: string;
  contentType: string;
  size: number;
  durationSec: number;
  fingerprint: string;
};

/** `sessionUri` is the browser's upload credential; it leaves the server only in this reply. */
export type Created = { id: string; sessionUri: string; generation: number };

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** A picked file's fingerprint: 64 lowercase hex characters, or a 400 the page shows as is. */
export function fingerprintOf(value: unknown): string {
  const fingerprint = text(value);
  if (!FINGERPRINT.test(fingerprint)) throw new ActionError(400, 'Pick the video again.');
  return fingerprint;
}

/** A positive, finite number no larger than `max`. */
const within = (n: number, max: number) => Number.isFinite(n) && n > 0 && n <= max;

export type MediaInput = Pick<CreateInput, 'filename' | 'contentType' | 'size' | 'durationSec'>;

/** The media caps, shared by create and a pick of a different file. */
export function parseMedia(input: MediaInput) {
  const contentType = text(input.contentType);
  const size = num(input.size);
  const duration = num(input.durationSec);
  if (!contentType.startsWith('video/')) throw new ActionError(400, 'Pick a video file.');
  if (!within(size, MAX_BYTES)) throw new ActionError(400, 'Videos must be under 2 GB.');
  if (!within(duration, MAX_MINUTES * 60)) {
    throw new ActionError(400, `Videos are capped at ${MAX_MINUTES} minutes.`);
  }
  return { contentType, size, filename: text(input.filename, 'video').slice(0, 200) };
}

function parseUpload(input: CreateInput) {
  const songTitle = text(input.songTitle).trim();
  const notes = text(input.notes).trim();
  if (!songTitle) throw new ActionError(400, 'Song title is required.');
  if (songTitle.length > TITLE_MAX)
    throw new ActionError(400, `Song title is over ${TITLE_MAX} characters.`);
  if (notes.length > NOTES_MAX)
    throw new ActionError(400, `Notes are over ${NOTES_MAX} characters.`);
  const media = parseMedia(input);
  return { songTitle, notes, ...media, fingerprint: fingerprintOf(input.fingerprint) };
}

/**
 * Creates the user's job and the resumable session the browser uploads the video through.
 * `origin` is the app address the browser sends from.
 */
export async function create(
  input: CreateInput,
  user: { uid: string; artistId: string | null },
  origin: string,
): Promise<Created> {
  const id = newJobId();
  const { size, fingerprint, ...fields } = parseUpload(input);
  // Opening and sealing the session can fail; both happen before a job is stored.
  const object = newUploadObject(id);
  const sessionUri = await createUploadSession(object, {
    origin,
    contentType: fields.contentType,
    size,
  });
  const sessionCipher = await encrypt(sessionUri, { timeout: UPLOAD_KMS_MS });
  await createJob(
    {
      ...fields,
      ownerUid: user.uid,
      artistId: user.artistId,
      object,
      videoUpload: { sessionCipher, generation: 1, size, fingerprint, ops: [] },
      trace: startJobTrace(id),
    },
    id,
  );
  return { id, sessionUri, generation: 1 };
}
