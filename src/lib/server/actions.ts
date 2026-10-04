import { parseHashtags, validateFields, type FieldErrors } from '$lib/metadata';
import type { JobState, PickFields } from '$lib/types';
import { db } from './clients';
import { jobRef, latestPick, skipAndRepick, transitionJob, type JobDoc } from './jobs';
import { approvalFeedback, recordFeedback } from './memory';
import { takeUploadSlot } from './quota';
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

/**
 * Approves the edited fields. One transaction re-checks REVIEW, takes the day's upload slot, and
 * moves the job, so a double submit can't approve twice. Without a channel, token, or slot the run
 * ends at the would-be payload.
 */
export async function approve(
  job: JobDoc,
  input: { title: string; description: string; tags: string[] },
): Promise<void> {
  requireState(job, ['REVIEW']);
  const proposed = await latestPick(job.id);
  if (!proposed) throw new ActionError(409, 'There is no recommendation to approve.');
  const candidates = job.hashtagCandidates ?? [];
  const errors = validateFields(input, candidates);
  if (Object.keys(errors).length > 0)
    throw new ActionError(422, 'Fix the highlighted fields.', errors);

  const byLower = new Map(candidates.map((c) => [c.toLowerCase(), c]));
  const final: PickFields = {
    title: input.title.trim(),
    description: input.description.trim(),
    hashtags: parseHashtags(input.description).map((t) => byLower.get(t) ?? t),
    tags: input.tags,
  };
  const connected = job.channel ? Boolean(await getRefreshToken(job.channel)) : false;

  const won = await db().runTransaction(async (tx) => {
    const snap = await tx.get(jobRef(job.id));
    if (!snap.exists || (snap.data() as JobDoc).state !== 'REVIEW') return false;
    const payload = (error: string | null): Partial<JobDoc> => ({
      state: 'PAYLOAD',
      payload: final,
      finalFields: final,
      error,
    });
    let patch: Partial<JobDoc>;
    if (!job.channel) patch = payload(null);
    else if (!connected) patch = payload('The upload channel is not connected.');
    else if (await takeUploadSlot(tx, job.owner === 'visitor')) {
      patch = { state: 'PUBLISHING', finalFields: final, consecutiveFailures: 0, error: null };
    } else patch = payload("Today's upload quota is used up.");
    tx.update(jobRef(job.id), { ...patch, updatedAt: Date.now() });
    return true;
  });
  if (!won) throw new ActionError(409, 'This recommendation was already handled.');

  await recordFeedback(
    approvalFeedback(proposed, final, {
      jobId: job.id,
      songTitle: job.songTitle,
      pickVersion: proposed.version,
      at: Date.now(),
    }),
    { allowlisted: allowlistedFor(job), jobId: job.id },
  );
}

/** Skips the current recommendation and queues a new smart pick for this job. */
export async function rerun(job: JobDoc): Promise<void> {
  requireState(job, ['REVIEW']);
  const current = await latestPick(job.id);
  if (!(await skipAndRepick(job.id, current?.version ?? null))) {
    throw new ActionError(409, 'This recommendation was already handled.');
  }
  if (current) {
    await recordFeedback(
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
  }
}

const DISCARDABLE: JobState[] = [
  'AWAITING_UPLOAD',
  'PREP',
  'ANALYZE',
  'PICK',
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
