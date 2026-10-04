import { containsWords, parseHashtags, validateFields, type FieldErrors } from '$lib/metadata';
import type { JobState, Pick, PickFields } from '$lib/types';
import { db } from './clients';
import { jobRef, latestPick, pickKey, skipAndRepick, transitionJob, type JobDoc } from './jobs';
import { approvalFeedback, ARTIST_NAME, writeFeedback } from './memory';
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

    writeFeedback(
      tx,
      approvalFeedback(proposed, final, {
        jobId: job.id,
        songTitle: job.songTitle,
        pickVersion: proposed.version,
        at: Date.now(),
      }),
      { allowlisted: allowlistedFor(job), jobId: job.id },
    );
    tx.update(ref, { ...patch, updatedAt: Date.now() });
    return 'approved';
  });
  if (outcome === 'handled') throw new ActionError(409, 'This recommendation was already handled.');
  if (outcome === 'stale') {
    throw new ActionError(409, 'A newer recommendation replaced this one. Review it first.');
  }
}

/** Skips the current recommendation and queues a new smart pick, recording the skip atomically. */
export async function rerun(job: JobDoc): Promise<void> {
  requireState(job, ['REVIEW']);
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
