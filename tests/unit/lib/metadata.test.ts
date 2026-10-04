import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX,
  parseHashtags,
  splitTags,
  TAGS_MAX,
  tagsLength,
  TITLE_MAX,
  validateFields,
} from '$lib/metadata';

describe('parseHashtags', () => {
  it('ignores URL fragments and mid-word #', () => {
    expect(parseHashtags('See https://x.example/page#top and a#b, then #real')).toEqual(['#real']);
  });

  it('returns lowercased hashtags in first-seen order without duplicates', () => {
    expect(parseHashtags('New one #Synthwave #indie and #synthwave again #FLR')).toEqual([
      '#synthwave',
      '#indie',
      '#flr',
    ]);
  });

  it('accepts unicode letters, digits, and underscores', () => {
    expect(parseHashtags('#música #lofi_beats #2026 #日本')).toEqual([
      '#música',
      '#lofi_beats',
      '#2026',
      '#日本',
    ]);
  });

  it('stops at punctuation and ignores a bare #', () => {
    expect(parseHashtags('#rock, #pop. # nothing #-dash')).toEqual(['#rock', '#pop']);
  });

  it('returns nothing for text without hashtags', () => {
    expect(parseHashtags('')).toEqual([]);
    expect(parseHashtags('just words')).toEqual([]);
  });
});

describe('tagsLength', () => {
  it('counts commas between tags', () => {
    expect(tagsLength(['abc', 'de'])).toBe(6);
  });

  it('adds two quote characters for tags containing spaces', () => {
    expect(tagsLength(['indie rock', 'flr'])).toBe(10 + 2 + 3 + 1);
  });

  it('is zero for no tags and the bare length for one', () => {
    expect(tagsLength([])).toBe(0);
    expect(tagsLength(['solo'])).toBe(4);
  });
});

describe('splitTags', () => {
  it('splits on commas and trims each tag', () => {
    expect(splitTags(' indie rock ,flies like robots,  nathan')).toEqual([
      'indie rock',
      'flies like robots',
      'nathan',
    ]);
  });

  it('drops empty entries', () => {
    expect(splitTags(',, a ,,b,')).toEqual(['a', 'b']);
    expect(splitTags('')).toEqual([]);
    expect(splitTags('   ')).toEqual([]);
  });
});

describe('validateFields', () => {
  it('rejects angle brackets and hashtags in tags', () => {
    const base = { title: 't', description: '' };
    expect(validateFields({ ...base, tags: ['synth', '<demo>'] }, []).tags).toMatch(/< and >/);
    expect(validateFields({ ...base, tags: ['#synthwave'] }, []).tags).toMatch(/plain terms/);
  });

  const ok = {
    title: 'PeekaBoo',
    description: 'New from Flies Like Robots #indie',
    tags: ['indie'],
  };

  it('accepts fields within limits whose hashtags are all candidates', () => {
    expect(validateFields(ok, ['#Indie', '#rock'])).toEqual({});
  });

  it('requires a non-blank title', () => {
    expect(validateFields({ ...ok, title: '   ' }, ['#indie']).title).toBe('Title is required.');
  });

  it('rejects titles over the limit, measured after trimming', () => {
    expect(validateFields({ ...ok, title: 'x'.repeat(TITLE_MAX) }, ['#indie'])).toEqual({});
    expect(validateFields({ ...ok, title: ` ${'x'.repeat(TITLE_MAX)} ` }, ['#indie'])).toEqual({});
    expect(validateFields({ ...ok, title: 'x'.repeat(TITLE_MAX + 1) }, ['#indie']).title).toBe(
      'Title is over 100 characters.',
    );
  });

  it('rejects angle brackets in title and description', () => {
    expect(validateFields({ ...ok, title: 'a <b>' }, ['#indie']).title).toMatch(/< and >/);
    expect(validateFields({ ...ok, description: 'a > b' }, ['#indie']).description).toMatch(
      /< and >/,
    );
  });

  it('rejects descriptions over the limit before checking hashtags', () => {
    const description = `#stray ${'x'.repeat(DESCRIPTION_MAX)}`;
    expect(validateFields({ ...ok, description }, []).description).toBe(
      'Description is over 5000 characters.',
    );
    expect(
      validateFields({ ...ok, description: 'x'.repeat(DESCRIPTION_MAX) }, []).description,
    ).toBeUndefined();
  });

  it('lists every hashtag not in the candidate list', () => {
    expect(
      validateFields({ ...ok, description: '#indie #Viral #fyp' }, ['#indie']).description,
    ).toBe("Not in this job's hashtag list: #viral #fyp");
  });

  it('rejects any hashtag when there are no candidates', () => {
    expect(validateFields(ok, []).description).toBe("Not in this job's hashtag list: #indie");
  });

  it('rejects tags over the YouTube character budget', () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag number ${i}`);
    const errors = validateFields({ ...ok, tags }, ['#indie']);
    expect(errors.tags).toBe(`Tags are ${tagsLength(tags)} / ${TAGS_MAX} characters.`);
  });

  it('accepts tags exactly at the budget', () => {
    expect(validateFields({ ...ok, tags: ['x'.repeat(TAGS_MAX)] }, ['#indie'])).toEqual({});
  });

  it('reports several field errors at once', () => {
    const errors = validateFields(
      { title: '', description: '#nope', tags: ['y'.repeat(TAGS_MAX + 1)] },
      [],
    );
    expect(Object.keys(errors).sort()).toEqual(['description', 'tags', 'title']);
  });
});
