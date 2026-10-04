import { parseHashtags, validateFields, type FieldErrors } from '$lib/metadata';
import type { JobState, PickFields } from '$lib/types';
import { latestPick, markPickSkipped, updateJob, type JobDoc } from './jobs';
import { approvalFeedback, recordFeedback } from './memory';
import { reserveUpload } from './quota';
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
 * Approves the edited fields. Uploads go to the job's channel when a slot and a token exist;
 * otherwise the run ends at the would-be payload.
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
  await recordFeedback(
    approvalFeedback(proposed, final, {
      jobId: job.id,
      songTitle: job.songTitle,
      pickVersion: proposed.version,
      at: Date.now(),
    }),
    { allowlisted: allowlistedFor(job), jobId: job.id },
  );

  if (!job.channel) {
    await updateJob(job.id, { state: 'PAYLOAD', payload: final, finalFields: final });
    return;
  }
  if (!(await getRefreshToken(job.channel))) {
    await updateJob(job.id, {
      state: 'PAYLOAD',
      payload: final,
      finalFields: final,
      error: 'The upload channel is not connected.',
    });
    return;
  }
  if (!(await reserveUpload(job.owner === 'visitor'))) {
    await updateJob(job.id, {
      state: 'PAYLOAD',
      payload: final,
      finalFields: final,
      error: "Today's upload quota is used up.",
    });
    return;
  }
  await updateJob(job.id, {
    state: 'PUBLISHING',
    finalFields: final,
    consecutiveFailures: 0,
    error: null,
  });
}

/** Skips the current recommendation and queues a new smart pick for this job. */
export async function rerun(job: JobDoc): Promise<void> {
  requireState(job, ['REVIEW']);
  const current = await latestPick(job.id);
  if (current) {
    await markPickSkipped(job.id, current.version);
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
  await updateJob(job.id, { state: 'PICK', consecutiveFailures: 0, error: null });
}

/** Ends the job. Nothing is learned from a discard. */
export async function discard(job: JobDoc): Promise<void> {
  requireState(job, ['AWAITING_UPLOAD', 'PREP', 'ANALYZE', 'PICK', 'REVIEW', 'FAILED', 'PAYLOAD']);
  await updateJob(job.id, { state: 'DISCARDED' });
}

/** Resumes a failed job at the step that failed, keeping finished chunks. */
export async function retry(job: JobDoc): Promise<void> {
  requireState(job, ['FAILED']);
  await updateJob(job.id, {
    state: job.failedState ?? 'PREP',
    failedState: null,
    consecutiveFailures: 0,
    verifyAttempts: 0,
    error: null,
  });
}
