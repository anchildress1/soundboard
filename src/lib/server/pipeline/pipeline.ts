import { readFile, rm } from 'node:fs/promises';
import { captureException, captureMessage, startSpan, type Span } from '@sentry/sveltekit';
import { scrubUrl } from '#lib/scrub.js';
import {
  DRIVEN_STATES,
  type Chunk,
  type JobState,
  type Pick,
  type PickFields,
  type Wait,
} from '#lib/types.js';
import { approvedGuides } from '#lib/server/artist/guides.js';
import { analyzeChunk } from '#lib/server/ai/chunk-analyst.js';
import { chunkCount, measureFile, probe, WINDOW_SEC } from '#lib/server/media/ffmpeg.js';
import { cutWindowClip, measureWindow } from '#lib/server/media/window.js';
import { objectInfo, signedReadUrl, sweepUploads } from '#lib/server/media/gcs.js';
import { audienceEvidence, releaseList, type AudienceEvidence } from './hashtags';
import {
  claimJob,
  fail,
  MAX_MINUTES,
  listChunks,
  listPicks,
  objectIs,
  pickIn,
  markFinalChunk,
  markUploadStarted,
  ok,
  outcomeUnknown,
  releaseJob,
  type JobDoc,
} from '#lib/server/jobs/jobs.js';
import { DEFAULT_INFLUENCE } from '#lib/influence.js';
import { artistJob, listFacts, recentFeedback, recordPublish } from '#lib/server/artist/memory.js';
import { artistProfile, type ArtistProfile } from '#lib/server/artist/profile.js';
import type { Tx } from '#lib/server/core/db.js';
import { NO_ARTIST } from '#lib/server/core/errors.js';
import {
  hasModelTime,
  ModelBusy,
  modelFor,
  ModelQuotaSpent,
  stepDeadline,
} from '#lib/server/ai/model.js';
import { hookStep, renderStep } from './short';
import { runPick } from '#lib/server/ai/smart-pick.js';
import type { JobPatch } from '#lib/server/jobs/rows.js';
import { invokeAgent } from '#lib/server/core/tracing.js';
import { quotaResetAt } from '#lib/server/core/quota.js';
import {
  evidenceExpiry,
  readEvidence,
  rejectedChannels,
  withoutRejected,
} from '#lib/server/research/evidence.js';
import { pickOutcomes } from '#lib/server/research/outcomes.js';
import { enqueue } from '#lib/server/research/queue.js';
import {
  expired,
  failRun,
  getRun,
  RESEARCH_MAX_MS,
  startRun,
  type ResearchLimit,
} from '#lib/server/research/runs.js';
import {
  accessTokenFor,
  ChannelMismatch,
  finalChunk,
  identityFailure,
  outOfTime,
  ownChannelUploads,
  quotaSpent,
  readBack,
  sourceRange,
  startResumableUpload,
  thumbnailImage,
  uploadChunk,
  uploadFailure,
  uploadOffset,
  type Access,
  type ChunkResult,
  type ReadBack,
} from '#lib/server/platforms/youtube/index.js';

export const VERIFY_ATTEMPTS = 10;
const RECENT_COUNT = 3;
/** The end of each step's budget held back for cleanup and the release write. */
const PERSIST_RESERVE_MS = 5_000;

type Patch = JobPatch;
/**
 * A step's job patch, plus output to store only if the claim is still valid at release. `alsoWrite`
 * runs inside the release transaction for writes outside the job row.
 */
type StepOutput = Patch & {
  pick?: Pick;
  chunk?: Chunk;
  clearChunks?: boolean;
  wait?: Wait;
  alsoWrite?: (tx: Tx) => Promise<void>;
};

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

async function analyze(job: JobDoc, deadline: number): Promise<StepOutput> {
  const duration = job.probe?.durationSec ?? 0;
  // Windows prepared under another window length can't be resumed; prep counts them again.
  if (job.chunkCount !== chunkCount(duration)) {
    return { ...ok({ state: 'PREP', chunkIndex: 0 }), clearChunks: true };
  }
  const held = quotaHold(job);
  if (held) return held;
  const index = job.chunkIndex;
  const startSec = index * WINDOW_SEC;
  const endSec = Math.min(startSec + WINDOW_SEC, duration);
  const url = await signedReadUrl(job.object);
  const by = deadline - PERSIST_RESERVE_MS;
  const path = await cutWindowClip(url, startSec, endSec, by);
  try {
    const measurements = await measureWindow(url, startSec, endSec, by);
    const chunk = await analyzeChunk(
      {
        songTitle: job.songTitle,
        notes: job.notes,
        startSec,
        durationSec: endSec - startSec,
        measurements,
        clip: await readFile(path),
        index,
      },
      by,
    );
    const next = index + 1;
    return unlimited(job, {
      ...ok({ chunkIndex: next, state: next >= job.chunkCount ? 'PICK' : 'ANALYZE' }),
      chunk,
    });
  } finally {
    await rm(path, { force: true });
  }
}

async function pick(job: JobDoc, deadline: number): Promise<StepOutput> {
  const held = quotaHold(job);
  if (held) return held;
  // The budget covers the identity, catalog and search reads too, not only the model calls.
  const by = deadline - PERSIST_RESERVE_MS;
  const artist = await artistProfile(job.ownerUid);
  if (!artist) return { wait: NO_ARTIST };
  const recent = await ownChannelUploads(job.ownerUid, RECENT_COUNT, by, {
    'job.id': job.id,
  });
  if (!Array.isArray(recent)) return recent;
  const gate = await researchFor(job, artist.id, by);
  if ('wait' in gate) return gate;
  const research: Research = gate;
  const [memory, chunks, picks] = await Promise.all([
    artistJob(job),
    listChunks(job.id),
    listPicks(job.id),
  ]);
  const withThumbs = await Promise.all(
    recent.map(async (v) => ({
      ...v,
      thumbnail: v.thumbnailUrl ? await thumbnailImage(v.thumbnailUrl, by) : null,
    })),
  );
  return invokeAgent('smart-pick', modelFor('smart-pick'), async (span) => {
    let audience = job.audience;
    const limits: string[] = [...research.limits];
    try {
      audience ??= await audienceEvidence(chunks, job.probe?.durationSec ?? null, by);
    } catch (error) {
      if (outOfTime(error)) return { wait: YOUTUBE_BUSY };
      // Not a failure: the draft goes ahead on no genre evidence, stores none, and says so.
      if (!quotaSpent(error)) throw error;
      limits.push('genre-search-unavailable');
    }
    // The genre search is one per job: every outcome from here keeps it.
    const keep: Patch = audience ? { audience } : {};
    if (!hasModelTime('smart-pick', by)) return { ...keep, wait: 'model busy' };
    try {
      return await pickWith(artist, audience ?? noAudience(), limits, keep, span);
    } catch (error) {
      throw new StepFailure(error, keep);
    }
  });

  async function pickWith(
    artist: ArtistProfile,
    audience: AudienceEvidence,
    limits: string[],
    keep: Patch,
    span: Span,
  ): Promise<StepOutput> {
    const [[facts, feedback, { voice, brand, influence }, outcomes], found] = await Promise.all([
      memoryFor(artist, memory),
      evidenceFor(research.runId),
    ]);
    const result = await runPick(
      {
        artist,
        songTitle: job.songTitle,
        notes: job.notes,
        measurements: job.measurements,
        probe: job.probe,
        recent: withThumbs,
        candidateLists: [
          ...audience.candidateLists,
          ...(found?.evidence.releases.map(releaseList) ?? []),
        ],
        audience: audience.top,
        skipped: picks
          .filter((p) => p.skipped)
          .map(({ title, description }) => ({ title, description })),
        chunks,
        facts,
        feedback,
        voice,
        brand,
        influence,
        evidence: found?.evidence ?? null,
        outcomes,
        limits,
      },
      by,
      span,
    );
    if (!result) throw new Error('The model reply did not parse as a recommendation.');
    const version = (picks.at(-1)?.version ?? 0) + 1;
    span.setAttribute('pick.version', version);
    return unlimited(job, {
      ...ok({ state: 'REVIEW', pickVersion: version, ...keep }),
      // Each stored pick carries the running total, so a re-run never loses earlier pick time.
      pick: {
        ...result.pick,
        version,
        modelMs: result.ms + (picks.at(-1)?.modelMs ?? 0),
        researchRunId: research.runId,
        evidenceExpiresAt: found?.expiresAt ?? null,
      },
    });
  }
}

const noAudience = (): AudienceEvidence => ({
  retrievedAt: Date.now(),
  query: '',
  candidateLists: [],
  top: [],
});

const RESEARCHING: Wait = 'researching similar artists';

type Research = { runId: string; limits: ResearchLimit[] };

/**
 * The research gate (research R3), after 004's waits. With no run, or an expired one, it starts
 * one and waits; while one runs under 10 minutes, it waits. A queue that can't take the first
 * delivery fails the run and the pick goes ahead without it: never a step failure. A failed run
 * stays failed until a re-run clears it (T054).
 */
async function researchFor(
  job: JobDoc,
  artistId: string,
  deadline: number,
): Promise<Research | { wait: Wait }> {
  const run = await getRun(job.id);
  if (!run || expired(run)) {
    const started = await startRun(job, artistId);
    try {
      await enqueue({ jobId: job.id, uid: job.ownerUid, runId: started.id, seq: 0 }, 0, deadline);
      return { wait: RESEARCHING };
    } catch (error) {
      // A timeout may still have created the task: its delivery then finds the run failed.
      captureException(error, { tags: { component: 'research-queue', 'job.id': job.id } });
      await failRun(job.id, 'research-unavailable', 'research-unavailable');
      return { runId: started.id, limits: ['research-unavailable'] };
    }
  }
  const finished = run.stage === 'done' || run.stage === 'failed';
  if (!finished && Date.now() - run.startedAt.getTime() < RESEARCH_MAX_MS) {
    return { wait: RESEARCHING };
  }
  const limits = run.limits as ResearchLimit[];
  const unfinished = run.stage !== 'done' && !limits.includes('research-unavailable');
  return { runId: run.id, limits: unfinished ? [...limits, 'research-unfinished'] : limits };
}

/**
 * Facts, feedback, the approved guides with their slider settings, and the artist's own results;
 * all but the facts only on jobs that use the memory.
 */
const memoryFor = (artist: ArtistProfile, memory: boolean) =>
  Promise.all([
    listFacts(artist, memory),
    memory ? recentFeedback(artist.id) : [],
    memory ? approvedGuides(artist.id) : { voice: null, brand: null, influence: DEFAULT_INFLUENCE },
    memory ? pickOutcomes(artist.id) : [],
  ]);

/** The run's peer evidence while fresh, without the artist's rejected channels, and when it lapses. */
async function evidenceFor(runId: string) {
  const stored = await readEvidence(runId);
  if (!stored) return null;
  const evidence = withoutRejected(stored.evidence, await rejectedChannels());
  return { evidence, expiresAt: evidenceExpiry(stored.retrievedAt) };
}

const OUTCOME_UNKNOWN: Wait = 'upload outcome unknown';
const DAILY_LIMIT: Wait = 'Daily upload limit reached. Try tomorrow.';
const RECONNECT: Wait = 'reconnect YouTube';
const YOUTUBE_BUSY: Wait = 'waiting on YouTube';
const SOURCE_EXPIRED = 'The source video has expired from storage.';

/** A wait is never a failure: it ends the failure streak and clears a stale error. */
const pause = (wait: Wait, patch: Patch = {}): StepOutput => ({ ...ok(patch), wait });

const limited = (job: JobDoc, now: number) => job.limitUntil !== null && now < job.limitUntil;

/**
 * Holds a model step, before any media or model work, while the per-day model quota is spent. Not a
 * failure, so the streak and error stay as they were.
 */
const quotaHold = (job: JobDoc): StepOutput | null =>
  limited(job, Date.now()) ? { wait: 'model quota spent' } : null;

/** A step that reached YouTube or the model clears a limit that has passed. */
const unlimited = (job: JobDoc, output: StepOutput): StepOutput =>
  job.limitUntil ? { ...output, limitUntil: null } : output;

/** A spent daily limit or a refused grant becomes its wait; any other error is rethrown. */
async function youtubeWait(
  job: JobDoc,
  error: unknown,
  access: Access,
  now: number,
): Promise<StepOutput> {
  const failure = uploadFailure(error);
  if (failure === 'quota-spent') return pause(DAILY_LIMIT, { limitUntil: quotaResetAt(now) });
  if (failure !== 'access-lost') throw error;
  // The grant is dead: Connections must offer Reconnect, the fix the wait asks for.
  await access.refused({ 'job.id': job.id });
  return pause(RECONNECT);
}

/**
 * A fresh token for the job's destination grant, or the step's wait: reconnect when there is no
 * grant, and waiting on YouTube when the refresh stalls or can't start before `deadline`. A changed
 * channel and every other refresh error still throw.
 */
async function destinationAccess(
  job: JobDoc,
  channelId: string,
  deadline: number,
): Promise<Access | StepOutput> {
  try {
    return (await accessTokenFor(job.ownerUid, channelId, deadline)) ?? pause(RECONNECT);
  } catch (error) {
    if (!(error instanceof ChannelMismatch) && identityFailure(error) === 'busy') {
      return pause(YOUTUBE_BUSY);
    }
    throw error;
  }
}

const granted = (access: Access | StepOutput): access is Access => 'token' in access;

/**
 * One upload step. The grant is checked before every YouTube call, chunk PUTs included: the session
 * URI alone authorizes a PUT, so a revoked or reconnected-elsewhere grant must stop the upload
 * here. A spent daily limit and a refused grant are waits, never failures.
 */
async function publishing(job: JobDoc, deadline: number): Promise<StepOutput> {
  if (!job.destination || !job.finalFields) return fail('PUBLISHING', 'Nothing to upload.');
  // No YouTube call at all: the page polls this wait, and polling must spend no quota.
  if (outcomeUnknown(job)) return pause(OUTCOME_UNKNOWN);
  // Nor while the daily limit is spent: the quota is project-wide, so any call fails until reset.
  const now = Date.now();
  if (limited(job, now)) return pause(DAILY_LIMIT);
  const access = await destinationAccess(job, job.destination.channelId, deadline);
  if (!granted(access)) return access;
  try {
    return unlimited(
      job,
      job.upload
        ? await sendChunk(job, job.upload)
        : await initiate(job, access.token, job.finalFields),
    );
  } catch (error) {
    return youtubeWait(job, error, access, now);
  }
}

async function initiate(job: JobDoc, token: string, fields: PickFields): Promise<StepOutput> {
  const info = await objectInfo(job.object);
  if (!info) return fail('PUBLISHING', SOURCE_EXPIRED);
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
      if (!source) return fail('PUBLISHING', SOURCE_EXPIRED);
      // Marked once GCS answered and just before the PUT: a source that never opened sent nothing,
      // and a lost reply to this PUT must never lead to a second upload.
      if (finalChunk(result.next, total)) {
        try {
          await markFinalChunk(job.id);
        } catch (error) {
          // The open GCS read would otherwise hold its socket until the timeout. A failed cancel is
          // reported on its own so the marker's error stays the one the step records.
          await source.body?.cancel().catch((cancelError: unknown) =>
            captureException(cancelError, {
              tags: { 'job.id': job.id, component: 'gcs-cancel' },
            }),
          );
          throw error;
        }
        finalSent = true;
      }
      result = await uploadChunk(sessionUri, source, result.next, total);
    }
  } catch (error) {
    if (uploadFailure(error) !== 'session-lost') throw error;
    // Tagged with the job only: the session URI alone authorizes uploads.
    const tags = { 'job.id': job.id };
    if (finalSent) {
      captureMessage('Upload session lost after final chunk', { level: 'warning', tags });
      return pause(OUTCOME_UNKNOWN, { upload: null });
    }
    captureMessage('Upload session lost; restarting', { level: 'info', tags });
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

/** Verified uploads on artist jobs join the artist's memory; no one else's do. */
async function recordVerified(tx: Tx, job: JobDoc, videoId: string): Promise<void> {
  if (!job.finalFields || !job.artistId || !(await artistJob(job, tx))) return;
  const proposed = job.pickVersion === null ? null : await pickIn(tx, job.id, job.pickVersion);
  const { finalFields: fields } = job;
  // A Short's pick is its parent's approved text, not a recommendation of its own.
  const own = proposed && job.parentId === null ? proposed : null;
  await recordPublish(tx, job.artistId, {
    videoId,
    url: `https://youtu.be/${videoId}`,
    jobId: job.id,
    fields,
    status: 'VERIFIED',
    at: Date.now(),
    recommendation: own?.recommendation
      ? {
          approach: own.recommendation.approach,
          intendedOutcome: own.recommendation.intendedOutcome,
          evidence: own.recommendation.evidence,
        }
      : null,
    influence: own?.influence ?? null,
    editedBeforeApproval:
      proposed !== null &&
      (proposed.title !== fields.title ||
        proposed.description !== fields.description ||
        proposed.tags.join('\n') !== fields.tags.join('\n')),
  });
}

async function verify(job: JobDoc, deadline: number): Promise<StepOutput> {
  if (!job.destination || !job.videoId) {
    return fail('CLAIMED_COMPLETE', 'Cannot read the upload back.');
  }
  const now = Date.now();
  if (limited(job, now)) return pause(DAILY_LIMIT);
  const access = await destinationAccess(job, job.destination.channelId, deadline);
  if (!granted(access)) return access;
  let video: ReadBack | null;
  try {
    video = await readBack(access.token, job.videoId);
  } catch (error) {
    return youtubeWait(job, error, access, now);
  }
  return unlimited(job, verified(job, job.videoId, video));
}

function verified(job: JobDoc, videoId: string, video: ReadBack | null): StepOutput {
  if (video?.status === 'rejected') {
    return fail('CLAIMED_COMPLETE', `YouTube ${video.uploadStatus} the upload.`);
  }
  if (video?.status === 'accepted') {
    return {
      ...ok({ state: 'VERIFIED' }),
      alsoWrite: (tx) => recordVerified(tx, job, videoId),
    };
  }
  if (video?.uploadStatus) {
    captureMessage('Unknown YouTube uploadStatus', {
      level: 'warning',
      tags: { 'job.id': job.id, uploadStatus: video.uploadStatus },
    });
  }
  const attempts = job.verifyAttempts + 1;
  if (attempts < VERIFY_ATTEMPTS) return { verifyAttempts: attempts };
  if (!video) return fail('CLAIMED_COMPLETE', 'YouTube never returned the uploaded video.');
  return fail(
    'CLAIMED_COMPLETE',
    video.uploadStatus
      ? `YouTube kept the upload at "${video.uploadStatus}".`
      : 'YouTube never gave the upload a status.',
  );
}

/** A step's handler; `deadline` is the step budget's end, started when the claim was taken. */
type Handler = (job: JobDoc, deadline: number) => Promise<StepOutput>;

const HANDLERS: Partial<Record<JobState, Handler>> = {
  PREP: prep,
  ANALYZE: analyze,
  PICK: pick,
  HOOK: async (job, deadline) => quotaHold(job) ?? unlimited(job, await hookStep(job, deadline)),
  RENDER: renderStep,
  PUBLISHING: publishing,
  CLAIMED_COMPLETE: verify,
};

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

/**
 * Runs the claimed step's handler; a throw becomes the failure patch, keeping any finished output.
 * A busy or spent model is a wait instead.
 */
async function runHandler(job: JobDoc, handler: Handler, deadline: number): Promise<StepOutput> {
  try {
    return await startSpan(
      {
        op: 'pipeline.step',
        name: `step ${job.state}`,
        attributes: { 'job.id': job.id, 'job.chunk': job.chunkIndex },
      },
      () => handler(job, deadline),
    );
  } catch (error) {
    const failure = error instanceof StepFailure ? error : null;
    const cause = failure ? failure.cause : error;
    // Provider waits aren't failures: no strike, no report, and the finished work is kept.
    if (cause instanceof ModelBusy) return { ...failure?.keep, wait: 'model busy' };
    if (cause instanceof ModelQuotaSpent) {
      return { ...failure?.keep, limitUntil: cause.until, wait: 'model quota spent' };
    }
    captureException(cause, { tags: { step: job.state } });
    return { ...failurePatch(job, error), ...failure?.keep };
  }
}

/** Runs exactly one pipeline step for the job: claims it, runs, and releases it with its result. */
export async function runStep(snapshot: JobDoc): Promise<StepResult> {
  if (snapshot.state === 'AWAITING_UPLOAD') return await startOnceUploaded(snapshot);
  if (!handlerFor(snapshot.state)) return {};

  const claimed = await claimJob(snapshot.id);
  if (!claimed) return { wait: 'step running in another tab' };
  const deadline = stepDeadline();
  const { token, job } = claimed;
  const handler = handlerFor(job.state);
  if (!handler) {
    await releaseJob(job.id, token, job.state);
    return {};
  }
  const output = await runHandler(job, handler, deadline);
  const { pick: newPick, chunk, clearChunks, wait: woke, alsoWrite, ...patch } = output;
  const writes = { pick: newPick, chunk, clearChunks, alsoWrite };
  if (!(await releaseJob(job.id, token, job.state, patch, writes))) {
    captureMessage('Step result dropped: the claim lapsed or the job moved on', {
      level: 'warning',
      tags: { step: job.state },
    });
  }
  if (woke) return { wait: woke };
  const stillVerifying = job.state === 'CLAIMED_COMPLETE' && patch.state === undefined;
  return stillVerifying ? { wait: 'waiting on YouTube' } : {};
}

/**
 * The browser's upload has landed once the job's current object exists; then the pipeline starts.
 * It runs as a claimed step under the step deadline. An orphan from an older session never counts,
 * a pick that swapped the object meanwhile keeps the job waiting, and a slow or failing storage read
 * is only a wait: the open page asks again.
 */
async function startOnceUploaded(snapshot: JobDoc): Promise<StepResult> {
  const claimed = await claimJob(snapshot.id);
  if (!claimed) return { wait: 'step running in another tab' };
  const deadline = stepDeadline();
  const { token, job } = claimed;
  let landed = false;
  if (job.state === 'AWAITING_UPLOAD') {
    try {
      landed = (await objectInfo(job.object, deadline)) !== null;
    } catch (error) {
      captureException(error, { tags: { step: job.state } });
    }
  }
  const moved = await releaseJob(
    job.id,
    token,
    job.state,
    landed ? { state: 'PREP', videoUpload: null } : {},
    { guard: objectIs(job.object) },
  );
  // Orphans are objects of displaced sessions; the bucket's 7-day rule takes any this misses.
  if (landed && moved) await sweepUploads(job.id, job.object, deadline);
  return {};
}

/** The step to run for a state the page drives, or null for any other state. */
function handlerFor(state: JobState): Handler | null {
  return DRIVEN_STATES.includes(state) ? (HANDLERS[state] ?? null) : null;
}
