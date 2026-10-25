import { describe, expect, it } from 'vitest';
import {
  groupReleases,
  nextReviewStep,
  previousReviewStep,
  STATE_LABELS,
  stepIndex,
  stepLabel,
  STEPS,
  workCopy,
  type ReleaseItem,
} from '#lib/release.js';
import { JOB_STATES, type JobState, type JobView, type Wait } from '#lib/types.js';

describe('stepIndex', () => {
  it.each([
    ['AWAITING_UPLOAD', 0],
    ['PREP', 1],
    ['ANALYZE', 1],
    ['PICK', 1],
    ['PUBLISHING', 7],
    ['CLAIMED_COMPLETE', 7],
    ['VERIFIED', STEPS.length],
    ['DISCARDED', -1],
  ] as const)('puts %s on step %i', (state, index) => {
    expect(stepIndex(state, 'title', null)).toBe(index);
  });

  it.each([
    ['title', 2],
    ['description', 3],
    ['tags', 4],
    ['check', 5],
    ['approve', 6],
  ] as const)('walks review screen %s as step %i', (review, index) => {
    expect(stepIndex('REVIEW', review, null)).toBe(index);
    expect(STEPS[index]).toBe(
      {
        title: 'Title',
        description: 'Description',
        tags: 'Tags',
        check: 'Check',
        approve: 'Approve',
      }[review],
    );
  });

  it('keeps a failed release on the step that failed', () => {
    expect(stepIndex('FAILED', 'title', 'ANALYZE')).toBe(1);
    expect(stepIndex('FAILED', 'approve', 'PUBLISHING')).toBe(7);
  });

  it('has no step for a failure with no recorded state', () => {
    expect(stepIndex('FAILED', 'title', null)).toBe(-1);
  });
});

describe('stepLabel', () => {
  it('counts from one', () => {
    expect(stepLabel(0)).toBe('Step 1 of 8 · Upload');
    expect(stepLabel(7)).toBe('Step 8 of 8 · Upload & verify');
  });

  it('reads Done past the end and Stopped before the start', () => {
    expect(stepLabel(STEPS.length)).toBe('Done');
    expect(stepLabel(-1)).toBe('Stopped');
  });
});

describe('review navigation', () => {
  it('visits the check only when ffmpeg flagged something', () => {
    expect(nextReviewStep('tags', true)).toBe('check');
    expect(nextReviewStep('tags', false)).toBe('approve');
    expect(previousReviewStep('approve', true)).toBe('check');
    expect(previousReviewStep('approve', false)).toBe('tags');
  });

  it('stops at both ends', () => {
    expect(nextReviewStep('approve', true)).toBe('approve');
    expect(previousReviewStep('title', true)).toBe('title');
  });

  it('walks forward and back through the fields', () => {
    expect(nextReviewStep('title', false)).toBe('description');
    expect(nextReviewStep('description', false)).toBe('tags');
    expect(previousReviewStep('tags', false)).toBe('description');
    expect(previousReviewStep('check', true)).toBe('tags');
  });
});

describe('groupReleases', () => {
  const item = (id: string, state: JobState): ReleaseItem => ({
    id,
    songTitle: id,
    state,
    createdAt: 0,
  });

  it('lifts the newest review up next and keeps the rest in order', () => {
    const jobs = [
      item('a', 'ANALYZE'),
      item('b', 'REVIEW'),
      item('c', 'VERIFIED'),
      item('d', 'REVIEW'),
      item('e', 'PUBLISHING'),
    ];
    const { next, running, earlier } = groupReleases(jobs);
    expect(next?.id).toBe('b');
    expect(running.map((j) => j.id)).toEqual(['a', 'e']);
    expect(earlier.map((j) => j.id)).toEqual(['c', 'd']);
  });

  it('has nothing up next without a review', () => {
    expect(groupReleases([item('a', 'FAILED')])).toEqual({
      next: null,
      running: [],
      earlier: [item('a', 'FAILED')],
    });
  });

  it('handles no releases', () => {
    expect(groupReleases([])).toEqual({ next: null, running: [], earlier: [] });
  });
});

describe('STATE_LABELS', () => {
  it('names every state', () => {
    for (const state of JOB_STATES) expect(STATE_LABELS[state].text).not.toBe('');
  });

  it('marks review as needing the user and failure as an error', () => {
    expect(STATE_LABELS.REVIEW.tone).toBe('attention');
    expect(STATE_LABELS.FAILED.tone).toBe('err');
    expect(STATE_LABELS.VERIFIED.tone).toBe('ok');
  });
});

describe('workCopy', () => {
  const view = (state: JobState, wait?: Wait): JobView =>
    ({ job: { state, chunkIndex: 5, chunkCount: 9 }, chunks: [], pick: null, wait }) as never;

  it('says it is listening and leaves the window count to the status row', () => {
    expect(workCopy(view('ANALYZE'))).toEqual({
      title: 'Listening to the video',
      body: 'Nothing for you to do yet. Leave if you like; Home brings you back.',
    });
  });

  it('warns not to leave while the browser is still uploading', () => {
    expect(workCopy(view('AWAITING_UPLOAD')).body).toBe(
      'Keep this tab open until the upload finishes. Other pages in the app are fine.',
    );
  });

  it.each([
    ['PREP', 'Measuring the audio'],
    ['PICK', 'Drafting the title, description, and tags'],
    ['PUBLISHING', 'Uploading to YouTube'],
    ['CLAIMED_COMPLETE', 'Checking YouTube has it'],
  ] as const)('titles %s', (state, title) => {
    expect(workCopy(view(state)).title).toBe(title);
  });

  it.each([
    ['researching similar artists', 'Researching similar artists'],
    ['model busy', 'Model busy'],
    ['model quota spent', 'Model quota spent'],
    ['step running in another tab', 'Running in another tab'],
    ['waiting on YouTube', 'Waiting on YouTube'],
    ['reconnect YouTube', 'Upload paused'],
    ['upload outcome unknown', 'Upload paused'],
    ['Daily upload limit reached. Try tomorrow.', 'Daily upload limit reached'],
  ] as const)('names the wait %s over the state', (wait, title) => {
    expect(workCopy(view('ANALYZE', wait)).title).toBe(title);
  });
});
