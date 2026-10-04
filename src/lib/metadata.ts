export const TITLE_MAX = 100;
export const TAGS_MAX = 500;
export const DESCRIPTION_MAX = 5000;

// A hashtag starts the text or follows whitespace, so URL fragments (`page#top`) don't count.
const HASHTAG = /(?<!\S)#([\p{L}\p{N}_]+)/gu;

const words = (text: string) =>
  ` ${text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

/** Whole-word containment, so the title "Pop" rules out "pop music" but not "synthpop". */
export const containsWords = (text: string, phrase: string) =>
  phrase.trim() !== '' && words(text).includes(words(phrase));

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

function titleError(raw: string): string | undefined {
  const title = raw.trim();
  if (!title) return 'Title is required.';
  if (title.length > TITLE_MAX) return `Title is over ${TITLE_MAX} characters.`;
  if (/[<>]/.test(title)) return 'YouTube rejects < and > in titles.';
  return undefined;
}

function descriptionError(description: string, candidates: readonly string[]): string | undefined {
  if (description.length > DESCRIPTION_MAX) {
    return `Description is over ${DESCRIPTION_MAX} characters.`;
  }
  if (/[<>]/.test(description)) return 'YouTube rejects < and > in descriptions.';
  const allowed = new Set(candidates.map((tag) => tag.toLowerCase()));
  const stray = parseHashtags(description).filter((tag) => !allowed.has(tag));
  return stray.length > 0 ? `Not in this job's hashtag list: ${stray.join(' ')}` : undefined;
}

function tagsError(tags: string[]): string | undefined {
  const length = tagsLength(tags);
  if (length > TAGS_MAX) return `Tags are ${length} / ${TAGS_MAX} characters.`;
  if (tags.some((tag) => /[<>]/.test(tag))) return 'YouTube rejects < and > in tags.';
  if (tags.some((tag) => tag.startsWith('#'))) {
    return 'Tags are plain terms; hashtags belong in the description.';
  }
  return undefined;
}

/** YouTube's hard limits plus the rule that every hashtag comes from the job's candidates. */
export function validateFields(
  fields: { title: string; description: string; tags: string[] },
  candidates: readonly string[],
): FieldErrors {
  const found = {
    title: titleError(fields.title),
    description: descriptionError(fields.description, candidates),
    tags: tagsError(fields.tags),
  };
  return Object.fromEntries(
    Object.entries(found).filter(([, message]) => message !== undefined),
  ) as FieldErrors;
}
