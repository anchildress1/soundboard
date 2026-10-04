import { TITLE_MAX } from '$lib/metadata';
import { ActionError } from './actions';
import { signedUploadUrl, uploadObjectName } from './gcs';
import { createJob, MAX_MINUTES, newJobId, type NewJob } from './jobs';
import { hashIp, reserveVisitorRun } from './quota';
import { getSample } from './samples';
import { startJobTrace } from './tracing';

export const NOTES_MAX = 1000;
export const MAX_BYTES = 2 * 1024 ** 3;

export type CreateInput =
  | { sampleId: string }
  | {
      songTitle: string;
      notes?: string;
      filename: string;
      contentType: string;
      size: number;
      durationSec: number;
    };

export type Created = { id: string; uploadUrl: string | null };

function parseUpload(input: Exclude<CreateInput, { sampleId: string }>, maxMinutes: number) {
  const songTitle = String(input.songTitle ?? '').trim();
  const notes = String(input.notes ?? '').trim();
  const contentType = String(input.contentType ?? '');
  const size = Number(input.size);
  const duration = Number(input.durationSec);
  if (!songTitle) throw new ActionError(400, 'Song title is required.');
  if (songTitle.length > TITLE_MAX)
    throw new ActionError(400, `Song title is over ${TITLE_MAX} characters.`);
  if (notes.length > NOTES_MAX)
    throw new ActionError(400, `Notes are over ${NOTES_MAX} characters.`);
  if (!contentType.startsWith('video/')) throw new ActionError(400, 'Pick a video file.');
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    throw new ActionError(400, 'Videos must be under 2 GB.');
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxMinutes * 60) {
    throw new ActionError(400, `Videos are capped at ${maxMinutes} minutes here.`);
  }
  return {
    songTitle,
    notes,
    contentType,
    filename: String(input.filename ?? 'video').slice(0, 200),
  };
}

async function sampleJob(sampleId: string, allowlisted: boolean): Promise<NewJob> {
  const sample = await getSample(String(sampleId));
  if (!sample) throw new ActionError(404, 'That sample is gone.');
  return {
    owner: allowlisted ? 'nathan' : 'visitor',
    channel: allowlisted ? 'nathan' : 'sandbox',
    songTitle: sample.songTitle,
    notes: '',
    filename: `${sample.songTitle}.mp4`,
    contentType: 'video/mp4',
    object: sample.object,
    sampleId: sample.id,
    liveVideoId: sample.videoId,
    ipHash: null,
    trace: null,
  };
}

function uploadJob(
  input: Exclude<CreateInput, { sampleId: string }>,
  allowlisted: boolean,
): NewJob {
  const owner = allowlisted ? 'nathan' : 'visitor';
  return {
    ...parseUpload(input, MAX_MINUTES[owner]),
    owner,
    channel: allowlisted ? 'nathan' : null,
    object: null,
    sampleId: null,
    liveVideoId: null,
    ipHash: null,
    trace: null,
  };
}

/**
 * Creates a job. Allowlisted sessions upload to Nathan's channel with no run caps. Signed-out samples
 * go to the sandbox channel; signed-out own videos end at the would-be payload.
 */
export async function create(
  input: CreateInput,
  who: { allowlisted: boolean; ip: string },
): Promise<Created> {
  const id = newJobId();
  const job =
    'sampleId' in input
      ? await sampleJob(input.sampleId, who.allowlisted)
      : uploadJob(input, who.allowlisted);
  if (!who.allowlisted) {
    job.ipHash = hashIp(who.ip);
    const blocked = await reserveVisitorRun(job.ipHash);
    if (blocked) throw new ActionError(429, blocked);
  }
  job.trace = startJobTrace(id);
  const doc = await createJob(job, id);
  const uploadUrl = job.object
    ? null
    : await signedUploadUrl(uploadObjectName(id), job.contentType);
  return { id: doc.id, uploadUrl };
}
