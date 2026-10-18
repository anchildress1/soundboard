import { canCutShort, cutErrors, SHORT_MIN_SEC, tenth } from '$lib/short';
import { containsWords, parseHashtags, validateFields } from '$lib/metadata';
import { eq } from 'drizzle-orm';
import { SHORT_SOURCE_STATES, type JobState, type PickFields, type Reframe } from '$lib/types';
import { db } from '$lib/server/core/db';
import { jobs } from '$lib/server/core/schema';
import {
  createShort,
  latestPick,
  lockJob,
  pickIn,
  skipAndRepick,
  transitionJob,
  type JobDoc,
} from './jobs';
import { jobSet } from './rows';
import { approvalFeedback, ARTIST_ID, ARTIST_NAME, writeFeedback } from '$lib/server/artist/memory';
import { getConnection } from '$lib/server/platforms/youtube';
import { ActionError } from '$lib/server/core/errors';

function requireState(job: JobDoc, states: JobState[]): void {
  if (!states.includes(job.state))
    throw new ActionError(409, `Not allowed while the job is ${job.state}.`);
}

/** Feedback on Nathan's jobs teaches his memory; anyone else's stays on the job. */
const toArtist = (job: JobDoc) => job.artistId === ARTIST_ID;

/** Edited tags follow the pick's rules: the job's tag candidates or the artist name, never the title. */
function tagError(tags: string[], job: JobDoc): string | undefined {
  const titled = tags.filter((tag) => containsWords(tag, job.songTitle));
  if (titled.length > 0) return `Tags can't contain the song title: ${titled.join(', ')}`;
  const allowed = new Set(
    [...(job.audience?.tags ?? []).map((c) => c.tag), ARTIST_NAME].map((t) => t.toLowerCase()),
  );
  const stray = tags.filter((tag) => !allowed.has(tag.trim().toLowerCase()));
  if (stray.length > 0) return `Not in this job's tag list: ${stray.join(', ')}`;
  return undefined;
}

/**
 * Approves the edited fields of the recommendation on screen and pins the upload to the owner's
 * connected channel. One transaction re-checks REVIEW and the pick version, moves the job, and
 * records the feedback, so a double submit or a stale tab can't approve twice or approve an older
 * pick.
 */
export async function approve(
  job: JobDoc,
  input: { title: string; description: string; tags: string[]; pickVersion: number },
): Promise<void> {
  requireState(job, ['REVIEW']);
  const candidates = job.hashtagCandidates ?? [];
  const errors = validateFields(input, candidates);
  const tags = errors.tags ?? tagError(input.tags, job);
  if (tags) errors.tags = tags;
  if (Object.keys(errors).length > 0)
    throw new ActionError(422, 'Fix the highlighted fields.', errors);
  if (!Number.isInteger(input.pickVersion)) {
    throw new ActionError(400, 'Name the recommendation version being approved.');
  }

  const byLower = new Map(candidates.map((c) => [c.toLowerCase(), c]));
  const final: PickFields = {
    title: input.title.trim(),
    description: input.description.trim(),
    hashtags: parseHashtags(input.description).map((t) => byLower.get(t) ?? t),
    tags: input.tags,
  };
  const connection = await getConnection(job.ownerUid);
  if (connection?.status !== 'connected' || !connection.channelId) {
    throw new ActionError(409, 'Reconnect YouTube to approve.');
  }
  const destination = { channelId: connection.channelId, channelTitle: connection.channelTitle };

  const outcome = await db().transaction(async (tx) => {
    const current = await lockJob(tx, job.id);
    if (current?.state !== 'REVIEW') return 'handled';
    if (current.pickVersion !== input.pickVersion) return 'stale';
    const proposed = await pickIn(tx, job.id, input.pickVersion);
    if (!proposed) return 'stale';

    const feedback = approvalFeedback(proposed, final, {
      jobId: job.id,
      songTitle: job.songTitle,
      pickVersion: proposed.version,
      at: Date.now(),
    });
    // A Short's draft is the video's own metadata: its edits are new signal, its acceptance is not.
    await writeFeedback(tx, job.short ? feedback.filter((f) => f.kind === 'EDITED') : feedback, {
      toArtist: toArtist(job),
      jobId: job.id,
    });
    await tx
      .update(jobs)
      .set(
        jobSet({
          state: 'PUBLISHING',
          finalFields: final,
          destination,
          consecutiveFailures: 0,
          error: null,
        }),
      )
      .where(eq(jobs.id, job.id));
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
      { toArtist: toArtist(job), jobId: job.id },
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
];

/** Ends the job. Nothing is learned from a discard; a step still running drops its result. */
export async function discard(job: JobDoc): Promise<void> {
  requireState(job, DISCARDABLE);
  if (!(await transitionJob(job.id, DISCARDABLE, { state: 'DISCARDED' }))) {
    throw new ActionError(409, 'The job moved on before it could be discarded.');
  }
}

/**
 * Resumes a failed job at the step that failed, keeping finished chunks. A failed upload starts a
 * fresh resumable session, since the old one may have expired.
 */
export async function retry(job: JobDoc): Promise<void> {
  requireState(job, ['FAILED']);
  const resumed = await transitionJob(job.id, ['FAILED'], {
    state: job.failedState ?? 'PREP',
    failedState: null,
    consecutiveFailures: 0,
    verifyAttempts: 0,
    error: null,
    ...(job.failedState === 'PUBLISHING' ? { upload: null, uploadProgress: null } : {}),
  });
  if (!resumed) throw new ActionError(409, 'The job is no longer failed.');
}

/**
 * Starts a Short from a video whose analysis is done, or returns the live one it already has. Its
 * metadata starts from what the artist approved, else the recommendation on screen.
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
  const started = await createShort(job, SHORT_SOURCE_STATES);
  if (!started) throw new ActionError(409, 'The video moved on before the Short could start.');
  if ('noPick' in started) {
    throw new ActionError(409, 'This video has no recommendation to start from.');
  }
  return started.id;
}

export const REFRAMES: readonly Reframe[] = ['blur', 'crop'];

/**
 * Re-renders the Short with the artist's start, length, and framing; no model call. Moving the cut
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
