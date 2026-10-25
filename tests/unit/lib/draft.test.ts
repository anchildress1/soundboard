import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, draftKey, loadDraft, saveDraft } from '#lib/draft.js';

const KEY = draftKey('job1', 2);
const DRAFT = {
  title: 'Static Bloom',
  description: 'Shot in a garage.',
  tags: 'shoegaze',
  step: 'tags',
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('draft', () => {
  it('keys edits by job and pick version', () => {
    expect(KEY).toBe('review:job1:2');
    expect(draftKey('job1', 3)).not.toBe(KEY);
  });

  it('round-trips a saved draft', () => {
    saveDraft(KEY, DRAFT);
    expect(loadDraft(KEY)).toEqual(DRAFT);
  });

  it('forgets a cleared draft', () => {
    saveDraft(KEY, DRAFT);
    clearDraft(KEY);
    expect(loadDraft(KEY)).toBeNull();
  });

  it('has nothing for a key never saved', () => {
    expect(loadDraft(KEY)).toBeNull();
  });

  it.each([
    ['not JSON', '{oops'],
    ['an array', '[]'],
    ['a missing field', JSON.stringify({ title: 'a', description: 'b', tags: 'c' })],
    ['a wrong type', JSON.stringify({ ...DRAFT, tags: ['x'] })],
    ['a number', '7'],
  ])('ignores %s', (_label, raw) => {
    localStorage.setItem(KEY, raw);
    expect(loadDraft(KEY)).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => saveDraft(KEY, DRAFT)).not.toThrow();
    expect(loadDraft(KEY)).toBeNull();
    expect(() => clearDraft(KEY)).not.toThrow();
  });
});
