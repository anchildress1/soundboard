import * as Sentry from '@sentry/sveltekit';
import { DRIVEN_STATES, type JobState, type Wait } from '$lib/types';
import { analyzeChunk } from './chunk-analyst';
import { chunkCount, measureFile, probe, WINDOW_SEC } from './ffmpeg';
import { objectInfo, signedReadUrl } from './gcs';
import { hashtagCandidates } from './hashtags';
import {
  claimJob,
  fail,
  MAX_MINUTES,
  listChunks,
  listPicks,
  releaseJob,
  saveChunk,
  savePick,
  updateJob,
  type JobDoc,
} from './jobs';
import { listFacts, PUBLIC_FACTS, recentFeedback, recordPublish } from './memory';
import { modelStatus } from './model';
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
const RECENT_COUNT = 5;

type Patch = Partial<JobDoc>;
const ok = (patch: Patch): Patch => ({ ...patch, consecutiveFailures: 0, error: null });

async function prep(job: JobDoc): Promise<Patch> {
  const info = await objectInfo(job.object);
  if (!info) return fail('PREP', 'The upload never reached storage. Start a new run.');
  const url = await signedReadUrl(job.object);
  const probed = await probe(url);
  if (!probed.hasAudio) return fail('PREP', 'This video has no audio track.');
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

async function analyze(job: JobDoc): Promise<Patch> {
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
  await saveChunk(job.id, chunk);
  const next = index + 1;
  return ok({ chunkIndex: next, state: next >= job.chunkCount ? 'PICK' : 'ANALYZE' });
}

async function pick(job: JobDoc): Promise<Patch> {
  const nathan = job.owner === 'nathan';
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
    const candidates =
      job.hashtagCandidates ??
      (await hashtagCandidates(
        recent.map((v) => v.description),
        chunks,
      ));
    const [facts, feedback] = nathan
      ? await Promise.all([listFacts(), recentFeedback()])
      : [PUBLIC_FACTS, []];
    const result = await runPick({
      songTitle: job.songTitle,
      notes: job.notes,
      useArtistName: nathan || job.sampleId !== null,
      chunks,
      measurements: job.measurements,
      recent: withThumbs,
      candidates,
      facts,
      feedback,
      skipped: picks
        .filter((p) => p.skipped)
        .map(({ title, description }) => ({ title, description })),
    });
    if (!result) throw new Error('The model reply did not parse as a recommendation.');
    const version = (picks.at(-1)?.version ?? 0) + 1;
    span.setAttribute('pick.version', version);
    await savePick(job.id, { ...result.pick, version, modelMs: result.ms });
    return ok({ state: 'REVIEW', hashtagCandidates: candidates });
  });
}

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
  const status = await uploadOffset(sessionUri, total);
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

async function verify(job: JobDoc): Promise<Patch> {
  const token = job.channel ? await accessToken(job.channel) : null;
  if (!token || !job.videoId) return fail('CLAIMED_COMPLETE', 'Cannot read the upload back.');
  const video = await readBack(token, job.videoId);
  if (video) {
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

const HANDLERS: Partial<Record<JobState, (job: JobDoc) => Promise<Patch>>> = {
  PREP: prep,
  ANALYZE: analyze,
  PICK: pick,
  PUBLISHING: publishing,
  CLAIMED_COMPLETE: verify,
};

const NEEDS_MODEL: readonly JobState[] = ['ANALYZE', 'PICK'];

/** A step that throws counts as a failure; two in a row stop the job at that step for a retry. */
export function failurePatch(job: JobDoc, error: unknown): Patch {
  const message = error instanceof Error ? error.message : String(error);
  const failures = job.consecutiveFailures + 1;
  if (failures >= 2) return { ...fail(job.state, message), consecutiveFailures: failures };
  return { consecutiveFailures: failures, error: message };
}

export type StepResult = { wait?: Wait };

/**
 * Runs exactly one pipeline step for the job. Model loading or busy returns a wait at once, without
 * claiming the job; otherwise the step claims the job, runs, and releases it with its result.
 */
export async function runStep(job: JobDoc): Promise<StepResult> {
  if (job.state === 'AWAITING_UPLOAD') {
    if (await objectInfo(job.object)) await updateJob(job.id, { state: 'PREP' });
    return {};
  }
  const handler = HANDLERS[job.state];
  if (!handler || !DRIVEN_STATES.includes(job.state)) return {};

  if (NEEDS_MODEL.includes(job.state)) {
    const status = await modelStatus();
    if (status === 'loading') return { wait: 'waking model' };
    if (status === 'busy') return { wait: 'waiting on another run' };
  }

  const token = await claimJob(job.id);
  if (!token) return { wait: 'step running in another tab' };

  let patch: Patch;
  try {
    patch = await Sentry.startSpan(
      {
        op: 'pipeline.step',
        name: `step ${job.state}`,
        attributes: { 'job.id': job.id, 'job.chunk': job.chunkIndex },
      },
      () => handler(job),
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { step: job.state } });
    patch = failurePatch(job, error);
  }
  await releaseJob(job.id, token, patch);
  return job.state === 'CLAIMED_COMPLETE' && patch.state === undefined
    ? { wait: 'waiting on YouTube' }
    : {};
}
