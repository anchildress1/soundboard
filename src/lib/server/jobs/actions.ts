import { captureException } from '@sentry/sveltekit';
import { canCutShort, cutErrors, SHORT_MIN_SEC, tenth } from '#lib/short.js';
import { containsWords, parseHashtags, validateFields } from '#lib/metadata.js';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  SHORT_SOURCE_STATES,
  type JobState,
  type Pick,
  type PickFields,
  type Reframe,
} from '#lib/types.js';
import { query } from '#lib/server/core/db.js';
import { jobs } from '#lib/server/core/schema.js';
import {
  createShort,
  generationSql,
  getJob,
  latestPick,
  lockJob,
  objectIs,
  outcomeUnknown,
  pickIn,
  skipAndRepick,
  transitionJob,
  uploadGeneration,
  type JobDoc,
} from './jobs';
import { jobSet } from './rows';
import { approvalFeedback, writeFeedback } from '#lib/server/artist/memory.js';
import { tagPool } from '#lib/server/ai/smart-pick.js';
import { stepDeadline } from '#lib/server/ai/model.js';
import {
  accessTokenFor,
  getConnection,
  uploadFailure,
  videoChannel,
  videoIdFromUrl,
  type Access,
} from '#lib/server/platforms/youtube/index.js';
import { ActionError } from '#lib/server/core/errors.js';
import { decrypt, UPLOAD_KMS_MS } from '#lib/server/core/kms.js';
import { cancelUploadSession, objectInfo, sweepUploads } from '#lib/server/media/gcs.js';
import { STALE_ANALYSIS, staleAnalysis } from '#lib/server/pipeline/short.js';

function requireState(job: JobDoc, states: JobState[]): void {
  if (!states.includes(job.state))
    throw new ActionError(409, `Not allowed while the job is ${job.state}.`);
}

/**
 * Edited tags follow the pick's rules: the job's tag candidates plus the pick's own artist name,
 * stored when it ran so a later rename can't break the draft. The artist tag appears exactly once
 * and is the one tag that may contain the song title (a self-titled song).
 */
function tagError(tags: string[], job: JobDoc, draft: Pick): string | undefined {
  const artist = draft.artistName;
  const others = tags.filter((tag) => tag.trim().toLowerCase() !== artist?.toLowerCase());
  if (artist && tags.length - others.length !== 1) return `Keep the artist tag: ${artist}.`;
  const titled = others.filter((tag) => containsWords(tag, job.songTitle));
  if (titled.length > 0) return `Tags can't contain the song title: ${titled.join(', ')}`;
  const allowed = new Set(
    tagPool({
      artistName: artist,
      candidateLists: job.audience?.candidateLists ?? [
        {
          videoId: job.videoId ?? job.id,
          title: draft.title,
          hashtags: draft.hashtags,
          tags: draft.tags.map((tag) => ({ tag })),
        },
      ],
    }).map((c) => c.tag.toLowerCase()),
  );
  const stray = tags.filter((tag) => !allowed.has(tag.trim().toLowerCase()));
  if (stray.length > 0) return `Not in this job's tag list: ${stray.join(', ')}`;
  return undefined;
}

type ApprovalInput = {
  title: string;
  description: string;
  tags: string[];
  pickVersion: number;
  /** The channel the page showed beside Approve. */
  channelId: string;
};

/** The approved fields, or a 422 naming each field that breaks the job's rules. */
function finalFields(input: ApprovalInput, job: JobDoc, draft: Pick): PickFields {
  const candidates = job.hashtagCandidates ?? [];
  const errors = validateFields(input, candidates);
  const tags = errors.tags ?? tagError(input.tags, job, draft);
  if (tags) errors.tags = tags;
  if (Object.keys(errors).length > 0)
    throw new ActionError(422, 'Fix the highlighted fields.', errors);
  const byLower = new Map(candidates.map((c) => [c.toLowerCase(), c]));
  return {
    title: input.title.trim(),
    description: input.description.trim(),
    hashtags: parseHashtags(input.description).map((t) => byLower.get(t) ?? t),
    tags: input.tags,
  };
}

/**
 * Approves the edited fields of the recommendation on screen and pins the upload to the owner's
 * connected channel, which must still be the one the page showed. One transaction re-checks REVIEW,
 * the pick version and the connection, validates against the job and the owner's current artist
 * link, moves the job, and records the feedback, so a double submit or a stale tab can't approve
 * twice, approve an older pick, or upload to a channel nobody saw.
 */
export async function approve(job: JobDoc, input: ApprovalInput): Promise<void> {
  requireState(job, ['REVIEW']);
  if (!Number.isInteger(input.pickVersion)) {
    throw new ActionError(400, 'Name the recommendation version being approved.');
  }
  if (!input.channelId) throw new ActionError(400, 'Name the channel being approved to.');

  const outcome = await query(async (tx) => {
    const current = await lockJob(tx, job.id);
    if (current?.state !== 'REVIEW') return 'handled';
    if (current.pickVersion !== input.pickVersion) return 'stale';
    const proposed = await pickIn(tx, job.id, input.pickVersion);
    if (!proposed) return 'stale';
    const connection = await getConnection(current.ownerUid, tx);
    if (connection?.status !== 'connected') {
      throw new ActionError(409, 'Reconnect YouTube to approve.');
    }
    if (connection.channelId !== input.channelId) {
      throw new ActionError(409, 'Your YouTube channel changed. Reload to approve.');
    }
    const final = finalFields(input, current, proposed);

    const feedback = approvalFeedback(proposed, final, {
      jobId: job.id,
      songTitle: current.songTitle,
      pickVersion: proposed.version,
      at: Date.now(),
    });
    // A Short's draft is the video's own metadata: its edits are new signal, its acceptance is not.
    await writeFeedback(
      tx,
      current.short ? feedback.filter((f) => f.kind === 'EDITED') : feedback,
      current,
    );
    // The destination is pinned only before any upload began; nothing rewrites it after.
    const pinned = await tx
      .update(jobs)
      .set({
        ...jobSet({ state: 'PUBLISHING', finalFields: final, consecutiveFailures: 0, error: null }),
        destinationChannelId: connection.channelId,
        destinationChannelTitle: connection.channelTitle,
      })
      .where(and(eq(jobs.id, job.id), isNull(jobs.uploadStartedAt)))
      .returning({ id: jobs.id });
    if (pinned.length === 0) throw new ActionError(409, 'This job already started uploading.');
    return 'approved';
  });
  if (outcome === 'handled') throw new ActionError(409, 'This recommendation was already handled.');
  if (outcome === 'stale') {
    throw new ActionError(409, 'A newer recommendation replaced this one. Review it first.');
  }
}

/**
 * Skips the current recommendation and queues a new smart pick, recording the skip atomically. On a
 * Short it re-picks the hook instead, away from the current one; the metadata stays.
 */
export async function rerun(job: JobDoc): Promise<void> {
  requireState(job, ['REVIEW']);
  if (job.short) {
    const { short } = job;
    const skipped = short.hook
      ? [...short.skipped, { window: short.hook.window, lengthSec: short.hook.lengthSec }]
      : short.skipped;
    const moved = await transitionJob(job.id, ['REVIEW'], {
      state: 'HOOK',
      short: { ...short, hook: null, skipped },
      consecutiveFailures: 0,
      error: null,
    });
    if (!moved) throw new ActionError(409, 'This Short was already handled.');
    return;
  }
  const current = await latestPick(job.id);
  const skipped = await skipAndRepick(job.id, current?.version ?? null, async (tx) => {
    if (!current) return;
    await writeFeedback(
      tx,
      [
        {
          kind: 'SKIPPED',
          jobId: job.id,
          songTitle: job.songTitle,
          pickVersion: current.version,
          before: current.title,
          at: Date.now(),
        },
      ],
      job,
    );
  });
  if (!skipped) throw new ActionError(409, 'This recommendation was already handled.');
}

const DISCARDABLE: JobState[] = [
  'AWAITING_UPLOAD',
  'PREP',
  'ANALYZE',
  'PICK',
  'HOOK',
  'RENDER',
  'REVIEW',
  'FAILED',
  'PUBLISHING',
  'CLAIMED_COMPLETE',
];

const UNCHECKED = "Couldn't check the upload. Try again.";
const MOVED_ON = 'The job moved on before it could be discarded.';
/** Reads of the job before discard gives up on a job that keeps changing under it. */
const DISCARD_TRIES = 3;

/** Whether the job's current upload object landed; a failed read leaves the job as it was. */
async function landedUpload(job: JobDoc): Promise<boolean> {
  try {
    return (await objectInfo(job.object)) !== null;
  } catch (error) {
    captureException(error, { tags: { action: 'discard', 'job.id': job.id } });
    throw new ActionError(503, UNCHECKED);
  }
}

/**
 * Marks the job discarded, only while it is as `job` read it: for a job awaiting its upload, the
 * same object and generation. A finished upload's state is cleared in the same statement, since
 * that video is kept.
 */
async function markDiscarded(job: JobDoc, landed: boolean): Promise<boolean> {
  const awaiting = job.state === 'AWAITING_UPLOAD';
  const written = await query((tx) =>
    tx
      .update(jobs)
      .set(jobSet(landed ? { state: 'DISCARDED', videoUpload: null } : { state: 'DISCARDED' }))
      .where(
        awaiting
          ? and(
              eq(jobs.id, job.id),
              eq(jobs.state, 'AWAITING_UPLOAD'),
              objectIs(job.object),
              sql`${generationSql} = ${uploadGeneration(job)}`,
            )
          : and(eq(jobs.id, job.id), inArray(jobs.state, DISCARDABLE)),
      )
      .returning({ id: jobs.id }),
  );
  return written.length > 0;
}

/**
 * Finishes a discarded job's unfinished upload: cancels its session, so it can't write, then deletes
 * every object under the job's prefix. `videoUpload` is cleared only once both are confirmed; until
 * then the job's next touch calls this again. Never throws.
 */
export async function finishDiscardCleanup(job: JobDoc): Promise<void> {
  const upload = job.videoUpload;
  if (job.state !== 'DISCARDED' || !upload) return;
  try {
    const cancelled = await cancelUploadSession(
      await decrypt(upload.sessionCipher, { timeout: UPLOAD_KMS_MS }),
    );
    const swept = await sweepUploads(job.id, null);
    if (!cancelled || !swept) return;
    await query((tx) =>
      tx
        .update(jobs)
        .set(jobSet({ videoUpload: null }))
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.state, 'DISCARDED'),
            sql`${generationSql} = ${upload.generation}`,
          ),
        ),
    );
  } catch (error) {
    captureException(error, { tags: { action: 'discard-cleanup', 'job.id': job.id } });
  }
}

/**
 * Ends the job, including one paused mid-publish or mid-upload. Nothing is learned from a discard.
 * It deletes no video that reached storage for the job's current upload, and none YouTube returned:
 * that ID stays recorded, even from a step still running. An unfinished browser upload is stopped
 * and its objects deleted. The object read decides which; a pick or completion that lands between
 * that read and the update makes it read again.
 */
export async function discard(job: JobDoc): Promise<void> {
  requireState(job, DISCARDABLE);
  await discardFrom(job, DISCARD_TRIES);
}

/** One read-then-update pass; a missed update reads the job again, `tries` times in all. */
async function discardFrom(current: JobDoc, tries: number): Promise<void> {
  if (tries === 0) throw new ActionError(503, UNCHECKED);
  const landed = current.state === 'AWAITING_UPLOAD' && (await landedUpload(current));
  if (await markDiscarded(current, landed)) {
    if (current.state !== 'AWAITING_UPLOAD') return;
    if (landed) await sweepUploads(current.id, current.object);
    else await finishDiscardCleanup({ ...current, state: 'DISCARDED' });
    return;
  }
  const fresh = await getJob(current.id);
  if (!fresh || !DISCARDABLE.includes(fresh.state)) throw new ActionError(409, MOVED_ON);
  await discardFrom(fresh, tries - 1);
}

const NOT_PAUSED = "This job isn't waiting on a pasted video.";

type Paused = JobDoc & { destination: NonNullable<JobDoc['destination']> };
const paused = (job: JobDoc): job is Paused => outcomeUnknown(job) && job.destination !== null;

const RECONNECT_TO_CONFIRM = 'Reconnect YouTube to confirm.';

/** The pasted video as the pinned grant sees it; YouTube's refusals become the action's errors. */
async function pastedVideo(job: Paused, videoId: string) {
  let access: Access | null;
  try {
    access = await accessTokenFor(job.ownerUid, job.destination.channelId, stepDeadline());
  } catch (error) {
    captureException(error, {
      tags: { action: 'confirm-upload', 'job.id': job.id, phase: 'grant' },
    });
    throw new ActionError(
      502,
      "Couldn't use your YouTube connection. Try again, or reconnect if it keeps failing.",
    );
  }
  if (!access) throw new ActionError(409, RECONNECT_TO_CONFIRM);
  try {
    return await videoChannel(access.token, videoId);
  } catch (error) {
    const failure = uploadFailure(error);
    if (failure === 'access-lost') {
      await access.refused(job.id);
      throw new ActionError(409, RECONNECT_TO_CONFIRM);
    }
    if (failure === 'quota-spent') {
      throw new ActionError(429, 'Daily YouTube limit reached. Try tomorrow.');
    }
    captureException(error, {
      tags: { action: 'confirm-upload', 'job.id': job.id, phase: 'read' },
    });
    // A read has no upload session, so its 404 or 410 is a denial too.
    throw new ActionError(
      502,
      failure === 'denied' || failure === 'session-lost'
        ? "YouTube wouldn't read that video. Try again, or reconnect if it keeps failing."
        : "YouTube didn't answer. Try again.",
    );
  }
}

// YouTube stamps whole seconds, so a video from this upload can read as up to a second early.
const startSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

/**
 * Records the video the owner found for a job paused with its upload outcome unknown. The video is
 * read through the pinned channel's grant, must be on that channel, and must not predate the
 * upload; the job and destination are re-checked in the transaction that saves the ID. Only the
 * normal read-back then sets VERIFIED.
 */
export async function confirmUpload(job: JobDoc, url: string): Promise<void> {
  if (!paused(job)) throw new ActionError(409, NOT_PAUSED);
  const videoId = videoIdFromUrl(url);
  if (!videoId) throw new ActionError(400, 'Paste a YouTube video URL.');
  const { channelId, channelTitle } = job.destination;
  const video = await pastedVideo(job, videoId);
  if (!video) throw new ActionError(422, "Couldn't find that video.");
  if (video.channelId !== channelId) {
    throw new ActionError(422, `That video isn't on ${channelTitle ?? 'this channel'}.`);
  }
  if (job.uploadStartedAt !== null && video.publishedAt < startSecond(job.uploadStartedAt)) {
    throw new ActionError(422, 'That video was published before this upload started.');
  }
  const saved = await query(async (tx) => {
    const current = await lockJob(tx, job.id);
    if (!current || !outcomeUnknown(current) || current.destination?.channelId !== channelId) {
      return false;
    }
    await tx
      .update(jobs)
      .set(jobSet({ state: 'CLAIMED_COMPLETE', videoId, verifyAttempts: 0, error: null }))
      .where(eq(jobs.id, job.id));
    return true;
  });
  if (!saved) throw new ActionError(409, NOT_PAUSED);
}

/**
 * Resumes a failed job at the step that failed, keeping finished chunks. A failed upload keeps its
 * session: the next step asks YouTube for its offset and resumes, completes, or handles a lost one.
 */
export async function retry(job: JobDoc): Promise<void> {
  requireState(job, ['FAILED']);
  const resumed = await transitionJob(job.id, ['FAILED'], {
    state: job.failedState ?? 'PREP',
    failedState: null,
    consecutiveFailures: 0,
    verifyAttempts: 0,
    error: null,
  });
  if (!resumed) throw new ActionError(409, 'The job is no longer failed.');
}

/**
 * Starts a Short from an approved video whose upload is still stored, or returns the live one it
 * already has. Its metadata starts from what the owner approved.
 */
export async function makeShort(job: JobDoc, artistName: string): Promise<string> {
  if (job.short) throw new ActionError(409, "A Short can't be cut from a Short.");
  requireState(job, [...SHORT_SOURCE_STATES]);
  if (!(job.probe && job.probe.durationSec > 0)) {
    throw new ActionError(409, "This video's length is unknown.");
  }
  if (!canCutShort(job.probe.durationSec)) {
    throw new ActionError(409, `A Short needs a video of at least ${SHORT_MIN_SEC} seconds.`);
  }
  if (staleAnalysis(job, job.probe.durationSec)) throw new ActionError(409, STALE_ANALYSIS);
  // The Short renders from this video's upload, which the bucket's 7-day lifecycle deletes.
  if (!(await objectInfo(job.object))) {
    throw new ActionError(409, 'This video is gone from storage. Upload it again to make a Short.');
  }
  const started = await createShort(job, SHORT_SOURCE_STATES, artistName);
  if (!started) throw new ActionError(409, 'The video moved on before the Short could start.');
  if ('noPick' in started) {
    throw new ActionError(409, 'This video has no recommendation to start from.');
  }
  return started.id;
}

export const REFRAMES: readonly Reframe[] = ['blur', 'crop'];

/**
 * Re-renders the Short with the owner's start, length, and framing; no model call. Moving the cut
 * clears the model's reason, since it no longer describes what's on screen.
 */
export async function recut(
  job: JobDoc,
  input: { startSec: number; lengthSec: number; reframe: string },
): Promise<void> {
  const { short } = job;
  if (!short?.hook) throw new ActionError(409, 'Only a cut Short can be re-cut.');
  requireState(job, ['REVIEW']);
  const { hook } = short;
  if (!REFRAMES.includes(input.reframe as Reframe)) {
    throw new ActionError(400, 'Pick blur fill or center crop.');
  }
  const startSec = tenth(input.startSec);
  const lengthSec = tenth(input.lengthSec);
  const errors = cutErrors({ startSec, lengthSec }, short.sourceDurationSec);
  const problem = errors.lengthSec ?? errors.startSec;
  if (problem) throw new ActionError(400, problem);
  const moved = startSec !== hook.startSec || lengthSec !== hook.lengthSec;
  const recutTo = await transitionJob(job.id, ['REVIEW'], {
    state: 'RENDER',
    short: {
      ...short,
      reframe: input.reframe as Reframe,
      hook: { ...hook, startSec, lengthSec, reason: moved ? '' : hook.reason },
    },
    consecutiveFailures: 0,
    error: null,
  });
  if (!recutTo) throw new ActionError(409, 'This Short was already handled.');
}
