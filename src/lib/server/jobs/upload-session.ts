// The browser's resumable upload, one GCS session at a time per job. The session URI is a bearer
// credential: it leaves the server only in a pick or renew reply, never in a log, trace or error.
// Every request reads the job, does its GCS and KMS work outside any transaction, and commits on
// the generation it read; the newest committed pick or renew is the only sender.
import { ActionError } from '#lib/server/core/errors.js';
import { num, text } from '#lib/server/core/http.js';
import { decrypt, encrypt, UPLOAD_KMS_MS } from '#lib/server/core/kms.js';
import {
  cancelUploadSession,
  createUploadSession,
  newUploadObject,
  objectInfo,
  uploadOffset,
} from '#lib/server/media/gcs.js';
import { finishDiscardCleanup } from './actions';
import { fingerprintOf, parseMedia } from './create';
import type { UploadSaved } from '#lib/types.js';
import { commitUpload, getJob, uploadGeneration, type JobDoc, type VideoUpload } from './jobs';

export const REPLACED = 'A different video replaced this upload.';
export const MOVED = 'The upload moved to another device or window.';
export const DISCARDED = 'This job was discarded.';
export const DONE = 'This upload is already done.';

/** A 409 that names the current generation, so the client's next pick isn't stale. */
export class Superseded extends ActionError {
  constructor(
    message: string,
    readonly generation: number,
  ) {
    super(409, message);
  }
}

export type SessionReply =
  { sessionUri: string; generation: number; restarted: boolean } | { current: true };

type PickRequest = {
  op: 'pick';
  opId: string;
  generation: number;
  size: number;
  fingerprint: string;
  filename: string;
  contentType: string;
  durationSec: number;
};
type Renew = { op: 'renew'; opId: string; generation: number; fingerprint: string };
type Confirm = { op: 'confirm'; generation: number; fingerprint: string };
type SessionRequest = PickRequest | Renew | Confirm;

const OP_ID = /^[\w-]{1,64}$/;

function generationOf(value: unknown, min: number): number {
  const generation = num(value);
  if (!Number.isInteger(generation) || generation < min) {
    throw new ActionError(400, 'Name the upload generation.');
  }
  return generation;
}

function opIdOf(value: unknown): string {
  const opId = text(value);
  if (!OP_ID.test(opId)) throw new ActionError(400, 'Name the request with an opId.');
  return opId;
}

function parseRequest(body: Record<string, unknown>): SessionRequest {
  const fingerprint = fingerprintOf(body.fingerprint);
  switch (body.op) {
    case 'pick':
      return {
        op: 'pick',
        opId: opIdOf(body.opId),
        // 0 is a job with no upload yet.
        generation: generationOf(body.generation, 0),
        fingerprint,
        size: num(body.size),
        filename: text(body.filename),
        contentType: text(body.contentType),
        durationSec: num(body.durationSec),
      };
    case 'renew':
      return {
        op: 'renew',
        opId: opIdOf(body.opId),
        generation: generationOf(body.generation, 1),
        fingerprint,
      };
    case 'confirm':
      return { op: 'confirm', generation: generationOf(body.generation, 1), fingerprint };
    default:
      throw new ActionError(400, 'Unknown upload-session op.');
  }
}

/** Something newer won: "moved" when it's the same file, picked elsewhere; "replaced" otherwise. */
function superseded(job: JobDoc, fingerprint: string): never {
  const same = job.videoUpload?.fingerprint === fingerprint;
  throw new Superseded(same ? MOVED : REPLACED, uploadGeneration(job));
}

const sessionOf = (upload: VideoUpload) =>
  decrypt(upload.sessionCipher, { timeout: UPLOAD_KMS_MS });

/** Cancels a session nothing will use, best effort: its object can only become an orphan. */
async function cancelCipher(cipher: string | undefined): Promise<void> {
  if (!cipher) return;
  await cancelUploadSession(await decrypt(cipher, { timeout: UPLOAD_KMS_MS })).catch(() => false);
}

/** Opens a session for a fresh object; returns the object, the URI and its ciphertext. */
async function openSession(
  job: JobDoc,
  origin: string,
  media: { contentType: string; size: number },
) {
  const object = newUploadObject(job.id);
  const sessionUri = await createUploadSession(object, { origin, ...media });
  const sessionCipher = await encrypt(sessionUri, { timeout: UPLOAD_KMS_MS });
  return { object, sessionUri, sessionCipher };
}

/** The commit missed: read again and decide again. */
const RETRY = Symbol('retry');

/** A discarded or finished job takes no more upload requests. */
async function refuseClosed(job: JobDoc): Promise<void> {
  if (job.state === 'DISCARDED') {
    await finishDiscardCleanup(job);
    throw new ActionError(409, DISCARDED);
  }
  if (job.state !== 'AWAITING_UPLOAD' || (await objectInfo(job.object))) {
    throw new ActionError(409, DONE);
  }
}

/** A retried pick or renew already applied gets its first answer, or a 409 once it lost. */
async function replay(
  job: JobDoc,
  request: PickRequest | Renew,
  generation: number,
): Promise<SessionReply | null> {
  const upload = job.videoUpload;
  const applied = upload?.ops.find((op) => op.opId === request.opId);
  if (!applied || !upload) return null;
  if (applied.generation !== generation) superseded(job, request.fingerprint);
  return { sessionUri: await sessionOf(upload), generation, restarted: applied.restarted };
}

/** The same file again, after a reload or from another tab or device: it resumes the session. */
async function resume(
  job: JobDoc,
  upload: VideoUpload,
  opId: string,
  generation: number,
): Promise<SessionReply | typeof RETRY> {
  const next = generation + 1;
  const sessionUri = await sessionOf(upload);
  const committed = await commitUpload(job.id, generation, {
    videoUpload: {
      ...upload,
      generation: next,
      ops: [...upload.ops, { opId, generation: next, restarted: false }],
    },
  });
  return committed ? { sessionUri, generation: next, restarted: false } : RETRY;
}

/**
 * A different file, or a renew: a new session for a new object. The displaced one is cancelled
 * only after the commit, so a lost race never stops the session that won.
 */
async function restart(
  job: JobDoc,
  request: PickRequest | Renew,
  generation: number,
  origin: string,
): Promise<SessionReply | typeof RETRY> {
  const upload = job.videoUpload;
  const next = generation + 1;
  const media =
    request.op === 'pick'
      ? parseMedia(request)
      : { contentType: job.contentType, size: upload?.size ?? 0, filename: job.filename };
  const opened = await openSession(job, origin, media);
  const committed = await commitUpload(job.id, generation, {
    object: opened.object,
    filename: media.filename,
    contentType: media.contentType,
    videoUpload: {
      sessionCipher: opened.sessionCipher,
      generation: next,
      size: media.size,
      fingerprint: request.fingerprint,
      ops: [...(upload?.ops ?? []), { opId: request.opId, generation: next, restarted: true }],
    },
  });
  await cancelCipher(committed ? upload?.sessionCipher : opened.sessionCipher);
  return committed ? { sessionUri: opened.sessionUri, generation: next, restarted: true } : RETRY;
}

/** One pass of the contract's checks, in its order, against the job as read. */
async function attempt(
  job: JobDoc,
  request: SessionRequest,
  origin: string,
): Promise<SessionReply | typeof RETRY> {
  await refuseClosed(job);
  const generation = uploadGeneration(job);
  if (request.op !== 'confirm') {
    const replayed = await replay(job, request, generation);
    if (replayed) return replayed;
  }
  if (request.generation !== generation) superseded(job, request.fingerprint);
  if (request.op === 'confirm') return { current: true };
  const upload = job.videoUpload;
  const same = request.op === 'pick' && upload?.size === request.size;
  return same && upload.fingerprint === request.fingerprint
    ? resume(job, upload, request.opId, generation)
    : restart(job, request, generation, origin);
}

/** Attempts until one commits or answers; a missed commit reads the job again first. */
async function settle(job: JobDoc, request: SessionRequest, origin: string): Promise<SessionReply> {
  const reply = await attempt(job, request, origin);
  if (reply !== RETRY) return reply;
  const fresh = await getJob(job.id);
  if (!fresh) throw new ActionError(404, 'Job not found');
  return settle(fresh, request, origin);
}

/**
 * Answers `POST /api/jobs/{id}/upload-session` for the owner's job: a pick, a renew or a confirm
 * (contract). A commit that missed reads the job again and reruns every check, replay first, so a
 * retry that overlapped its own slower first attempt gets that attempt's answer. The rerun can't
 * commit again: the generation it was sent with is no longer current.
 */
export async function uploadSession(
  job: JobDoc,
  body: Record<string, unknown>,
  origin: string,
): Promise<SessionReply> {
  return settle(job, parseRequest(body), origin);
}

/** How much of the job's upload GCS saved, or null when it has none or GCS or KMS didn't answer. */
export async function savedAmount(job: JobDoc): Promise<UploadSaved | null> {
  const upload = job.videoUpload;
  if (job.state !== 'AWAITING_UPLOAD' || !upload) return null;
  try {
    const offset = await uploadOffset(await sessionOf(upload), upload.size);
    return offset.done
      ? { saved: upload.size, total: upload.size, done: true }
      : { saved: offset.saved, total: upload.size, done: false };
  } catch {
    return null;
  }
}
