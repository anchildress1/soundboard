import { captureException } from '@sentry/sveltekit';
import { canCutShort, cutErrors, SHORT_MIN_SEC, tenth } from '$lib/short';
import { containsWords, parseHashtags, validateFields } from '$lib/metadata';
import { and, eq, isNull } from 'drizzle-orm';
import { SHORT_SOURCE_STATES, type JobState, type PickFields, type Reframe } from '$lib/types';
import { query } from '$lib/server/core/db';
import { jobs } from '$lib/server/core/schema';
import {
  createShort,
  latestPick,
  lockJob,
  outcomeUnknown,
  pickIn,
  skipAndRepick,
  transitionJob,
  type JobDoc,
} from './jobs';
import { jobSet } from './rows';
import { approvalFeedback, artistJob, writeFeedback } from '$lib/server/artist/memory';
import { tagPool } from '$lib/server/ai/smart-pick';
import {
  accessTokenFor,
  getConnection,
  uploadFailure,
  videoChannel,
  videoIdFromUrl,
  type Access,
} from '$lib/server/platforms/youtube';
import { ActionError } from '$lib/server/core/errors';
import { objectInfo } from '$lib/server/media/gcs';

function requireState(job: JobDoc, states: JobState[]): void {
  if (!states.includes(job.state))
    throw new ActionError(409, `Not allowed while the job is ${job.state}.`);
}

/**
 * Edited tags follow the pick's rules: the job's tag candidates, plus the artist name on an artist
 * job, never the title.
 */
function tagError(
  tags: string[],
  job: JobDoc,
  artist: boolean,
  draft: PickFields,
): string | undefined {
  const titled = tags.filter((tag) => containsWords(tag, job.songTitle));
  if (titled.length > 0) return `Tags can't contain the song title: ${titled.join(', ')}`;
  const allowed = new Set(
    tagPool({
      artist,
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
function finalFields(
  input: ApprovalInput,
  job: JobDoc,
  artist: boolean,
  draft: PickFields,
): PickFields {
  const candidates = job.hashtagCandidates ?? [];
  const errors = validateFields(input, candidates);
  const tags = errors.tags ?? tagError(input.tags, job, artist, draft);
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
    const final = finalFields(input, current, await artistJob(current, tx), proposed);

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

/**
 * Ends the job, including one paused mid-publish. Nothing is learned from a discard, and it deletes
 * no video: a video ID YouTube already returned stays recorded, even from a step still running.
 */
export async function discard(job: JobDoc): Promise<void> {
  requireState(job, DISCARDABLE);
  if (!(await transitionJob(job.id, DISCARDABLE, { state: 'DISCARDED' }))) {
    throw new ActionError(409, 'The job moved on before it could be discarded.');
  }
}

const NOT_PAUSED = "This job isn't waiting on a pasted video.";

type Paused = JobDoc & { destination: NonNullable<JobDoc['destination']> };
const paused = (job: JobDoc): job is Paused => outcomeUnknown(job) && job.destination !== null;

const RECONNECT_TO_CONFIRM = 'Reconnect YouTube to confirm.';

/** The pasted video as the pinned grant sees it; YouTube's refusals become the action's errors. */
async function pastedVideo(job: Paused, videoId: string) {
  let access: Access | null;
  try {
    access = await accessTokenFor(job.ownerUid, job.destination.channelId);
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
 * Starts a Short from a video whose analysis is done and whose upload is still stored, or returns
 * the live one it already has. Its metadata starts from what the owner approved, else the
 * recommendation on screen.
 */
export async function makeShort(job: JobDoc): Promise<string> {
  if (job.short) throw new ActionError(409, "A Short can't be cut from a Short.");
  requireState(job, [...SHORT_SOURCE_STATES]);
  if (!(job.probe && job.probe.durationSec > 0)) {
    throw new ActionError(409, "This video's length is unknown.");
  }
  if (!canCutShort(job.probe.durationSec)) {
    throw new ActionError(409, `A Short needs a video of at least ${SHORT_MIN_SEC} seconds.`);
  }
  // The Short renders from this video's upload, which the bucket's 7-day lifecycle deletes.
  if (!(await objectInfo(job.object))) {
    throw new ActionError(409, 'This video is gone from storage. Upload it again to make a Short.');
  }
  const started = await createShort(job, SHORT_SOURCE_STATES);
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
