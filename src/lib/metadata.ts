export const TITLE_MAX = 100;
export const TAGS_MAX = 500;
export const DESCRIPTION_MAX = 5000;

const HASHTAG = /#([\p{L}\p{N}_]+)/gu;

/** Every `#hashtag` in a text, lowercased, in order of first appearance. */
export function parseHashtags(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(HASHTAG)) seen.add(`#${match[1]!.toLowerCase()}`);
  return [...seen];
}

/** YouTube's count for the tags field: commas between tags, and quotes around tags with spaces. */
export function tagsLength(tags: string[]): number {
  if (tags.length === 0) return 0;
  const chars = tags.reduce((sum, tag) => sum + tag.length + (tag.includes(' ') ? 2 : 0), 0);
  return chars + tags.length - 1;
}

/** Splits the comma-separated tags field the way it is edited in the UI. */
export function splitTags(field: string): string[] {
  return field
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export type FieldErrors = Partial<Record<'title' | 'description' | 'tags', string>>;

/** YouTube's hard limits plus the rule that every hashtag comes from the job's candidates. */
export function validateFields(
  fields: { title: string; description: string; tags: string[] },
  candidates: readonly string[],
): FieldErrors {
  const errors: FieldErrors = {};
  const title = fields.title.trim();
  if (!title) errors.title = 'Title is required.';
  else if (title.length > TITLE_MAX) errors.title = `Title is over ${TITLE_MAX} characters.`;
  else if (/[<>]/.test(title)) errors.title = 'YouTube rejects < and > in titles.';

  if (fields.description.length > DESCRIPTION_MAX) {
    errors.description = `Description is over ${DESCRIPTION_MAX} characters.`;
  } else if (/[<>]/.test(fields.description)) {
    errors.description = 'YouTube rejects < and > in descriptions.';
  } else {
    const allowed = new Set(candidates.map((tag) => tag.toLowerCase()));
    const stray = parseHashtags(fields.description).filter((tag) => !allowed.has(tag));
    if (stray.length > 0) errors.description = `Not in this job's hashtag list: ${stray.join(' ')}`;
  }

  const length = tagsLength(fields.tags);
  if (length > TAGS_MAX) errors.tags = `Tags are ${length} / ${TAGS_MAX} characters.`;
  return errors;
}
