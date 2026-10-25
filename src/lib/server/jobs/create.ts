import { TITLE_MAX } from '#lib/metadata.js';
import { ActionError } from '#lib/server/core/errors.js';
import { signedUploadUrl, uploadObjectName } from '#lib/server/media/gcs.js';
import { createJob, MAX_MINUTES, newJobId } from './jobs';
import { num, text } from '#lib/server/core/http.js';
import { startJobTrace } from '#lib/server/core/tracing.js';

export const NOTES_MAX = 1000;
export const MAX_BYTES = 2 * 1024 ** 3;

export type CreateInput = {
  songTitle: string;
  notes?: string;
  filename: string;
  contentType: string;
  size: number;
  durationSec: number;
};

export type Created = { id: string; uploadUrl: string };

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
  const { contentType, filename } = parseMedia(input);
  return { songTitle, notes, contentType, filename };
}

/** Creates the user's job and the signed URL the browser uploads the video to. */
export async function create(
  input: CreateInput,
  user: { uid: string; artistId: string | null },
): Promise<Created> {
  const id = newJobId();
  const fields = parseUpload(input);
  // Signing can fail (IAM); do it before a job is stored.
  const uploadUrl = await signedUploadUrl(uploadObjectName(id), fields.contentType);
  await createJob(
    {
      ...fields,
      ownerUid: user.uid,
      artistId: user.artistId,
      object: null,
      trace: startJobTrace(id),
    },
    id,
  );
  return { id, uploadUrl };
}
