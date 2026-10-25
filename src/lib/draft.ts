/** Review edits kept in this browser so "Save & leave" or a reload returns to them. */
export type Draft = { title: string; description: string; tags: string; step: string };

const KEYS: (keyof Draft)[] = ['title', 'description', 'tags', 'step'];

/** Keyed per pick version: a re-run starts from the model's new draft, not old edits. */
export const draftKey = (jobId: string, version: number) => `review:${jobId}:${version}`;

export function loadDraft(key: string): Draft | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!stored || typeof stored !== 'object') return null;
    const record = stored as Record<string, unknown>;
    return KEYS.every((k) => typeof record[k] === 'string') ? (record as Draft) : null;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, draft: Draft): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Private mode or blocked storage: edits just won't survive leaving the page.
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same as above; nothing to clear.
  }
}
