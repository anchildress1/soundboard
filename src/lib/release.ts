import { WAIT_TEXT } from './status';
import type { JobState, JobView } from './types';

/** The release as the user walks it: one screen, one decision, one primary button per step. */
export const STEPS = [
  'Upload',
  'Listening',
  'Title',
  'Description',
  'Tags',
  'Check',
  'Approve',
  'Upload & verify',
] as const;

/** The review's own screens, between the model's draft and the upload. */
export const REVIEW_STEPS = ['title', 'description', 'tags', 'check', 'approve'] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

const REVIEW_INDEX = STEPS.indexOf('Title');

const STATE_STEP: Record<JobState, number> = {
  AWAITING_UPLOAD: 0,
  PREP: 1,
  ANALYZE: 1,
  PICK: 1,
  HOOK: 1,
  RENDER: 1,
  REVIEW: REVIEW_INDEX,
  PUBLISHING: STEPS.length - 1,
  CLAIMED_COMPLETE: STEPS.length - 1,
  VERIFIED: STEPS.length,
  FAILED: -1,
  DISCARDED: -1,
};

/**
 * The step on screen, as an index into STEPS: `STEPS.length` once verified, -1 for a discarded
 * release. A failed release sits on the step that failed.
 */
export function stepIndex(
  state: JobState,
  review: ReviewStep,
  failedState: JobState | null,
): number {
  if (state === 'FAILED') return failedState ? stepIndex(failedState, review, null) : -1;
  if (state === 'REVIEW') return REVIEW_INDEX + REVIEW_STEPS.indexOf(review);
  return STATE_STEP[state];
}

/** "Step 3 of 8 · Title", or "Done" past the last step. */
export function stepLabel(index: number): string {
  if (index >= STEPS.length) return 'Done';
  if (index < 0) return 'Stopped';
  return `Step ${index + 1} of ${STEPS.length} · ${STEPS[index]}`;
}

/** The next review screen; the check is skipped when ffmpeg flagged nothing. */
export function nextReviewStep(step: ReviewStep, hasFlags: boolean): ReviewStep {
  const next = REVIEW_STEPS[Math.min(REVIEW_STEPS.indexOf(step) + 1, REVIEW_STEPS.length - 1)]!;
  return next === 'check' && !hasFlags ? 'approve' : next;
}

export function previousReviewStep(step: ReviewStep, hasFlags: boolean): ReviewStep {
  const previous = REVIEW_STEPS[Math.max(REVIEW_STEPS.indexOf(step) - 1, 0)]!;
  return previous === 'check' && !hasFlags ? 'tags' : previous;
}

export type ReleaseItem = { id: string; songTitle: string; state: JobState; createdAt: number };

const RUNNING: readonly JobState[] = [
  'AWAITING_UPLOAD',
  'PREP',
  'ANALYZE',
  'PICK',
  'HOOK',
  'RENDER',
  'PUBLISHING',
  'CLAIMED_COMPLETE',
];

/**
 * Home's three groups: the newest release waiting on the user, the ones still running, and the
 * rest. Input order (newest first) is kept within each group.
 */
export function groupReleases<T extends ReleaseItem>(jobs: readonly T[]) {
  const next = jobs.find((job) => job.state === 'REVIEW') ?? null;
  return {
    next,
    running: jobs.filter((job) => RUNNING.includes(job.state)),
    earlier: jobs.filter((job) => job !== next && !RUNNING.includes(job.state)),
  };
}

export type Tone = 'running' | 'attention' | 'ok' | 'warn' | 'err' | 'idle';

/** Plain state names for release lists, with the status tone each reads in. */
export const STATE_LABELS: Record<JobState, { text: string; tone: Tone }> = {
  AWAITING_UPLOAD: { text: 'Uploading', tone: 'running' },
  PREP: { text: 'Measuring audio', tone: 'running' },
  ANALYZE: { text: 'Listening', tone: 'running' },
  PICK: { text: 'Drafting', tone: 'running' },
  HOOK: { text: 'Picking the hook', tone: 'running' },
  RENDER: { text: 'Cutting the Short', tone: 'running' },
  REVIEW: { text: 'Needs your review', tone: 'attention' },
  PUBLISHING: { text: 'Uploading to YouTube', tone: 'running' },
  CLAIMED_COMPLETE: { text: 'Verifying upload', tone: 'running' },
  VERIFIED: { text: 'Verified · private', tone: 'ok' },
  FAILED: { text: 'Failed', tone: 'err' },
  DISCARDED: { text: 'Discarded', tone: 'idle' },
};

/** Headline and one plain line for a screen where the app is working, not the user. */
export function workCopy({ job, wait }: JobView): { title: string; body: string } {
  const leave = 'Nothing for you to do yet. Leave if you like; Home brings you back.';
  switch (wait) {
    case 'waking model':
      return {
        title: WAIT_TEXT[wait],
        body: 'It sleeps when nobody is using it and takes about a minute to start. ' + leave,
      };
    case 'waiting on another run':
      return {
        title: WAIT_TEXT[wait],
        body: 'One release runs at a time. Yours starts when the other one finishes.',
      };
    case 'step running in another tab':
      return {
        title: WAIT_TEXT[wait],
        body: 'This release is open somewhere else. This page picks up when that step finishes.',
      };
    case 'waiting on YouTube':
      return { title: WAIT_TEXT[wait], body: 'This page checks again on its own.' };
    case 'reconnect YouTube':
    case 'upload outcome unknown':
      return { title: 'Upload paused', body: 'It needs you before it can go on.' };
    case 'Daily upload limit reached. Try tomorrow.':
      return {
        title: WAIT_TEXT[wait],
        body: "YouTube's limit resets tomorrow. Everything you approved is kept.",
      };
  }
  switch (job.state) {
    case 'AWAITING_UPLOAD':
      return {
        title: 'Uploading your video',
        body: 'Keep this page open until the upload finishes. After that, leaving is safe.',
      };
    case 'PREP':
      return { title: 'Measuring the audio', body: leave };
    case 'ANALYZE':
      return { title: 'Listening to the video', body: leave };
    case 'PUBLISHING':
      return {
        title: 'Uploading to YouTube',
        body: 'Then it reads the video back from your channel. Safe to reload or leave: it resumes and never uploads twice.',
      };
    case 'CLAIMED_COMPLETE':
      return {
        title: 'Checking YouTube has it',
        body: "Reading the video back from your channel. It isn't done until that comes back.",
      };
    default:
      return { title: 'Drafting the title, description, and tags', body: leave };
  }
}
