// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESCRIPTION_MAX, parseHashtags, tagsLength, TAGS_MAX, TITLE_MAX } from '#lib/metadata.js';
import type { Fact, Feedback } from '#lib/server/artist/memory.js';
import {
  allowedLinks,
  ARTIST_VOICE,
  buildPickRequest,
  CREDIT_LINE,
  digestChunks,
  finalizePick,
  GENERIC_VOICE,
  isRawPick,
  measuredFlags,
  shortFlag,
  runPick,
  PICK_SCHEMA,
  windowFlags,
  sameText,
  weighFeedback,
  type PickArtist,
  type PickContext,
  type PickFixups,
  type RawPick,
} from '#lib/server/ai/smart-pick.js';
import type { Chunk, Measurements, Probe } from '#lib/types.js';
import type { CandidateList } from '#lib/server/pipeline/hashtags.js';
import type { AgentSpan, Part } from '#lib/server/core/tracing.js';
import { stepDeadline } from '#lib/server/ai/model.js';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import { span } from '../../../../mocks/sentry';
import { interaction, unavailable503 } from '../../../../helpers/gemini';
import { omit } from '../../../../helpers/omit';

const SYNTHWAVE = '#synthwave';
const RETROWAVE_TAG = '#retrowave';
const ARTIST = 'Flies Like Robots';
const CONTACT = 'Contact at flieslikerobots@gmail.com.';
const FLR: PickArtist = { name: ARTIST, contactLine: CONTACT, curated: true };
const OTHER: PickArtist = {
  name: 'Test Artist',
  contactLine: 'Booking: test@example.com',
  curated: false,
};
const FRESH_TITLE = 'Fresh Title';

const raw = (over: Partial<RawPick> = {}): RawPick => ({
  title: 'PeekaBoo',
  description: 'A bright synth track.',
  hashtags: [SYNTHWAVE, RETROWAVE_TAG, '#newmusic'],
  tags: ['synthwave', 'PeekaBoo'],
  brandCheck: 'Matches the recent uploads.',
  why: { title: 't', description: 'd', tags: 'g' },
  bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
  ...over,
});

const candidates = [SYNTHWAVE, RETROWAVE_TAG, '#newmusic', '#electronic', '#indie', '#80s'];
const tagNames = ['synthwave', 'retrowave', 'synthpop', 'new music', '80s', 'outrun'];
const cands = (...tags: string[]) => tags.map((tag) => ({ tag }));
const tagCandidates = cands(...tagNames);
const source = (over: Partial<CandidateList> = {}): CandidateList => ({
  videoId: 'reference-one',
  title: 'Reference one',
  hashtags: candidates,
  tags: tagCandidates,
  ...over,
});
const candidateLists = [source()];

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
  artist: FLR,
  songTitle: 'PeekaBoo',
  chunks: [],
  candidateLists,
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
  artist: FLR,
  songTitle: 'PeekaBoo',
  notes: '',
  chunks: [chunk(0)],
  measurements: null,
  probe: null,
  recent: [],
  candidateLists,
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
    expect(isRawPick(raw({ hashtags: [], tags: [] }))).toBe(true);
  });

  it('does not ask the model for flags', () => {
    expect(PICK_SCHEMA.required).not.toContain('flags');
    expect(PICK_SCHEMA.properties).not.toHaveProperty('flags');
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

describe('buildPickRequest', () => {
  it("writes the description in the artist's own voice on runs that may name him", () => {
    const rules = system(buildPickRequest(ctx()));
    expect(rules).toContain(ARTIST_VOICE);
    expect(rules).toContain(CREDIT_LINE);
    expect(rules).not.toContain(GENERIC_VOICE);
    expect(rules).toContain('hacked and slashed');
    expect(rules).toContain('Never copy them word for word, except the credit line.');
    expect(rules).toContain('never on its own line');
    expect(rules).toContain('Never claim what the lyrics say.');
    expect(rules).toContain("bandcamp.about: the same song for Bandcamp's About field");
    expect(rules).toContain(
      'bandcamp.credits: the credit line from the description, exactly as written there.',
    );
    expect(rules).toContain('Write no contact line, in the description or anywhere else.');
    expect(rules).toContain("Keep the artist's slang");
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

  type Request = ReturnType<typeof buildPickRequest>;
  const userParts = (request: Request): Part[] => request.turns[0]!.parts;
  type TextPart = Extract<Part, { type: 'text' }>;
  /** The job context and the YouTube parts, merged into one object. */
  const context = (request: Request) =>
    Object.assign(
      {},
      ...userParts(request)
        .filter((part, i): part is TextPart => part.type === 'text' && (i === 0 || !!part.source))
        .map((part) => JSON.parse(part.text) as object),
    ) as Record<string, unknown>;
  const system = (request: Request) => request.system;

  it('keeps each reference list labeled without pooled terms or frequency fields', () => {
    const lists = [
      source({ tags: [{ tag: 'synthwave', usedBy: 99 } as { tag: string }] }),
      source({
        videoId: 'reference-two',
        title: 'Reference two',
        tags: cands('synthwave', 'outrun'),
      }),
    ];
    const body = context(buildPickRequest(ctx({ candidateLists: lists })));

    expect(body.candidateLists).toEqual([source({ tags: cands('synthwave') }), lists[1]]);
    expect(body).not.toHaveProperty('candidateHashtags');
    expect(body).not.toHaveProperty('candidateTags');
    expect(JSON.stringify(body)).not.toMatch(/usedBy|views|score|weight/);
  });

  it('names the profile artist', () => {
    const messages = buildPickRequest(ctx({ notes: 'live take', measurements: measurements() }));
    expect(messages.turns.map((t) => t.role)).toEqual(['user']);
    const body = context(messages);
    expect(body.artist).toBe(ARTIST);
    expect(body.artistNotes).toBe('live take');
    expect(body.candidateLists).toEqual(candidateLists);
    expect(body).not.toHaveProperty('candidateHashtags');
    expect(body).not.toHaveProperty('candidateTags');
    expect(body.ffmpeg).toEqual(measurements());
    expect(system(messages)).toContain("recentUploads are the artist's own uploads");
    expect(system(messages)).toContain('credit lines');
  });

  it("names another artist's profile and asks for its tag, in the generic voice", () => {
    const messages = buildPickRequest(ctx({ artist: OTHER }));
    expect(context(messages).artist).toBe('Test Artist');
    const rules = system(messages);
    expect(rules).toContain('Include "Test Artist".');
    expect(rules).toContain(GENERIC_VOICE);
    expect(rules).not.toContain(ARTIST_VOICE);
    expect(rules).not.toContain(CREDIT_LINE);
    expect(rules).toContain('Write no credit line.');
    expect(rules).toContain('Write no contact line, in the description or anywhere else.');
    expect(rules).toContain('bandcamp.credits: an empty string.');
    expect(rules).not.toContain(ARTIST);
    expect(rules).not.toContain('hacked and slashed');
  });

  it.each([
    ['the curated profile', FLR],
    ['another profile', OTHER],
  ])('never sends the contact line to the model for %s', (_label, artist) => {
    const sent = JSON.stringify(buildPickRequest(ctx({ artist })));
    expect(sent).not.toContain(artist.contactLine!);
    expect(sent).not.toContain('@example.com');
    expect(sent).not.toContain('flieslikerobots@');
  });

  it('keeps identity and humor out of the voices', () => {
    for (const voice of [ARTIST_VOICE, GENERIC_VOICE]) {
      expect(voice).not.toContain('flieslikerobots@');
      expect(voice).not.toContain('hacked and slashed');
    }
    expect(GENERIC_VOICE).not.toMatch(/humor|hehe|caps/i);
  });

  it('sends every YouTube-derived list in a tagged part with its count', () => {
    const audience = [{ title: 'Top hit', description: 'Credits.', tags: ['outrun'], views: 9 }];
    const parts = userParts(buildPickRequest(ctx({ audience })));
    expect(parts[0]).not.toHaveProperty('source');
    expect(JSON.parse((parts[0] as TextPart).text)).not.toHaveProperty('candidateLists');
    const youtube = parts.filter((part): part is TextPart => part.type === 'text' && !!part.source);
    expect(youtube.map((part) => [Object.keys(JSON.parse(part.text)), part.count])).toEqual([
      [['recentUploads'], 0],
      [['audienceTopVideos'], 1],
      [['candidateLists'], 1],
    ]);
    expect(youtube.every((part) => part.source === 'youtube')).toBe(true);
  });

  it('grounds title, description, and tags in the genre search', () => {
    const audience = [{ title: 'Top hit', description: 'Credits.', tags: ['outrun'], views: 9000 }];
    const messages = buildPickRequest(ctx({ audience }));
    const body = context(messages);
    expect(body.audienceTopVideos).toEqual([
      { title: 'Top hit', description: 'Credits.', tags: ['outrun'] },
    ]);
    expect(JSON.stringify(body)).not.toContain('9000');
    expect(JSON.stringify(body)).not.toContain('views');
    expect(system(messages)).toContain('genre search examples');
    expect(system(messages)).toContain(
      'Do not claim these choices caused audience reach or success',
    );
    expect(system(messages)).not.toContain('usedBy');
    expect(system(messages)).toContain(
      'do not pool, count, rank, or infer popularity from repeated terms',
    );
    expect(system(messages)).toContain('copied exactly from a candidateLists tags entry');
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
    const uploads = context(buildPickRequest(ctx({ recent }))).recentUploads as object[];
    expect(uploads).toEqual([
      { title: 'A', description: 'Written and performed by Nathan.', publishedAt: 'p' },
    ]);
  });

  it('omits empty notes, measurements, and skipped versions', () => {
    const body = context(buildPickRequest(ctx()));
    expect(body).not.toHaveProperty('artistNotes');
    expect(body).not.toHaveProperty('ffmpeg');
    expect(body).not.toHaveProperty('skippedVersions');
  });

  it('adds the skipped instruction only when there are skipped versions', () => {
    const without = buildPickRequest(ctx());
    expect(system(without)).not.toContain('skippedVersions were rejected');
    const skipped = [{ title: 'Old Title', description: 'old' }];
    const withSkips = buildPickRequest(ctx({ skipped }));
    expect(system(withSkips)).toContain(
      'skippedVersions were rejected. Write a different title and a different description',
    );
    expect(context(withSkips).skippedVersions).toEqual(skipped);
  });

  it('sends an approved brand guide and checks the proposal against it', () => {
    const brand = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: ['Emoji'] };
    const messages = buildPickRequest(ctx({ brand }));
    expect(context(messages).brandGuide).toEqual(brand);
    expect(system(messages)).toContain('brandGuide');
  });

  it('leaves the brand guide out until one is approved', () => {
    const messages = buildPickRequest(ctx());
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
        thumbnail: { data: 'AAA', mime_type: 'image/jpeg' },
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
        thumbnail: { data: 'BBB', mime_type: 'image/png' },
      },
    ];
    const messages = buildPickRequest(ctx({ recent }));
    const parts = userParts(messages);
    expect(parts.slice(4)).toEqual([
      { type: 'text', text: 'Thumbnails of the recent uploads, newest first:' },
      { type: 'image', data: 'AAA', mime_type: 'image/jpeg' },
      { type: 'image', data: 'BBB', mime_type: 'image/png' },
    ]);
    const uploads = context(messages).recentUploads as { description: string }[];
    expect(uploads).toHaveLength(3);
    expect(uploads[0]!.description).toHaveLength(700);
  });

  it('sends only text parts when no thumbnails exist', () => {
    const parts = userParts(buildPickRequest(ctx()));
    expect(parts).toHaveLength(4);
    expect(parts.every((part) => part.type === 'text')).toBe(true);
  });

  it('keeps private facts out of the prompt and weighs feedback', () => {
    const body = context(buildPickRequest(ctx({ feedback: [feedback('SKIPPED')] })));
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
    const c = chunk(0);
    c.analysis!.qualityFlags = ['Dark opening frames'];
    const pick = finalizePick(
      raw(),
      fix({
        chunks: [c],
        probe: probe(720, 1280),
        measurements: measurements({ truePeakDbtp: -0.3 }),
      }),
    );
    expect(pick.flags).toEqual([
      'True peak -0.3 dBTP, above the -1 dBTP ceiling',
      'Vertical and 3 minutes or shorter: YouTube will publish it as a Short',
      'Dark opening frames',
    ]);
  });
});

describe('windowFlags', () => {
  const flagged = (index: number, qualityFlags: string[]) => {
    const c = chunk(index);
    c.analysis!.qualityFlags = qualityFlags;
    return c;
  };

  it('lists each window flag once, keeping the first spelling', () => {
    expect(
      windowFlags([
        flagged(0, ['Audio dropout', 'Sync drift']),
        flagged(1, ['audio  dropout', 'Frozen frame']),
      ]),
    ).toEqual(['Audio dropout', 'Sync drift', 'Frozen frame']);
  });

  it('skips blanks and windows without an analysis', () => {
    expect(windowFlags([flagged(0, ['', '  ']), chunk(1, { analysis: null })])).toEqual([]);
  });

  it('returns nothing when no window flagged a problem', () => {
    expect(windowFlags([chunk(0), chunk(1)])).toEqual([]);
  });
});

describe('pick flags', () => {
  it('ignores flags the model sends anyway, keeping only measured evidence', () => {
    const reply = { ...raw(), flags: ['Neon green text on black background'] } as RawPick;
    expect(finalizePick(reply, fix({ chunks: [chunk(0)] })).flags).toEqual([]);
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
    expect(pick.description).toBe(
      `A bright synth track.\n${CONTACT}\n\n#synthwave #retrowave #newmusic`,
    );
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
      fix({ candidateLists: [source({ hashtags: ['#SynthWave', '#indie', '#80s'] })] }),
    );
    expect(pick.hashtags).toEqual(['#SynthWave', '#indie', '#80s']);
    expect(pick.description.endsWith('#SynthWave #indie #80s')).toBe(true);
  });

  it('draws hashtags from the chosen tags first, so the description and tags agree', () => {
    const pick = finalizePick(
      raw({ tags: ['retrowave', 'new music', 'outrun'], hashtags: ['#indie', '#80s'] }),
      fix({
        candidateLists: [
          source({
            hashtags: ['#indie', '#80s', RETROWAVE_TAG, '#newmusic'],
            tags: cands('retrowave', 'new music', 'outrun'),
          }),
        ],
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
      `Night drive vibes .\n\nMore soon\n${CONTACT}\n\n#synthwave #electronic #indie`,
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
    const pick = finalizePick(
      raw({ hashtags: [] }),
      fix({ candidateLists: [source({ hashtags: [SYNTHWAVE] })] }),
    );
    expect(pick.hashtags).toEqual([SYNTHWAVE]);
    expect(pick.description).toBe(`A bright synth track.\n${CONTACT}\n\n#synthwave`);
  });

  it('leaves the description without a closing line when there are no candidates', () => {
    const pick = finalizePick(
      raw({ description: 'Body #synthwave' }),
      fix({ candidateLists: [source({ hashtags: [] })] }),
    );
    expect(pick.hashtags).toEqual([]);
    expect(pick.description).toBe(`Body\n${CONTACT}`);
    expect(parseHashtags(pick.description)).toEqual([]);
  });

  it('returns only the hashtags when the body is empty and there is no contact line', () => {
    const pick = finalizePick(
      raw({ description: '' }),
      fix({ artist: { ...FLR, contactLine: null } }),
    );
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
  it('accepts terms from separate references and rejects terms absent from every list', () => {
    const pick = finalizePick(
      raw({
        tags: ['synthwave', 'outrun', 'invented'],
        hashtags: ['#synthwave', '#outrun', '#invented'],
      }),
      fix({
        candidateLists: [
          source({ hashtags: ['#synthwave'], tags: cands('synthwave') }),
          source({
            videoId: 'reference-two',
            title: 'Reference two',
            hashtags: ['#outrun'],
            tags: cands('outrun'),
          }),
        ],
      }),
    );

    expect(pick.tags).toEqual([ARTIST, 'synthwave', 'outrun']);
    expect(pick.hashtags).toEqual(['#synthwave', '#outrun']);
    expect(pick.description).not.toContain('#invented');
  });

  it('keeps only the artist tag when there are no reference lists', () => {
    const pick = finalizePick(raw(), fix({ candidateLists: [] }));
    expect(pick.tags).toEqual([ARTIST]);
    expect(pick.hashtags).toEqual([]);
  });

  it('cleans the Bandcamp draft like the description: fact links only, no hashtags or notes', () => {
    const pick = finalizePick(
      raw({
        bandcamp: {
          about:
            'Dark synth. #synthwave\n[No contact line found]\nStream https://flr.bandcamp.com not https://evil.example/x',
          credits: 'Written by Nathan.  #synthwave',
        },
      }),
      fix(),
    );
    expect(pick.bandcamp.about).toBe('Dark synth.\n\nStream https://flr.bandcamp.com not');
    expect(pick.bandcamp.credits).toBe(`Written by Nathan.\n${CONTACT}`);
  });

  it('strips < and > and tidies whitespace', () => {
    const pick = finalizePick(
      raw({ title: '  <Peeka>  Boo ', description: 'Line one   \n\n\n\nLine  two' }),
      fix(),
    );
    expect(pick.title).toBe('Peeka Boo');
    expect(pick.description.startsWith(`Line one\n\nLine two\n${CONTACT}\n\n`)).toBe(true);
  });

  it('keeps only candidate tags, deduped, in the model order with candidate casing', () => {
    const pick = finalizePick(
      raw({ tags: ['#Synthwave', '##RETROWAVE', 'synthwave', 'synthpop', 'invented', '  '] }),
      fix(),
    );
    expect(pick.tags).toEqual([ARTIST, 'synthwave', 'retrowave', 'synthpop']);
  });

  it('never uses the song title as a tag, even when the search returns it', () => {
    const pick = finalizePick(
      raw({ tags: ['PeekaBoo', 'peekaboo official video', 'synthwave'] }),
      fix({
        candidateLists: [
          source({ tags: cands('PeekaBoo', 'peekaboo official video', ...tagNames) }),
        ],
      }),
    );
    expect(pick.tags.some((t) => t.toLowerCase().includes('peekaboo'))).toBe(false);
    expect(pick.tags).toEqual([ARTIST, 'synthwave']);
  });

  it('rejects tags holding the title as whole words but keeps words that merely contain it', () => {
    const names = ['synthpop', 'pop music', 'Pop', 'hyperpop'];
    const pick = finalizePick(
      raw({ tags: names }),
      fix({ songTitle: 'Pop', candidateLists: [source({ tags: cands(...names) })] }),
    );
    expect(pick.tags).toEqual([ARTIST, 'synthpop', 'hyperpop']);
  });

  it('lists the artist name once even when the search returned it', () => {
    const messages = buildPickRequest(
      ctx({ candidateLists: [source({ tags: cands('synthwave', 'flies like robots') })] }),
    );
    const parts = messages.turns[0]!.parts as { text: string; source?: string }[];
    const lists = parts.find((part) => part.source && part.text.includes('candidateLists'))!;
    expect(JSON.parse(lists.text).candidateLists[0].tags).toEqual([{ tag: 'synthwave' }]);
    expect(finalizePick(raw(), fix()).tags.filter((tag) => tag === ARTIST)).toHaveLength(1);
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

  it('puts the artist tag first, wherever the model placed it', () => {
    const pick = finalizePick(raw({ tags: ['outrun', 'flies like robots'] }), fix());
    expect(pick.tags).toEqual([ARTIST, 'outrun']);
  });

  it('caps tags at 10, keeping the artist name first', () => {
    const names = Array.from({ length: 14 }, (_, i) => `genre ${i}`);
    const pick = finalizePick(
      raw({ tags: names }),
      fix({ candidateLists: [source({ tags: cands(...names) })] }),
    );
    expect(pick.tags).toEqual([ARTIST, ...names.slice(0, 9)]);
  });

  it('falls back to the artist name alone when the search found no tags', () => {
    const pick = finalizePick(
      raw({ tags: ['synthwave'] }),
      fix({ candidateLists: [source({ tags: [] })] }),
    );
    expect(pick.tags).toEqual([ARTIST]);
  });

  it("tags another artist's pick with its own profile name, spelled as the profile has it", () => {
    const pick = finalizePick(
      raw({ tags: ['test artist', 'synthwave'] }),
      fix({ artist: OTHER, candidateLists: [source({ tags: cands('synthwave', 'TEST ARTIST') })] }),
    );
    expect(pick.tags).toEqual(['Test Artist', 'synthwave']);
    expect(pick.artistName).toBe('Test Artist');
  });

  it('stores the profile name the pick used', () => {
    expect(finalizePick(raw(), fix()).artistName).toBe(ARTIST);
  });

  it('keeps tags within 500 characters by YouTube counting', () => {
    const names = Array.from({ length: 10 }, (_, i) => `tag number ${i} ${'x'.repeat(45)}`);
    const pick = finalizePick(
      raw({ tags: names }),
      fix({ candidateLists: [source({ tags: cands(...names) })] }),
    );
    expect(tagsLength(pick.tags)).toBeLessThanOrEqual(TAGS_MAX);
    expect(pick.tags.length).toBeGreaterThan(5);
    expect(pick.tags.length).toBeLessThan(names.length);
    expect(pick.tags.slice(0, 2)).toEqual([ARTIST, names[0]]);
  });

  it('skips one oversize tag but keeps later ones that fit', () => {
    const pool = ['a', 'x'.repeat(600), 'b'];
    const pick = finalizePick(
      raw({ tags: pool }),
      fix({ candidateLists: [source({ tags: cands(...pool) })] }),
    );
    expect(pick.tags).toEqual([ARTIST, 'a', 'b']);
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
    expect(pick.flags).toEqual(['True peak -0.3 dBTP, above the -1 dBTP ceiling']);
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
      raw({ bandcamp: { about: `Listen ${link}`, credits: '' } }),
      fix({ facts: [{ key: 'bc', value: link, kind: 'FACT', public: true }] }),
    );
    expect(pick.bandcamp.about).toBe(`Listen ${link}`);
  });

  it('passes brandCheck and why through', () => {
    const pick = finalizePick(raw(), fix());
    expect(pick.brandCheck).toBe('Matches the recent uploads.');
    expect(pick.why).toEqual({ title: 't', description: 'd', tags: 'g' });
  });
});

describe('finalizePick: the contact line', () => {
  it.each([
    ['an email', 'Write to me at old@example.org'],
    ['a phone number', 'Call +1 (555) 010-2030'],
    ['a URL', 'More at https://old.example/page'],
    ['a www link', 'See www.old.example'],
    ['an @handle', 'Follow @oldhandle'],
    ['a contact label', 'Bookings: ask around'],
    ['a dm label', 'DMs open'],
  ])('drops a model line with %s from the description and credits', (_label, line) => {
    const pick = finalizePick(
      raw({
        description: `A bright synth track.\n${line}`,
        bandcamp: { about: '', credits: `Written by Nathan.\n${line}` },
      }),
      fix(),
    );
    expect(pick.description).not.toContain(line);
    expect(pick.bandcamp.credits).toBe(`Written by Nathan.\n${CONTACT}`);
  });

  it.each([
    ['the shortest email', 'Write a@b.c', false],
    ['an @ with no domain dot', 'Ping user@host', true],
    ['a trailing domain dot', 'Ping user@host.', true],
  ])('treats %s by the email shape', (_label, line, kept) => {
    const pick = finalizePick(raw({ description: `Body\n${line}` }), fix());
    expect(pick.description.includes(line)).toBe(kept);
  });

  it('keeps prose, the credit line, short numbers and an email-less @ alone', () => {
    const description = [
      'Written, performed, recorded, hacked and slashed by Flies Like Robots',
      'Track 3 of 12, recorded in 2024.',
      'Contacts of the third kind is a movie I like.',
    ].join('\n');
    const pick = finalizePick(raw({ description }), fix());
    expect(pick.description).toContain(description.split('\n').slice(0, 2).join('\n'));
    // "Contacts" is not the label "contact".
    expect(pick.description).toContain('Contacts of the third kind');
  });

  it("closes the body with the profile's contact line exactly, before the hashtags", () => {
    const pick = finalizePick(raw({ description: `Body\n${CONTACT}` }), fix());
    expect(pick.description).toBe(`Body\n${CONTACT}\n\n#synthwave #retrowave #newmusic`);
    expect(pick.description.split(CONTACT)).toHaveLength(2);
  });

  it("places another profile's contact line, links and all, untouched", () => {
    const contactLine = 'Booking: test@example.com https://test-artist.example';
    const pick = finalizePick(
      raw({ bandcamp: { about: 'About.', credits: '' } }),
      fix({ artist: { ...OTHER, contactLine } }),
    );
    expect(pick.description).toContain(`\n${contactLine}\n\n#synthwave`);
    expect(pick.bandcamp.credits).toBe(contactLine);
    expect(pick.bandcamp.about).toBe('About.');
  });

  it('appends nothing when the profile has no contact line', () => {
    const pick = finalizePick(
      raw({ description: 'Body\nmail me at a@b.co', bandcamp: { about: '', credits: '' } }),
      fix({ artist: { ...FLR, contactLine: null } }),
    );
    expect(pick.description).toBe('Body\n\n#synthwave #retrowave #newmusic');
    expect(pick.bandcamp.credits).toBe('');
  });

  it('never cuts the contact line when the body runs long', () => {
    const pick = finalizePick(raw({ description: 'lorem ipsum '.repeat(700) }), fix());
    expect(pick.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(pick.description).toContain(`\n${CONTACT}\n\n#synthwave`);
    const credits = finalizePick(
      raw({ bandcamp: { about: '', credits: 'word '.repeat(1200) } }),
      fix(),
    ).bandcamp.credits;
    expect(credits.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(credits.endsWith(`\n${CONTACT}`)).toBe(true);
  });
});

describe('runPick', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const reply = (text: string) => interaction(text);
  type Turn = { type: string; content: { type: string; text?: string }[] };
  const sentBodies = () =>
    fetchMock.mock.calls.map(
      ([, init]) =>
        JSON.parse(String((init as RequestInit).body)) as {
          model: string;
          input: Turn[];
          store: boolean;
          response_format: unknown;
          generation_config: { max_output_tokens: number; thinking_level: string };
        },
    );
  const lastTurns = (call: number) => sentBodies()[call]!.input.slice(-2);
  const userText = (text: string) => ({ type: 'user_input', content: [{ type: 'text', text }] });

  beforeEach(() => {
    clearAgentSpan();
    fetchMock.mockReset();
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('records the first request and the finalized pick on the agent span', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'Old Title' }))))
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: FRESH_TITLE }))));
    const result = await runPick(
      ctx({ skipped: [{ title: 'Old Title', description: 'x' }] }),
      stepDeadline(),
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
    expect(await runPick(ctx(), stepDeadline(), span as unknown as AgentSpan)).toBeNull();
    expect(agentSpanIO().input).toHaveLength(1);
    expect(agentSpanIO().output).toEqual([]);
  });

  it('returns the finalized pick from one call to the pick model', async () => {
    fetchMock.mockResolvedValueOnce(reply(JSON.stringify(raw())));
    const result = await runPick(ctx(), stepDeadline());
    expect(result).not.toBeNull();
    expect(result!.pick.title).toBe('PeekaBoo');
    expect(allInCandidates(result!.pick.description)).toBe(true);
    expect(result!.ms).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/v1beta\/interactions$/);
    const [body] = sentBodies();
    expect(body!.model).toBe('gemini-4-argon');
    expect(body!.store).toBe(false);
    expect(body!.generation_config).toMatchObject({
      max_output_tokens: 8192,
      thinking_level: 'medium',
    });
    expect(JSON.stringify(body!.response_format)).toContain(JSON.stringify(PICK_SCHEMA));
  });

  it('sends thumbnails inline as image parts', async () => {
    fetchMock.mockResolvedValueOnce(reply(JSON.stringify(raw())));
    const recent = [
      {
        videoId: 'a',
        title: 'A',
        description: '',
        tags: [],
        publishedAt: 'p',
        thumbnailUrl: 'u',
        views: 0,
        durationSec: 0,
        thumbnail: { data: 'AAA', mime_type: 'image/jpeg' },
      },
    ];
    await runPick(ctx({ recent }), stepDeadline());
    const content = sentBodies()[0]!.input[0]!.content;
    expect(content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(content[0]!.text).toContain('Thumbnails of the recent uploads, newest first:');
    expect(content[1]).toMatchObject({ data: 'AAA', mime_type: 'image/jpeg' });
  });

  it('retries once when the title repeats a skipped version and keeps the new title', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'Old Title' }))))
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: FRESH_TITLE }))));
    const result = await runPick(
      ctx({ skipped: [{ title: 'old title', description: 'x' }] }),
      stepDeadline(),
    );
    expect(result!.pick.title).toBe(FRESH_TITLE);
    expect(result!.pick.flags).not.toContain('Title repeats a skipped version');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [assistant, user] = lastTurns(1);
    expect(assistant!.type).toBe('model_output');
    expect(user).toEqual(
      userText('That title repeats a skipped version. Write a different title.'),
    );
  });

  it('retries when only the description repeats a skipped version, hashtags aside', async () => {
    const skippedDescription = `A bright synth track.\n${CONTACT}\n\n#synthwave #retrowave #newmusic`;
    fetchMock
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'New Title' }))))
      .mockResolvedValueOnce(
        reply(JSON.stringify(raw({ title: 'New Title', description: 'A darker take.' }))),
      );
    const result = await runPick(
      ctx({ skipped: [{ title: 'Old Title', description: skippedDescription }] }),
      stepDeadline(),
    );
    expect(result!.pick.description.startsWith('A darker take.')).toBe(true);
    expect(lastTurns(1)[1]).toEqual(
      userText('That description repeats a skipped version. Write a different description.'),
    );
  });

  it('names both fields when the title and description both repeat', async () => {
    fetchMock.mockImplementation(async () => reply(JSON.stringify(raw({ title: 'Old Title' }))));
    const skipped = [{ title: 'Old Title', description: `A bright synth track.\n${CONTACT}` }];
    expect(await runPick(ctx({ skipped }), stepDeadline())).toBeNull();
    expect(lastTurns(1)[1]).toEqual(
      userText(
        'That title and description repeat a skipped version. Write a different title and description.',
      ),
    );
  });

  it('fails the pick when the retry repeats a skipped title again', async () => {
    fetchMock.mockImplementation(async () => reply(JSON.stringify(raw({ title: 'Old Title' }))));
    expect(
      await runPick(ctx({ skipped: [{ title: 'Old Title', description: 'x' }] }), stepDeadline()),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when the reply never parses', async () => {
    fetchMock.mockImplementation(async () => reply('not json'));
    expect(await runPick(ctx(), stepDeadline())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when the reply parses but fails the schema', async () => {
    fetchMock.mockImplementation(async () => reply(JSON.stringify({ title: 'only a title' })));
    expect(await runPick(ctx(), stepDeadline())).toBeNull();
  });

  it('returns null when the retry after a skipped repeat never parses', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'Old Title' }))))
      .mockImplementation(async () => reply('{'));
    expect(
      await runPick(ctx({ skipped: [{ title: 'Old Title', description: 'x' }] }), stepDeadline()),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails the step when no time is left to re-ask a repeated title', async () => {
    const now = Date.now();
    fetchMock.mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'Old Title' }))));
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 80_000);
    await expect(
      runPick(ctx({ skipped: [{ title: 'Old Title', description: 'x' }] }), now + 110_000),
    ).rejects.toThrow('ran out of time');
    vi.restoreAllMocks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('starts no call once the deadline is too close', async () => {
    await expect(runPick(ctx(), Date.now() + 1_000)).rejects.toThrow('ran out of time');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a Gemini error', async () => {
    fetchMock.mockImplementation(async () => unavailable503());
    await expect(runPick(ctx(), stepDeadline())).rejects.toThrow('Gemini 503');
  });
});
