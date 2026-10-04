import { canCutShort, cutErrors, SHORT_MIN_SEC, tenth } from '$lib/short';
import { containsWords, parseHashtags, validateFields, type FieldErrors } from '$lib/metadata';
import {
  SHORT_SOURCE_STATES,
  type JobState,
  type Pick,
  type PickFields,
  type Reframe,
} from '$lib/types';
import { db } from './clients';
import {
  createShort,
  jobRef,
  latestPick,
  pickKey,
  skipAndRepick,
  transitionJob,
  type JobDoc,
} from './jobs';
import { approvalFeedback, ARTIST_NAME, writeFeedback } from './memory';
import { takeUploadSlot, takeVisitorRun } from './quota';
import { getRefreshToken } from './tokens';

export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields?: FieldErrors,
  ) {
    super(message);
  }
}

function requireState(job: JobDoc, states: JobState[]): void {
  if (!states.includes(job.state))
    throw new ActionError(409, `Not allowed while the job is ${job.state}.`);
}

const allowlistedFor = (job: JobDoc) => job.owner === 'nathan';

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
 * Approves the edited fields of the recommendation on screen. One transaction re-checks REVIEW and
 * the pick version, takes the day's upload slot, moves the job, and records the feedback, so a
 * double submit or a stale tab can't approve twice or approve an older pick. Without a channel,
 * token, or slot the run ends at the would-be payload.
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
  const connected = job.channel ? Boolean(await getRefreshToken(job.channel)) : false;
  const ref = jobRef(job.id);

  const outcome = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data() as JobDoc) : null;
    if (current?.state !== 'REVIEW') return 'handled';
    if (current.pickVersion !== input.pickVersion) return 'stale';
    const pickSnap = await tx.get(ref.collection('pick').doc(pickKey(input.pickVersion)));
    if (!pickSnap.exists) return 'stale';
    const proposed = pickSnap.data() as Pick;

    const payload = (error: string | null): Partial<JobDoc> => ({
      state: 'PAYLOAD',
      payload: final,
      finalFields: final,
      error,
    });
    let patch: Partial<JobDoc>;
    if (!job.channel) patch = payload(null);
    else if (!connected) patch = payload('The upload channel is not connected.');
    else if (await takeUploadSlot(tx, job.owner !== 'nathan')) {
      // payload is the approved fields wherever the job ends, so the page shows what was sent.
      patch = {
        state: 'PUBLISHING',
        payload: final,
        finalFields: final,
        consecutiveFailures: 0,
        error: null,
      };
    } else patch = payload("Today's upload quota is used up.");

    const feedback = approvalFeedback(proposed, final, {
      jobId: job.id,
      songTitle: job.songTitle,
      pickVersion: proposed.version,
      at: Date.now(),
    });
    // A Short's draft is the video's own metadata: its edits are new signal, its acceptance is not.
    writeFeedback(tx, job.short ? feedback.filter((f) => f.kind === 'EDITED') : feedback, {
      allowlisted: allowlistedFor(job),
      jobId: job.id,
    });
    tx.update(ref, { ...patch, updatedAt: Date.now() });
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
  const skipped = await skipAndRepick(job.id, current?.version ?? null, (tx) => {
    if (!current) return;
    writeFeedback(
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
      { allowlisted: allowlistedFor(job), jobId: job.id },
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
  'PAYLOAD',
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
 * metadata starts from what the artist approved, else the recommendation on screen. A visitor's new
 * Short counts as one of their runs.
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
  // A Short costs a model call and a render, so a signed-out visitor pays for it with a run.
  const ipHash = job.owner === 'visitor' ? job.ipHash : null;
  const started = await createShort(
    job,
    SHORT_SOURCE_STATES,
    ipHash ? (tx) => takeVisitorRun(tx, ipHash) : null,
  );
  if (!started) throw new ActionError(409, 'The video moved on before the Short could start.');
  if ('noPick' in started) {
    throw new ActionError(409, 'This video has no recommendation to start from.');
  }
  if ('blocked' in started) throw new ActionError(429, started.blocked);
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
