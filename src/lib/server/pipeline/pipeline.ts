import { captureException, captureMessage, startSpan, type Span } from '@sentry/sveltekit';
import { scrubUrl } from '$lib/scrub';
import {
  DRIVEN_STATES,
  type Chunk,
  type JobState,
  type Pick,
  type PickFields,
  type Wait,
} from '$lib/types';
import { approvedBrand } from '$lib/server/artist/brand';
import { analyzeChunk } from '$lib/server/ai/chunk-analyst';
import { chunkCount, measureFile, probe, WINDOW_SEC } from '$lib/server/media/ffmpeg';
import { objectInfo, signedReadUrl } from '$lib/server/media/gcs';
import { audienceEvidence, type AudienceEvidence } from './hashtags';
import {
  claimJob,
  fail,
  MAX_MINUTES,
  listChunks,
  listPicks,
  markFinalChunk,
  markUploadStarted,
  ok,
  releaseJob,
  transitionJob,
  type JobDoc,
} from '$lib/server/jobs/jobs';
import { artistJob, listFacts, recentFeedback, recordPublish } from '$lib/server/artist/memory';
import { required } from '$lib/server/core/env';
import { ModelWaking, modelStatus, stepDeadline } from '$lib/server/ai/model';
import { hookStep, renderStep } from './short';
import { runPick } from '$lib/server/ai/smart-pick';
import type { JobPatch } from '$lib/server/jobs/rows';
import { invokeAgent } from '$lib/server/core/tracing';
import {
  accessTokenFor,
  finalChunk,
  readBack,
  recentVideos,
  sourceRange,
  startResumableUpload,
  thumbnailDataUrl,
  uploadChunk,
  uploadFailure,
  uploadOffset,
  type ChunkResult,
} from '$lib/server/platforms/youtube';

export const VERIFY_ATTEMPTS = 10;
const RECENT_COUNT = 3;

type Patch = JobPatch;
/** A step's job patch, plus output to store only if the claim is still valid at release. */
type StepOutput = Patch & { pick?: Pick; chunk?: Chunk; wait?: Wait };

/** A failed step that still produced output worth keeping, so the retry doesn't redo it. */
class StepFailure extends Error {
  constructor(
    cause: unknown,
    readonly keep: Patch,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

async function prep(job: JobDoc): Promise<Patch> {
  const info = await objectInfo(job.object);
  if (!info) return fail('PREP', 'The upload never reached storage. Start a new run.');
  const url = await signedReadUrl(job.object);
  const probed = await probe(url);
  if (!probed.hasAudio) return fail('PREP', 'This video has no audio track.');
  if (!Number.isFinite(probed.durationSec) || probed.durationSec <= 0) {
    return fail('PREP', "Couldn't read this video's duration. Re-export it and try again.");
  }
  if (probed.durationSec > MAX_MINUTES * 60) {
    return fail(
      'PREP',
      `Videos are capped at ${MAX_MINUTES} minutes; this one runs ${(probed.durationSec / 60).toFixed(1)}.`,
    );
  }
  const measurements = await measureFile(url, probed.durationSec);
  return ok({
    state: 'ANALYZE',
    probe: probed,
    contentType: info.contentType,
    chunkCount: chunkCount(probed.durationSec),
    chunkIndex: 0,
    measurements,
  });
}

async function analyze(job: JobDoc): Promise<StepOutput> {
  const index = job.chunkIndex;
  const startSec = index * WINDOW_SEC;
  const duration = job.probe?.durationSec ?? 0;
  const chunk = await analyzeChunk({
    url: await signedReadUrl(job.object),
    durationSec: Math.min(WINDOW_SEC, duration - startSec),
    songTitle: job.songTitle,
    notes: job.notes,
    index,
    startSec,
  });
  const next = index + 1;
  return {
    ...ok({ chunkIndex: next, state: next >= job.chunkCount ? 'PICK' : 'ANALYZE' }),
    chunk,
  };
}

async function pick(job: JobDoc): Promise<StepOutput> {
  // The budget covers the catalog and search reads too, not only the model calls.
  const deadline = stepDeadline();
  const artist = await artistJob(job);
  const [chunks, picks, recent] = await Promise.all([
    listChunks(job.id),
    listPicks(job.id),
    artist ? recentVideos(required('FLR_CHANNEL_ID'), RECENT_COUNT) : [],
  ]);
  const withThumbs = await Promise.all(
    recent.map(async (v) => ({
      ...v,
      thumbnail: v.thumbnailUrl ? await thumbnailDataUrl(v.thumbnailUrl) : null,
    })),
  );
  return invokeAgent('smart-pick', async (span) => {
    const audience =
      job.audience ?? (await audienceEvidence(chunks, job.probe?.durationSec ?? null));
    try {
      return await pickWith(audience, span);
    } catch (error) {
      // The genre search is one per job; a failed model call must not spend it again on retry.
      throw new StepFailure(error, { audience });
    }
  });

  async function pickWith(audience: AudienceEvidence, span: Span): Promise<StepOutput> {
    const [facts, feedback, brand] = artist
      ? await Promise.all([listFacts(), recentFeedback(), approvedBrand()])
      : [[], [], null];
    const result = await runPick(
      {
        artist,
        songTitle: job.songTitle,
        notes: job.notes,
        measurements: job.measurements,
        probe: job.probe,
        recent: withThumbs,
        candidates: audience.hashtags,
        tagCandidates: audience.tags,
        audience: audience.top,
        skipped: picks
          .filter((p) => p.skipped)
          .map(({ title, description }) => ({ title, description })),
        chunks,
        facts,
        feedback,
        brand,
      },
      deadline,
      span,
    );
    if (!result) throw new Error('The model reply did not parse as a recommendation.');
    const version = (picks.at(-1)?.version ?? 0) + 1;
    span.setAttribute('pick.version', version);
    return {
      ...ok({
        state: 'REVIEW',
        hashtagCandidates: audience.hashtags,
        pickVersion: version,
        audience,
      }),
      // Each stored pick carries the running total, so a re-run never loses earlier pick time.
      pick: { ...result.pick, version, modelMs: result.ms + (picks.at(-1)?.modelMs ?? 0) },
    };
  }
}

const OUTCOME_UNKNOWN: Wait = 'upload outcome unknown';
const DAILY_LIMIT: Wait = 'Daily upload limit reached. Try tomorrow.';

/**
 * Whether the upload session was lost after its final bytes may have gone out, so only the owner
 * can say whether YouTube kept the video. Steps and confirm-upload both use this one check.
 */
export const outcomeUnknown = (job: JobDoc): boolean =>
  job.state === 'PUBLISHING' &&
  job.finalChunkAt !== null &&
  job.upload === null &&
  job.videoId === null;

/**
 * One upload step. The grant is checked first on every step, chunk PUTs included: the session URI
 * alone authorizes a PUT, so a revoked or reconnected-elsewhere grant must stop the upload here.
 * A spent daily limit and a refused grant are waits, never failures.
 */
async function publishing(job: JobDoc): Promise<StepOutput> {
  if (!job.destination || !job.finalFields) return fail('PUBLISHING', 'Nothing to upload.');
  // No YouTube call at all: the page polls this wait, and polling must spend no quota.
  if (outcomeUnknown(job)) return { wait: OUTCOME_UNKNOWN };
  const token = await accessTokenFor(job.ownerUid, job.destination.channelId);
  if (!token) return { wait: 'reconnect YouTube' };
  try {
    return job.upload
      ? await sendChunk(job, job.upload)
      : await initiate(job, token, job.finalFields);
  } catch (error) {
    const failure = uploadFailure(error);
    if (failure === 'quota-spent') return { wait: DAILY_LIMIT };
    if (failure === 'access-lost') return { wait: 'reconnect YouTube' };
    throw error;
  }
}

async function initiate(job: JobDoc, token: string, fields: PickFields): Promise<StepOutput> {
  const info = await objectInfo(job.object);
  if (!info) return fail('PUBLISHING', 'The source video has expired from storage.');
  // Durable before the request: a crash after YouTube opened the session still shows it began.
  await markUploadStarted(job.id);
  const sessionUri = await startResumableUpload(token, fields, info.size, job.contentType);
  return ok({
    upload: { sessionUri, total: info.size },
    uploadProgress: { sent: 0, total: info.size },
  });
}

/**
 * Resumes from the offset YouTube holds. A lost session restarts on the same destination only if
 * the final chunk never went out; after it may have, the outcome is the owner's call.
 */
async function sendChunk(
  job: JobDoc,
  { sessionUri, total }: { sessionUri: string; total: number },
): Promise<StepOutput> {
  let finalSent = job.finalChunkAt !== null;
  let result: ChunkResult;
  try {
    result = await uploadOffset(sessionUri, total);
    if (!result.done) {
      const source = await sourceRange(await signedReadUrl(job.object), result.next, total);
      // Marked once GCS answered and just before the PUT: a source that never opened sent nothing,
      // and a lost reply to this PUT must never lead to a second upload.
      if (finalChunk(result.next, total)) {
        await markFinalChunk(job.id);
        finalSent = true;
      }
      result = await uploadChunk(sessionUri, source, result.next, total);
    }
  } catch (error) {
    if (uploadFailure(error) !== 'session-lost') throw error;
    if (finalSent) return { upload: null, wait: OUTCOME_UNKNOWN };
    return ok({ upload: null, uploadProgress: null });
  }
  if (result.done) {
    // The insert response only claims success; the read-back step decides VERIFIED.
    return ok({
      state: 'CLAIMED_COMPLETE',
      videoId: result.videoId,
      uploadProgress: { sent: total, total },
    });
  }
  return ok({ uploadProgress: { sent: result.next, total } });
}

// Only an upload YouTube kept counts as verified; `uploaded` is still processing but kept.
const ACCEPTED_UPLOADS = new Set(['uploaded', 'processed']);
const REJECTED_UPLOADS = new Set(['rejected', 'failed', 'deleted']);

/** Verified uploads on artist jobs join the artist's memory; no one else's do. */
async function recordVerified(job: JobDoc, videoId: string): Promise<void> {
  if (!job.finalFields || !(await artistJob(job))) return;
  await recordPublish({
    videoId,
    url: `https://youtu.be/${videoId}`,
    jobId: job.id,
    fields: job.finalFields,
    status: 'VERIFIED',
    at: Date.now(),
  });
}

async function verify(job: JobDoc): Promise<StepOutput> {
  if (!job.destination || !job.videoId) {
    return fail('CLAIMED_COMPLETE', 'Cannot read the upload back.');
  }
  const token = await accessTokenFor(job.ownerUid, job.destination.channelId);
  if (!token) return { wait: 'reconnect YouTube' };
  const video = await readBack(token, job.videoId);
  const uploadStatus = video?.uploadStatus ?? '';
  if (REJECTED_UPLOADS.has(uploadStatus)) {
    return fail('CLAIMED_COMPLETE', `YouTube ${uploadStatus} the upload.`);
  }
  if (ACCEPTED_UPLOADS.has(uploadStatus)) {
    await recordVerified(job, job.videoId);
    return ok({ state: 'VERIFIED' });
  }
  const attempts = job.verifyAttempts + 1;
  if (attempts >= VERIFY_ATTEMPTS)
    return fail('CLAIMED_COMPLETE', 'YouTube never returned the uploaded video.');
  return { verifyAttempts: attempts };
}

const HANDLERS: Partial<Record<JobState, (job: JobDoc) => Promise<StepOutput>>> = {
  PREP: prep,
  ANALYZE: analyze,
  PICK: pick,
  HOOK: hookStep,
  RENDER: renderStep,
  PUBLISHING: publishing,
  CLAIMED_COMPLETE: verify,
};

const NEEDS_MODEL: ReadonlySet<JobState> = new Set(['ANALYZE', 'PICK', 'HOOK']);

/**
 * A step that throws counts as a failure; two in a row stop the job at that step for a retry. The
 * message is stored and shown, and ffmpeg quotes the signed URL it failed on, so queries go.
 */
export function failurePatch(job: JobDoc, error: unknown): Patch {
  const message = scrubUrl(error instanceof Error ? error.message : String(error));
  const failures = job.consecutiveFailures + 1;
  if (failures >= 2) return { ...fail(job.state, message), consecutiveFailures: failures };
  return { consecutiveFailures: failures, error: message };
}

export type StepResult = { wait?: Wait };

async function modelWait(): Promise<Wait | undefined> {
  const status = await modelStatus();
  if (status === 'loading') return 'waking model';
  if (status === 'busy') return 'waiting on another run';
  return undefined;
}

/**
 * Runs the claimed step's handler; a throw becomes the failure patch, keeping any finished output.
 * A model that scaled to zero mid-step is a wait, not a failure.
 */
async function runHandler(
  job: JobDoc,
  handler: (job: JobDoc) => Promise<StepOutput>,
): Promise<StepOutput> {
  try {
    return await startSpan(
      {
        op: 'pipeline.step',
        name: `step ${job.state}`,
        attributes: { 'job.id': job.id, 'job.chunk': job.chunkIndex },
      },
      () => handler(job),
    );
  } catch (error) {
    const failure = error instanceof StepFailure ? error : null;
    const cause = failure ? failure.cause : error;
    if (cause instanceof ModelWaking) return { ...failure?.keep, wait: 'waking model' };
    captureException(cause, { tags: { step: job.state } });
    return { ...failurePatch(job, error), ...failure?.keep };
  }
}

/**
 * Runs exactly one pipeline step for the job. Model loading or busy returns a wait at once, without
 * claiming the job; otherwise the step claims the job, runs, and releases it with its result.
 */
export async function runStep(snapshot: JobDoc): Promise<StepResult> {
  if (snapshot.state === 'AWAITING_UPLOAD') {
    await startOnceUploaded(snapshot);
    return {};
  }
  if (!handlerFor(snapshot.state)) return {};

  const claimed = await claimJob(snapshot.id);
  if (!claimed) return { wait: 'step running in another tab' };
  const { token, job } = claimed;
  const handler = handlerFor(job.state);
  if (!handler) {
    await releaseJob(job.id, token, job.state);
    return {};
  }
  // Readiness is checked against the claimed state, which may be ahead of the caller's snapshot.
  const wait = NEEDS_MODEL.has(job.state) ? await modelWait() : undefined;
  if (wait) {
    await releaseJob(job.id, token, job.state);
    return { wait };
  }

  const output = await runHandler(job, handler);
  const { pick: newPick, chunk, wait: woke, ...patch } = output;
  if (!(await releaseJob(job.id, token, job.state, patch, { pick: newPick, chunk }))) {
    captureMessage('Step result dropped: the claim lapsed or the job moved on', {
      level: 'warning',
      tags: { step: job.state },
    });
  }
  if (woke) return { wait: woke };
  const stillVerifying = job.state === 'CLAIMED_COMPLETE' && patch.state === undefined;
  return stillVerifying ? { wait: 'waiting on YouTube' } : {};
}

/** The browser's upload has landed once its object exists; then the pipeline starts. */
async function startOnceUploaded(job: JobDoc): Promise<void> {
  if (await objectInfo(job.object)) {
    await transitionJob(job.id, ['AWAITING_UPLOAD'], { state: 'PREP' });
  }
}

/** The step to run for a state the page drives, or null for any other state. */
function handlerFor(state: JobState): ((job: JobDoc) => Promise<StepOutput>) | null {
  return DRIVEN_STATES.includes(state) ? (HANDLERS[state] ?? null) : null;
}
