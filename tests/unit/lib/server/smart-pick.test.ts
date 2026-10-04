// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESCRIPTION_MAX, parseHashtags, tagsLength, TAGS_MAX, TITLE_MAX } from '$lib/metadata';
import type { Fact, Feedback } from '$lib/server/memory';
import {
  allowedLinks,
  ARTIST_VOICE,
  CONTACT_LINE,
  buildPickMessages,
  digestChunks,
  finalizePick,
  isRawPick,
  measuredFlags,
  shortFlag,
  runPick,
  sameText,
  weighFeedback,
  type PickContext,
  type PickFixups,
  type RawPick,
} from '$lib/server/smart-pick';
import type { Chunk, Measurements, Probe } from '$lib/types';
import type { AgentSpan } from '$lib/server/tracing';
import { agentSpanIO, clearAgentSpan } from '../../../helpers/agent-span';
import { span } from '../../../mocks/sentry';
import { omit } from '../../../helpers/omit';

const SYNTHWAVE = '#synthwave';
const RETROWAVE_TAG = '#retrowave';
const ARTIST = 'Flies Like Robots';
const FRESH_TITLE = 'Fresh Title';

const raw = (over: Partial<RawPick> = {}): RawPick => ({
  title: 'PeekaBoo',
  description: 'A bright synth track.',
  hashtags: [SYNTHWAVE, RETROWAVE_TAG, '#newmusic'],
  tags: ['synthwave', 'PeekaBoo'],
  flags: [],
  brandCheck: 'Matches the recent uploads.',
  why: { title: 't', description: 'd', tags: 'g' },
  bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
  ...over,
});

const candidates = [SYNTHWAVE, RETROWAVE_TAG, '#newmusic', '#electronic', '#indie', '#80s'];
const tagNames = ['synthwave', 'retrowave', 'synthpop', 'new music', '80s', 'outrun'];
const cands = (...tags: string[]) => tags.map((tag) => ({ tag, usedBy: 1 }));
const tagCandidates = cands(...tagNames);

const facts: Fact[] = [
  { key: 'artist-name', value: ARTIST, kind: 'FACT', public: true },
  { key: 'bandcamp', value: 'https://flr.bandcamp.com', kind: 'FACT', public: true },
  {
    key: 'site',
    value: 'Official site https://flieslikerobots.example/',
    kind: 'APPROVED',
    public: true,
  },
  { key: 'guess', value: 'https://guess.example/x', kind: 'INFERENCE', public: false },
];

const fix = (over: Partial<PickFixups> = {}): PickFixups => ({
  songTitle: 'PeekaBoo',
  candidates,
  tagCandidates,
  facts,
  measurements: null,
  probe: null,
  ...over,
});

const measurements = (over: Partial<Measurements> = {}): Measurements => ({
  integratedLufs: -14,
  truePeakDbtp: -2,
  peakLevelDb: -2,
  clippedSamples: 0,
  silences: [],
  ...over,
});

const chunk = (index: number, over: Partial<Chunk> = {}): Chunk => ({
  index,
  startSec: index * 29.5,
  durationSec: 29.5,
  measurements: measurements(),
  analysis: {
    visual: 'neon city at night',
    music: {
      genre: ['synthwave'],
      tempoFeel: 'driving',
      instrumentation: ['synth', 'drum machine'],
      vocals: 'none',
      mood: ['nostalgic'],
    },
    qualityFlags: [],
  },
  raw: null,
  modelMs: 10,
  ...over,
});

const feedback = (kind: Feedback['kind'], over: Partial<Feedback> = {}): Feedback => ({
  kind,
  jobId: 'j',
  songTitle: 'PeekaBoo',
  pickVersion: 1,
  at: 1,
  ...over,
});

const ctx = (over: Partial<PickContext> = {}): PickContext => ({
  songTitle: 'PeekaBoo',
  notes: '',
  chunks: [chunk(0)],
  measurements: null,
  probe: null,
  recent: [],
  candidates,
  tagCandidates,
  audience: [],
  facts,
  feedback: [],
  skipped: [],
  brand: null,
  ...over,
});

const allInCandidates = (description: string, list = candidates) => {
  const allowed = new Set(list.map((c) => c.toLowerCase()));
  return parseHashtags(description).every((tag) => allowed.has(tag));
};

describe('isRawPick', () => {
  it('accepts a complete pick', () => {
    expect(isRawPick(raw())).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'pick'],
    ['a numeric title', { ...raw(), title: 1 }],
    ['a missing description', omit(raw(), 'description')],
    ['non-string hashtags', { ...raw(), hashtags: [1] }],
    ['tags not an array', { ...raw(), tags: 'a,b' }],
    ['flags missing', omit(raw(), 'flags')],
    ['brandCheck missing', { ...raw(), brandCheck: null }],
    ['why null', { ...raw(), why: null }],
    ['why a string', { ...raw(), why: 'because' }],
    ['bandcamp missing', omit(raw(), 'bandcamp')],
    ['bandcamp about not a string', { ...raw(), bandcamp: { about: 1, credits: '' } }],
    ['bandcamp credits missing', { ...raw(), bandcamp: { about: '' } }],
    ['why.title missing', { ...raw(), why: { description: '', tags: '' } }],
    ['why.description missing', { ...raw(), why: { title: '', tags: '' } }],
    ['why.tags missing', { ...raw(), why: { title: '', description: '' } }],
  ])('rejects %s', (_label, value) => {
    expect(isRawPick(value)).toBe(false);
  });

  it('accepts empty arrays', () => {
    expect(isRawPick(raw({ hashtags: [], tags: [], flags: [] }))).toBe(true);
  });
});

describe('digestChunks', () => {
  it('condenses analysed chunks', () => {
    expect(digestChunks([chunk(1, { startSec: 29.6 })])).toEqual([
      {
        at: 30,
        visual: 'neon city at night',
        genre: ['synthwave'],
        tempoFeel: 'driving',
        instrumentation: ['synth', 'drum machine'],
        vocals: 'none',
        mood: ['nostalgic'],
      },
    ]);
  });

  it('keeps quality flags when present', () => {
    const c = chunk(0);
    c.analysis!.qualityFlags = ['camera shake'];
    expect(digestChunks([c])[0]!.qualityFlags).toEqual(['camera shake']);
  });

  it('keeps up to 300 chars of raw text for unparsed chunks', () => {
    const [digest] = digestChunks([chunk(0, { analysis: null, raw: 'x'.repeat(500) })]);
    expect(digest!.unparsed).toHaveLength(300);
    expect(digest!.genre).toBeUndefined();
    expect(digest!.visual).toBeUndefined();
    expect(digest!.qualityFlags).toBeUndefined();
  });

  it('returns an empty list for no chunks', () => {
    expect(digestChunks([])).toEqual([]);
  });
});

describe('weighFeedback', () => {
  it('weighs skips weak and edits and approvals strong', () => {
    const weighed = weighFeedback([
      feedback('SKIPPED', { before: 'Old' }),
      feedback('EDITED', { field: 'title', before: 'A', after: 'B' }),
      feedback('ACCEPTED', { after: 'B' }),
    ]);
    expect(weighed.map((w) => [w.kind, w.weight])).toEqual([
      ['SKIPPED', 'weak'],
      ['EDITED', 'strong'],
      ['ACCEPTED', 'strong'],
    ]);
    expect(weighed[1]).toEqual({
      weight: 'strong',
      kind: 'EDITED',
      song: 'PeekaBoo',
      field: 'title',
      before: 'A',
      after: 'B',
    });
  });

  it('truncates long before/after values and tolerates missing ones', () => {
    const [w] = weighFeedback([feedback('EDITED', { before: 'b'.repeat(400) })]);
    expect(w!.before).toHaveLength(300);
    expect(w!.after).toBeUndefined();
  });
});

describe('buildPickMessages', () => {
  it("writes the description in the artist's own voice on runs that may name him", () => {
    const rules = system(buildPickMessages(ctx()));
    expect(rules).toContain(ARTIST_VOICE);
    expect(rules).toContain('hacked and slashed');
    expect(rules).toContain('Never copy them word for word, except the credit line.');
    expect(rules).toContain('never on its own line');
    expect(rules).toContain('Never claim what the lyrics say.');
    expect(rules).toContain("bandcamp.about: the same song for Bandcamp's About field");
    expect(rules).toContain('bandcamp.credits: the credit line and contact line');
    expect(rules).toContain(`his contact line exactly: "${CONTACT_LINE}"`);
    expect(CONTACT_LINE).toBe('Contact at flieslikerobots@gmail.com.');
    expect(rules).toContain('Never write placeholders');
    expect(rules).toContain('Correct spelling, capitalization, and grammar');
    expect(rules).toContain('Never open with or repeat the title');
    // Format rules stay out of the voice, which changes only from evidence of how he writes.
    expect(ARTIST_VOICE).not.toContain('Correct spelling');
    expect(ARTIST_VOICE).not.toContain('repeat the title');
    expect(rules).not.toContain('The lyrics are based on');
    expect(rules).toContain('wording follows the artist voice below');
    expect(rules).not.toMatch(/persona/i);
  });

  const userParts = (messages: ReturnType<typeof buildPickMessages>) =>
    messages[1]!.content as { type: string; text?: string; image_url?: { url: string } }[];
  const context = (messages: ReturnType<typeof buildPickMessages>) =>
    JSON.parse(userParts(messages)[0]!.text!) as Record<string, unknown>;
  const system = (messages: ReturnType<typeof buildPickMessages>) => messages[0]!.content as string;

  it('names the artist when allowed', () => {
    const messages = buildPickMessages(ctx({ notes: 'live take', measurements: measurements() }));
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    const body = context(messages);
    expect(body.artist).toBe(ARTIST);
    expect(body.artistNotes).toBe('live take');
    expect(body.candidateHashtags).toEqual(candidates);
    expect(body.candidateTags).toEqual([...tagCandidates, { tag: ARTIST, usedBy: 0 }]);
    expect(body.ffmpeg).toEqual(measurements());
    expect(system(messages)).toContain("recentUploads are the artist's own uploads");
    expect(system(messages)).toContain('credit lines');
    expect(system(messages)).not.toContain('name no artist');
  });

  it('grounds title, description, and tags in the genre search', () => {
    const audience = [{ title: 'Top hit', description: 'Credits.', tags: ['outrun'], views: 9000 }];
    const messages = buildPickMessages(ctx({ audience }));
    const body = context(messages);
    expect(body.audienceTopVideos).toEqual(audience);
    expect(system(messages)).toContain('most-viewed music videos in this genre');
    expect(system(messages)).toContain('copied exactly from a candidateTags tag');
    expect(system(messages)).toContain('must name something the windows heard');
    expect(system(messages)).toContain('Skip mood, scene, and decade words');
    expect(system(messages)).toContain('Include "Flies Like Robots".');
    expect(system(messages)).toContain('Never the song title');
    expect(system(messages)).not.toMatch(/keep what already works/i);
  });

  it("sends the artist's uploads for identity only, without their tags", () => {
    const recent = [
      {
        videoId: 'a',
        title: 'A',
        description: 'Written and performed by Nathan.',
        tags: ['old tag'],
        publishedAt: 'p',
        thumbnailUrl: null,
        views: 3,
        durationSec: 0,
        thumbnail: null,
      },
    ];
    const uploads = context(buildPickMessages(ctx({ recent }))).recentUploads as object[];
    expect(uploads).toEqual([
      { title: 'A', description: 'Written and performed by Nathan.', publishedAt: 'p' },
    ]);
  });

  it('omits empty notes, measurements, and skipped versions', () => {
    const body = context(buildPickMessages(ctx()));
    expect(body).not.toHaveProperty('artistNotes');
    expect(body).not.toHaveProperty('ffmpeg');
    expect(body).not.toHaveProperty('skippedVersions');
  });

  it('adds the skipped instruction only when there are skipped versions', () => {
    const without = buildPickMessages(ctx());
    expect(system(without)).not.toContain('skippedVersions were rejected');
    const skipped = [{ title: 'Old Title', description: 'old' }];
    const withSkips = buildPickMessages(ctx({ skipped }));
    expect(system(withSkips)).toContain(
      'skippedVersions were rejected. Write a different title and a different description',
    );
    expect(context(withSkips).skippedVersions).toEqual(skipped);
  });

  it('sends an approved brand guide and checks the proposal against it', () => {
    const brand = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: ['Emoji'] };
    const messages = buildPickMessages(ctx({ brand }));
    expect(context(messages).brandGuide).toEqual(brand);
    expect(system(messages)).toContain('brandGuide');
  });

  it('leaves the brand guide out until one is approved', () => {
    const messages = buildPickMessages(ctx());
    expect(context(messages)).not.toHaveProperty('brandGuide');
    expect(system(messages)).not.toContain('brandGuide');
  });

  it('appends thumbnails as image parts after a caption, skipping missing ones', () => {
    const recent = [
      {
        videoId: 'a',
        title: 'A',
        description: 'd'.repeat(900),
        tags: ['x'],
        publishedAt: 'p',
        thumbnailUrl: 'u',
        views: 0,
        durationSec: 0,
        thumbnail: 'data:image/jpeg;base64,AAA',
      },
      {
        videoId: 'b',
        title: 'B',
        description: '',
        tags: [],
        publishedAt: 'p',
        thumbnailUrl: null,
        views: 0,
        durationSec: 0,
        thumbnail: null,
      },
      {
        videoId: 'c',
        title: 'C',
        description: '',
        tags: [],
        publishedAt: 'p',
        thumbnailUrl: 'u',
        views: 0,
        durationSec: 0,
        thumbnail: 'data:image/png;base64,BBB',
      },
    ];
    const messages = buildPickMessages(ctx({ recent }));
    const parts = userParts(messages);
    expect(parts).toHaveLength(4);
    expect(parts[1]).toEqual({
      type: 'text',
      text: 'Thumbnails of the recent uploads, newest first:',
    });
    expect(parts[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,AAA' },
    });
    expect(parts[3]!.image_url!.url).toBe('data:image/png;base64,BBB');
    const uploads = context(messages).recentUploads as { description: string }[];
    expect(uploads).toHaveLength(3);
    expect(uploads[0]!.description).toHaveLength(700);
  });

  it('sends only the context text when no thumbnails exist', () => {
    expect(userParts(buildPickMessages(ctx()))).toHaveLength(1);
  });

  it('keeps private facts out of the prompt and weighs feedback', () => {
    const body = context(buildPickMessages(ctx({ feedback: [feedback('SKIPPED')] })));
    const sent = body.facts as { public: boolean }[];
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((f) => f.public)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('guess.example');
    expect(body.feedback).toEqual([expect.objectContaining({ kind: 'SKIPPED', weight: 'weak' })]);
  });
});

describe('allowedLinks', () => {
  it('drops links that appear only in private facts', () => {
    const privateFact: Fact = {
      key: 'p',
      value: 'https://hidden.example/x',
      kind: 'FACT',
      public: false,
    };
    expect(allowedLinks('See https://hidden.example/x', [privateFact])).toBe('See ');
  });

  it('keeps links from FACT and APPROVED records', () => {
    const text = 'Buy https://flr.bandcamp.com and visit https://flieslikerobots.example/';
    expect(allowedLinks(text, facts)).toBe(text);
  });

  it('drops links that appear only in INFERENCE records', () => {
    expect(allowedLinks('See https://guess.example/x now', facts)).toBe('See  now');
  });

  it('drops unknown links', () => {
    expect(allowedLinks('Go https://evil.example/a)', facts)).toBe('Go )');
  });

  it('drops every link with no facts', () => {
    expect(allowedLinks('https://a.b https://c.d', [])).toBe(' ');
  });

  it('leaves text without links untouched', () => {
    expect(allowedLinks('no links here', facts)).toBe('no links here');
  });
});

describe('shortFlag', () => {
  const probe = (width: number, height: number, durationSec = 79): Probe => ({
    durationSec,
    width,
    height,
    hasAudio: true,
  });

  it('flags a vertical or square video of 3 minutes or less', () => {
    expect(shortFlag(probe(720, 1280))).toEqual([
      'Vertical and 3 minutes or shorter: YouTube will publish it as a Short',
    ]);
    expect(shortFlag(probe(1080, 1080, 180))).toEqual([
      'Square and 3 minutes or shorter: YouTube will publish it as a Short',
    ]);
  });

  it('leaves landscape and longer videos alone', () => {
    expect(shortFlag(probe(1280, 720))).toEqual([]);
    expect(shortFlag(probe(720, 1280, 180.5))).toEqual([]);
  });

  it('says nothing without a probe or a video size', () => {
    expect(shortFlag(null)).toEqual([]);
    expect(shortFlag({ durationSec: 60, width: null, height: null, hasAudio: true })).toEqual([]);
  });

  it('lands in the pick flags after the measured ones', () => {
    const pick = finalizePick(
      raw({ flags: ['Dark opening frames'] }),
      fix({ probe: probe(720, 1280), measurements: measurements({ truePeakDbtp: -0.3 }) }),
    );
    expect(pick.flags).toEqual([
      'True peak -0.3 dBTP, above the -1 dBTP ceiling',
      'Vertical and 3 minutes or shorter: YouTube will publish it as a Short',
      'Dark opening frames',
    ]);
  });
});

describe('measuredFlags', () => {
  it('returns nothing without measurements', () => {
    expect(measuredFlags(null)).toEqual([]);
  });

  it('returns nothing for a clean master', () => {
    expect(measuredFlags(measurements({ truePeakDbtp: -1 }))).toEqual([]);
    expect(measuredFlags(measurements({ truePeakDbtp: null }))).toEqual([]);
  });

  it('flags true peak above -1, clipping, and silences of 2s or more', () => {
    expect(
      measuredFlags(
        measurements({
          truePeakDbtp: -0.42,
          clippedSamples: 12,
          silences: [
            { start: 0, end: 1.9 },
            { start: 60, end: 62 },
            { start: 100.25, end: 105.5 },
          ],
        }),
      ),
    ).toEqual([
      'True peak -0.4 dBTP, above the -1 dBTP ceiling',
      '12 samples at full scale (clipping)',
      'Silence 60.0s to 62.0s',
      'Silence 100.3s to 105.5s',
    ]);
  });
});

describe('sameText', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(sameText(' PeekaBoo ', 'peekaboo')).toBe(true);
    expect(sameText('PeekaBoo', 'PeekaBoo 2')).toBe(false);
  });

  it('ignores hashtags and inner spacing, so a reshuffled closing line is still a repeat', () => {
    expect(sameText('Line one.\n\n#synthwave #retro', 'line  one.\n#retro')).toBe(true);
    expect(sameText('Line one.', 'Line two.')).toBe(false);
  });
});

describe('finalizePick', () => {
  it('closes the description with the picked candidate hashtags', () => {
    const pick = finalizePick(raw(), fix());
    expect(pick.hashtags).toEqual([SYNTHWAVE, RETROWAVE_TAG, '#newmusic']);
    expect(pick.description).toBe('A bright synth track.\n\n#synthwave #retrowave #newmusic');
    expect(allInCandidates(pick.description)).toBe(true);
  });

  it('drops invented hashtags and pads to 3 from candidates', () => {
    const pick = finalizePick(raw({ hashtags: ['#madeup', SYNTHWAVE, '#alsofake'] }), fix());
    expect(pick.hashtags).toEqual([SYNTHWAVE, RETROWAVE_TAG, '#newmusic']);
    expect(pick.description).not.toContain('#madeup');
    expect(pick.description).not.toContain('#alsofake');
    expect(allInCandidates(pick.description)).toBe(true);
  });

  it('pads from candidates when the model picks none', () => {
    const pick = finalizePick(raw({ hashtags: [] }), fix());
    expect(pick.hashtags).toEqual(candidates.slice(0, 3));
  });

  it('caps hashtags at 5', () => {
    const pick = finalizePick(raw({ hashtags: candidates }), fix());
    expect(pick.hashtags).toEqual(candidates.slice(0, 5));
    expect(parseHashtags(pick.description)).toHaveLength(5);
  });

  it('accepts hashtags without # and in any case, returning candidate casing', () => {
    const pick = finalizePick(
      raw({ hashtags: ['SynthWave', '#INDIE', '80s'] }),
      fix({ candidates: ['#SynthWave', '#indie', '#80s'] }),
    );
    expect(pick.hashtags).toEqual(['#SynthWave', '#indie', '#80s']);
    expect(pick.description.endsWith('#SynthWave #indie #80s')).toBe(true);
  });

  it('draws hashtags from the chosen tags first, so the description and tags agree', () => {
    const pick = finalizePick(
      raw({ tags: ['retrowave', 'new music', 'outrun'], hashtags: ['#indie', '#80s'] }),
      fix({
        candidates: ['#indie', '#80s', RETROWAVE_TAG, '#newmusic'],
        tagCandidates: cands('retrowave', 'new music', 'outrun'),
      }),
    );
    expect(pick.hashtags).toEqual([RETROWAVE_TAG, '#newmusic', '#indie', '#80s']);
  });

  it('moves candidate hashtags from the body to the closing line and removes invented ones', () => {
    const pick = finalizePick(
      raw({
        hashtags: [],
        description: 'Night drive #electronic vibes #notacandidate.\n\nMore soon #indie',
      }),
      fix(),
    );
    expect(pick.hashtags).toEqual([SYNTHWAVE, '#electronic', '#indie']);
    expect(pick.description).toBe(
      'Night drive vibes .\n\nMore soon\n\n#synthwave #electronic #indie',
    );
    expect(allInCandidates(pick.description)).toBe(true);
  });

  it('every description hashtag is a candidate even under adversarial input', () => {
    const pick = finalizePick(
      raw({
        hashtags: ['#fake1', '#fake2', '#fake3', '#fake4', '#fake5', '#fake6'],
        description: '#lead #FLR ##double #über #snake_case end#tail',
      }),
      fix(),
    );
    expect(allInCandidates(pick.description)).toBe(true);
    expect(pick.hashtags.every((h) => candidates.includes(h))).toBe(true);
    expect(pick.hashtags).toHaveLength(3);
  });

  it('pads with fewer than 3 hashtags when the candidate list is short', () => {
    const pick = finalizePick(raw({ hashtags: [] }), fix({ candidates: [SYNTHWAVE] }));
    expect(pick.hashtags).toEqual([SYNTHWAVE]);
    expect(pick.description).toBe('A bright synth track.\n\n#synthwave');
  });

  it('leaves the description without a closing line when there are no candidates', () => {
    const pick = finalizePick(raw({ description: 'Body #synthwave' }), fix({ candidates: [] }));
    expect(pick.hashtags).toEqual([]);
    expect(pick.description).toBe('Body');
    expect(parseHashtags(pick.description)).toEqual([]);
  });

  it('returns only the hashtags when the body is empty', () => {
    const pick = finalizePick(raw({ description: '' }), fix());
    expect(pick.description).toBe('#synthwave #retrowave #newmusic');
  });

  it('dedupes hashtags given with and without #', () => {
    const pick = finalizePick(
      raw({ hashtags: ['synthwave', SYNTHWAVE], description: 'Body #synthwave' }),
      fix(),
    );
    expect(pick.hashtags).toEqual([SYNTHWAVE, RETROWAVE_TAG, '#newmusic']);
  });

  it('never lets angle-bracket stripping create a stray hashtag', () => {
    const pick = finalizePick(raw({ description: 'Out now #<invented>' }), fix());
    expect(allInCandidates(pick.description)).toBe(true);
  });
});

describe('finalizePick: links, tags, and limits', () => {
  it('cleans the Bandcamp draft like the description: fact links only, no hashtags or notes', () => {
    const pick = finalizePick(
      raw({
        bandcamp: {
          about: 'Dark synth. #synthwave\n[No contact line found]\nSee https://evil.example/x',
          credits: 'Written by Nathan.  https://flr.bandcamp.com',
        },
      }),
      fix(),
    );
    expect(pick.bandcamp.about).toBe('Dark synth.\n\nSee');
    expect(pick.bandcamp.credits).toBe('Written by Nathan. https://flr.bandcamp.com');
  });

  it('keeps fact links and removes others from the description', () => {
    const pick = finalizePick(
      raw({
        description:
          'Stream https://flr.bandcamp.com and https://flieslikerobots.example/ not https://guess.example/x or https://spam.example',
      }),
      fix(),
    );
    expect(pick.description).toContain('https://flr.bandcamp.com');
    expect(pick.description).toContain('https://flieslikerobots.example/');
    expect(pick.description).not.toContain('guess.example');
    expect(pick.description).not.toContain('spam.example');
  });

  it('strips < and > and tidies whitespace', () => {
    const pick = finalizePick(
      raw({ title: '  <Peeka>  Boo ', description: 'Line one   \n\n\n\nLine  two' }),
      fix(),
    );
    expect(pick.title).toBe('Peeka Boo');
    expect(pick.description.startsWith('Line one\n\nLine two\n\n')).toBe(true);
  });

  it('keeps only candidate tags, deduped, in the model order with candidate casing', () => {
    const pick = finalizePick(
      raw({ tags: ['#Synthwave', '##RETROWAVE', 'synthwave', 'synthpop', 'invented', '  '] }),
      fix(),
    );
    expect(pick.tags).toEqual(['synthwave', 'retrowave', 'synthpop', ARTIST]);
  });

  it('never uses the song title as a tag, even when the search returns it', () => {
    const pick = finalizePick(
      raw({ tags: ['PeekaBoo', 'peekaboo official video', 'synthwave'] }),
      fix({ tagCandidates: cands('PeekaBoo', 'peekaboo official video', ...tagNames) }),
    );
    expect(pick.tags.some((t) => t.toLowerCase().includes('peekaboo'))).toBe(false);
    expect(pick.tags[0]).toBe('synthwave');
  });

  it('rejects tags holding the title as whole words but keeps words that merely contain it', () => {
    const names = ['synthpop', 'pop music', 'Pop', 'hyperpop'];
    const pick = finalizePick(
      raw({ tags: names }),
      fix({ songTitle: 'Pop', tagCandidates: cands(...names) }),
    );
    expect(pick.tags).toEqual(['synthpop', 'hyperpop', ARTIST]);
  });

  it('lists the artist name once even when the search returned it', () => {
    const messages = buildPickMessages(
      ctx({ tagCandidates: cands('synthwave', 'flies like robots') }),
    );
    const parts = messages[1]!.content as { text?: string }[];
    expect(JSON.parse(parts[0]!.text!).candidateTags).toEqual([
      { tag: 'synthwave', usedBy: 1 },
      { tag: ARTIST, usedBy: 0 },
    ]);
  });

  it('drops bracketed placeholder lines the model writes into the description', () => {
    const pick = finalizePick(
      raw({
        description:
          'Vaporgram by Flies Like Robots\n\n[Contact line from recentUploads: None provided]\n\nKeep [this] inline.',
      }),
      fix(),
    );
    expect(pick.description).not.toContain('Contact line');
    expect(pick.description).toContain('Keep [this] inline.');
    expect(pick.description.startsWith('Vaporgram by Flies Like Robots\n\nKeep')).toBe(true);
  });

  it('never fills from the pool: the artist name alone when the model picks nothing usable', () => {
    const pick = finalizePick(raw({ tags: ['made up', 'PeekaBoo'] }), fix());
    expect(pick.tags).toEqual([ARTIST]);
  });

  it('keeps the artist where the model placed it', () => {
    const pick = finalizePick(raw({ tags: [ARTIST, 'outrun'] }), fix());
    expect(pick.tags).toEqual([ARTIST, 'outrun']);
  });

  it('caps tags at 10, keeping the artist name', () => {
    const names = Array.from({ length: 14 }, (_, i) => `genre ${i}`);
    const pick = finalizePick(raw({ tags: names }), fix({ tagCandidates: cands(...names) }));
    expect(pick.tags).toEqual([...names.slice(0, 9), ARTIST]);
  });

  it('falls back to the artist name alone when the search found no tags', () => {
    const pick = finalizePick(raw({ tags: ['synthwave'] }), fix({ tagCandidates: [] }));
    expect(pick.tags).toEqual([ARTIST]);
  });

  it('keeps tags within 500 characters by YouTube counting', () => {
    const names = Array.from({ length: 10 }, (_, i) => `tag number ${i} ${'x'.repeat(45)}`);
    const pick = finalizePick(raw({ tags: names }), fix({ tagCandidates: cands(...names) }));
    expect(tagsLength(pick.tags)).toBeLessThanOrEqual(TAGS_MAX);
    expect(pick.tags.length).toBeGreaterThan(5);
    expect(pick.tags.length).toBeLessThan(names.length);
    expect(pick.tags[0]).toBe(names[0]);
  });

  it('skips one oversize tag but keeps later ones that fit', () => {
    const pool = ['a', 'x'.repeat(600), 'b'];
    const pick = finalizePick(raw({ tags: pool }), fix({ tagCandidates: cands(...pool) }));
    expect(pick.tags).toEqual(['a', 'b', ARTIST]);
  });

  it('clips the title to 100 characters at a word boundary', () => {
    const title = 'word '.repeat(40).trim();
    const pick = finalizePick(raw({ title }), fix());
    expect(pick.title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(pick.title.endsWith('word')).toBe(true);
  });

  it('hard-cuts a title with no usable space', () => {
    const pick = finalizePick(raw({ title: 'x'.repeat(150) }), fix());
    expect(pick.title).toBe('x'.repeat(TITLE_MAX));
  });

  it('keeps the description within 5000 characters including the hashtags', () => {
    const pick = finalizePick(raw({ description: 'lorem ipsum '.repeat(700) }), fix());
    expect(pick.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(pick.description.endsWith('#synthwave #retrowave #newmusic')).toBe(true);
    expect(allInCandidates(pick.description)).toBe(true);
  });

  it('strips model-emitted dB, LUFS, and BPM numbers but keeps ffmpeg flags', () => {
    const pick = finalizePick(
      raw({
        title: 'PeekaBoo at -14 LUFS',
        description: 'Mastered to -9 LUFS with -0.5 dBTP peaks at 120 bpm.',
        flags: ['Too loud at -6 LUFS', '-3 dB'],
        brandCheck: 'Louder than usual by 3 dB.',
        why: { title: 'At -14 LUFS', description: 'd', tags: 't' },
        bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
      }),
      fix({ measurements: measurements({ truePeakDbtp: -0.3 }) }),
    );
    expect(pick.title).toBe('PeekaBoo at');
    expect(pick.description).not.toMatch(/LUFS|dBTP|bpm|-9|-0\.5|120/);
    expect(pick.brandCheck).not.toMatch(/\d\s?dB/);
    expect(pick.why.title).not.toContain('LUFS');
    expect(pick.flags).toEqual(['True peak -0.3 dBTP, above the -1 dBTP ceiling', 'Too loud at']);
  });

  it('keeps the FLR name in the title and tags on every run', () => {
    const pick = finalizePick(
      raw({ title: 'PeekaBoo - Flies Like Robots', tags: [ARTIST] }),
      fix(),
    );
    expect(pick.title).toBe('PeekaBoo - Flies Like Robots');
    expect(pick.tags[0]).toBe(ARTIST);
  });

  it('keeps the #fragment of an allowed link', () => {
    const link = 'https://flr.bandcamp.com/track/peekaboo#lyrics';
    const pick = finalizePick(
      raw({ description: `Listen ${link}` }),
      fix({ facts: [{ key: 'bc', value: link, kind: 'FACT', public: true }] }),
    );
    expect(pick.description).toContain(link);
    expect(allInCandidates(pick.description)).toBe(true);
  });

  it('passes brandCheck and why through', () => {
    const pick = finalizePick(raw(), fix());
    expect(pick.brandCheck).toBe('Matches the recent uploads.');
    expect(pick.why).toEqual({ title: 't', description: 'd', tags: 'g' });
  });
});

describe('runPick', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const reply = (content: string) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content, reasoning_content: 'thinking' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const sentBodies = () =>
    fetchMock.mock.calls.map(
      ([, init]) =>
        JSON.parse(String((init as RequestInit).body)) as {
          messages: { role: string; content: unknown }[];
          temperature: number;
          max_tokens: number;
          response_format: { type: string; json_schema: { name: string } };
        },
    );

  beforeEach(() => {
    clearAgentSpan();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the first request and the finalized pick on the agent span', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'Old Title' }))))
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: FRESH_TITLE }))));
    const result = await runPick(
      ctx({ skipped: [{ title: 'Old Title', description: 'x' }] }),
      undefined,
      span as unknown as AgentSpan,
    );
    const { input, output } = agentSpanIO();
    expect(input).toHaveLength(1);
    expect(input[0]!['gen_ai.input.messages']).not.toContain('repeats a skipped version');
    expect(input[0]!['gen_ai.system_instructions']).toBeDefined();
    expect(output).toEqual([JSON.stringify(result!.pick)]);
  });

  it('records no agent output when the pick fails', async () => {
    fetchMock.mockImplementation(async () => reply('not json'));
    expect(await runPick(ctx(), undefined, span as unknown as AgentSpan)).toBeNull();
    expect(agentSpanIO().input).toHaveLength(1);
    expect(agentSpanIO().output).toEqual([]);
  });

  it('records nothing on a span when none is given', async () => {
    fetchMock.mockResolvedValueOnce(reply(JSON.stringify(raw())));
    await runPick(ctx());
    expect(agentSpanIO()).toEqual({ input: [], output: [] });
  });

  it('returns the finalized pick from one call', async () => {
    fetchMock.mockResolvedValueOnce(reply(JSON.stringify(raw())));
    const result = await runPick(ctx());
    expect(result).not.toBeNull();
    expect(result!.pick.title).toBe('PeekaBoo');
    expect(allInCandidates(result!.pick.description)).toBe(true);
    expect(result!.ms).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://127.0.0.1:8081/v1/chat/completions');
    const [body] = sentBodies();
    expect(body!.temperature).toBeCloseTo(0.2);
    expect(body!.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(body!.response_format.type).toBe('json_schema');
    expect(body!.response_format.json_schema.name).toBe('smart_pick');
  });

  it('retries once when the title repeats a skipped version and keeps the new title', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'Old Title' }))))
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: FRESH_TITLE }))));
    const result = await runPick(ctx({ skipped: [{ title: 'old title', description: 'x' }] }));
    expect(result!.pick.title).toBe(FRESH_TITLE);
    expect(result!.pick.flags).not.toContain('Title repeats a skipped version');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = sentBodies()[1]!.messages;
    expect(second.at(-2)!.role).toBe('assistant');
    expect(second.at(-1)).toEqual({
      role: 'user',
      content: 'That title repeats a skipped version. Write a different title.',
    });
  });

  it('retries when only the description repeats a skipped version, hashtags aside', async () => {
    const skippedDescription = 'A bright synth track.\n\n#synthwave #retrowave #newmusic';
    fetchMock
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'New Title' }))))
      .mockResolvedValueOnce(
        reply(JSON.stringify(raw({ title: 'New Title', description: 'A darker take.' }))),
      );
    const result = await runPick(
      ctx({ skipped: [{ title: 'Old Title', description: skippedDescription }] }),
    );
    expect(result!.pick.description.startsWith('A darker take.')).toBe(true);
    expect(sentBodies()[1]!.messages.at(-1)).toEqual({
      role: 'user',
      content: 'That description repeats a skipped version. Write a different description.',
    });
  });

  it('names both fields when the title and description both repeat', async () => {
    fetchMock.mockImplementation(async () => reply(JSON.stringify(raw({ title: 'Old Title' }))));
    const skipped = [{ title: 'Old Title', description: 'A bright synth track.' }];
    expect(await runPick(ctx({ skipped }))).toBeNull();
    expect(sentBodies()[1]!.messages.at(-1)).toEqual({
      role: 'user',
      content:
        'That title and description repeat a skipped version. Write a different title and description.',
    });
  });

  it('fails the pick when the retry repeats a skipped title again', async () => {
    fetchMock.mockImplementation(async () => reply(JSON.stringify(raw({ title: 'Old Title' }))));
    expect(await runPick(ctx({ skipped: [{ title: 'Old Title', description: 'x' }] }))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when the reply never parses', async () => {
    fetchMock.mockImplementation(async () => reply('not json'));
    expect(await runPick(ctx())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when the reply parses but fails the schema', async () => {
    fetchMock.mockImplementation(async () => reply(JSON.stringify({ title: 'only a title' })));
    expect(await runPick(ctx())).toBeNull();
  });

  it('returns null when the retry after a skipped repeat never parses', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'Old Title' }))))
      .mockImplementation(async () => reply('{'));
    expect(await runPick(ctx({ skipped: [{ title: 'Old Title', description: 'x' }] }))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('propagates a llama-server error', async () => {
    fetchMock.mockImplementation(async () => new Response('overloaded', { status: 503 }));
    await expect(runPick(ctx())).rejects.toThrow('llama-server 503');
  });
});
