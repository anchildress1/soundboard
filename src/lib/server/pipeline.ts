import * as Sentry from '@sentry/sveltekit';
import { DRIVEN_STATES, type Chunk, type JobState, type Pick, type Wait } from '$lib/types';
import { approvedBrand } from './brand';
import { analyzeChunk } from './chunk-analyst';
import { chunkCount, measureFile, probe, WINDOW_SEC } from './ffmpeg';
import { objectInfo, signedReadUrl } from './gcs';
import { audienceEvidence, type AudienceEvidence } from './hashtags';
import {
  claimJob,
  fail,
  MAX_MINUTES,
  listChunks,
  listPicks,
  ok,
  releaseJob,
  transitionJob,
  type JobDoc,
} from './jobs';
import { listFacts, PUBLIC_FACTS, recentFeedback, recordPublish } from './memory';
import { modelStatus, stepDeadline } from './model';
import { hookStep, renderStep } from './short';
import { runPick } from './smart-pick';
import { accessToken } from './tokens';
import { invokeAgent } from './tracing';
import {
  readBack,
  recentVideos,
  startResumableUpload,
  thumbnailDataUrl,
  uploadChunk,
  uploadOffset,
  YouTubeError,
} from './youtube';

export const VERIFY_ATTEMPTS = 10;
const RECENT_COUNT = 3;

type Patch = Partial<JobDoc>;
/** A step's job patch, plus output to store only if the claim is still valid at release. */
type StepOutput = Patch & { pick?: Pick; chunk?: Chunk };

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
  const limit = MAX_MINUTES[job.owner];
  if (probed.durationSec > limit * 60) {
    return fail(
      'PREP',
      `Videos are capped at ${limit} minutes here; this one runs ${(probed.durationSec / 60).toFixed(1)}.`,
    );
  }
  const measurements = await measureFile(url, probed.durationSec);
  return ok({
    state: 'ANALYZE',
    probe: probed,
    measurements,
    contentType: info.contentType,
    chunkCount: chunkCount(probed.durationSec),
    chunkIndex: 0,
  });
}

async function analyze(job: JobDoc): Promise<StepOutput> {
  const index = job.chunkIndex;
  const startSec = index * WINDOW_SEC;
  const duration = job.probe?.durationSec ?? 0;
  const chunk = await analyzeChunk({
    url: await signedReadUrl(job.object),
    index,
    startSec,
    durationSec: Math.min(WINDOW_SEC, duration - startSec),
    songTitle: job.songTitle,
    notes: job.notes,
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
  // Demo jobs read Nathan's memory so they run like his; they never write it.
  const nathan = job.owner !== 'visitor';
  const [chunks, picks, recent] = await Promise.all([
    listChunks(job.id),
    listPicks(job.id),
    recentVideos(RECENT_COUNT, job.liveVideoId),
  ]);
  const withThumbs = await Promise.all(
    recent.map(async (v) => ({
      ...v,
      thumbnail: v.thumbnailUrl ? await thumbnailDataUrl(v.thumbnailUrl) : null,
    })),
  );
  return invokeAgent('smart-pick', async (span) => {
    const audience =
      job.audience ??
      (await audienceEvidence(chunks, job.probe?.durationSec ?? null, job.liveVideoId));
    try {
      return await pickWith(audience, span);
    } catch (error) {
      // The genre search is one per job; a failed model call must not spend it again on retry.
      throw new StepFailure(error, { audience });
    }
  });

  async function pickWith(audience: AudienceEvidence, span: Sentry.Span): Promise<StepOutput> {
    const [facts, feedback, brand] = nathan
      ? await Promise.all([
          listFacts({ seed: job.owner === 'nathan' }),
          recentFeedback(),
          approvedBrand(),
        ])
      : [PUBLIC_FACTS, [], null];
    const result = await runPick(
      {
        songTitle: job.songTitle,
        notes: job.notes,
        chunks,
        measurements: job.measurements,
        probe: job.probe,
        recent: withThumbs,
        candidates: audience.hashtags,
        tagCandidates: audience.tags,
        audience: audience.top,
        facts,
        feedback,
        skipped: picks
          .filter((p) => p.skipped)
          .map(({ title, description }) => ({ title, description })),
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
        audience,
        pickVersion: version,
      }),
      // Each stored pick carries the running total, so a re-run never loses earlier pick time.
      pick: { ...result.pick, version, modelMs: result.ms + (picks.at(-1)?.modelMs ?? 0) },
    };
  }
}

const sessionGone = (error: unknown) =>
  error instanceof YouTubeError && (error.status === 404 || error.status === 410);

const quotaSpent = (error: unknown) =>
  error instanceof YouTubeError && error.status === 403 && /quota/i.test(error.message);

async function publishing(job: JobDoc): Promise<Patch> {
  if (!job.channel || !job.finalFields) return fail('PUBLISHING', 'Nothing to upload.');
  const token = await accessToken(job.channel);
  if (!token) {
    return {
      state: 'PAYLOAD',
      payload: job.finalFields,
      error: 'The upload channel is not connected.',
    };
  }
  if (!job.upload) {
    const info = await objectInfo(job.object);
    if (!info) return fail('PUBLISHING', 'The source video has expired from storage.');
    try {
      const sessionUri = await startResumableUpload(
        token,
        job.finalFields,
        info.size,
        job.contentType,
      );
      return ok({
        upload: { sessionUri, total: info.size },
        uploadProgress: { sent: 0, total: info.size },
      });
    } catch (error) {
      if (quotaSpent(error)) {
        return {
          state: 'PAYLOAD',
          payload: job.finalFields,
          error: 'YouTube upload quota is spent for today.',
        };
      }
      throw error;
    }
  }
  const { sessionUri, total } = job.upload;
  let status: Awaited<ReturnType<typeof uploadOffset>>;
  try {
    status = await uploadOffset(sessionUri, total);
  } catch (error) {
    // An expired or invalidated session can't resume; the next step opens a fresh one.
    if (sessionGone(error)) return ok({ upload: null, uploadProgress: null });
    throw error;
  }
  const result = status.done
    ? status
    : await uploadChunk(sessionUri, await signedReadUrl(job.object), status.next, total);
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

async function verify(job: JobDoc): Promise<Patch> {
  const token = job.channel ? await accessToken(job.channel) : null;
  if (!token || !job.videoId) return fail('CLAIMED_COMPLETE', 'Cannot read the upload back.');
  const video = await readBack(token, job.videoId);
  if (video && REJECTED_UPLOADS.has(video.uploadStatus ?? '')) {
    return fail('CLAIMED_COMPLETE', `YouTube ${video.uploadStatus} the upload.`);
  }
  if (video && ACCEPTED_UPLOADS.has(video.uploadStatus ?? '')) {
    if (job.owner === 'nathan' && job.finalFields) {
      await recordPublish({
        videoId: job.videoId,
        url: `https://youtu.be/${job.videoId}`,
        jobId: job.id,
        fields: job.finalFields,
        status: 'VERIFIED',
        at: Date.now(),
      });
    }
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

const NEEDS_MODEL: readonly JobState[] = ['ANALYZE', 'PICK', 'HOOK'];

/** A step that throws counts as a failure; two in a row stop the job at that step for a retry. */
export function failurePatch(job: JobDoc, error: unknown): Patch {
  const message = error instanceof Error ? error.message : String(error);
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
 * Runs exactly one pipeline step for the job. Model loading or busy returns a wait at once, without
 * claiming the job; otherwise the step claims the job, runs, and releases it with its result.
 */
export async function runStep(snapshot: JobDoc): Promise<StepResult> {
  if (snapshot.state === 'AWAITING_UPLOAD') {
    if (await objectInfo(snapshot.object)) {
      await transitionJob(snapshot.id, ['AWAITING_UPLOAD'], { state: 'PREP' });
    }
    return {};
  }
  if (!HANDLERS[snapshot.state] || !DRIVEN_STATES.includes(snapshot.state)) return {};

  const claimed = await claimJob(snapshot.id);
  if (!claimed) return { wait: 'step running in another tab' };
  const { token, job } = claimed;
  const handler = HANDLERS[job.state];
  if (!handler || !DRIVEN_STATES.includes(job.state)) {
    await releaseJob(job.id, token, job.state);
    return {};
  }
  // Readiness is checked against the claimed state, which may be ahead of the caller's snapshot.
  const wait = NEEDS_MODEL.includes(job.state) ? await modelWait() : undefined;
  if (wait) {
    await releaseJob(job.id, token, job.state);
    return { wait };
  }

  let output: StepOutput;
  try {
    output = await Sentry.startSpan(
      {
        op: 'pipeline.step',
        name: `step ${job.state}`,
        attributes: { 'job.id': job.id, 'job.chunk': job.chunkIndex },
      },
      () => handler(job),
    );
  } catch (error) {
    const failure = error instanceof StepFailure ? error : null;
    Sentry.captureException(failure ? failure.cause : error, { tags: { step: job.state } });
    output = { ...failurePatch(job, error), ...failure?.keep };
  }
  const { pick: newPick, chunk, ...patch } = output;
  if (!(await releaseJob(job.id, token, job.state, patch, { pick: newPick, chunk }))) {
    Sentry.captureMessage('Step result dropped: the claim lapsed or the job moved on', {
      level: 'warning',
      tags: { step: job.state },
    });
  }
  return job.state === 'CLAIMED_COMPLETE' && patch.state === undefined
    ? { wait: 'waiting on YouTube' }
    : {};
}
