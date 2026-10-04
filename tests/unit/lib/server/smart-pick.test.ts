// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESCRIPTION_MAX, parseHashtags, tagsLength, TAGS_MAX, TITLE_MAX } from '$lib/metadata';
import type { Fact, Feedback } from '$lib/server/memory';
import {
  allowedLinks,
  buildPickMessages,
  digestChunks,
  finalizePick,
  isRawPick,
  measuredFlags,
  runPick,
  sameTitle,
  weighFeedback,
  type PickContext,
  type PickFixups,
  type RawPick,
} from '$lib/server/smart-pick';
import type { Chunk, Measurements } from '$lib/types';

const raw = (over: Partial<RawPick> = {}): RawPick => ({
  title: 'PeekaBoo',
  description: 'A bright synth track.',
  hashtags: ['#synthwave', '#retrowave', '#newmusic'],
  tags: ['synthwave', 'PeekaBoo'],
  flags: [],
  brandCheck: 'Matches the recent uploads.',
  why: { title: 't', description: 'd', tags: 'g' },
  ...over,
});

const candidates = ['#synthwave', '#retrowave', '#newmusic', '#electronic', '#indie', '#80s'];

const facts: Fact[] = [
  { key: 'artist-name', value: 'Flies Like Robots', kind: 'FACT', public: true },
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
  facts,
  useArtistName: true,
  measurements: null,
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
  useArtistName: true,
  chunks: [chunk(0)],
  measurements: null,
  recent: [],
  candidates,
  facts,
  feedback: [],
  skipped: [],
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
    ['a missing description', { ...raw(), description: undefined }],
    ['non-string hashtags', { ...raw(), hashtags: [1] }],
    ['tags not an array', { ...raw(), tags: 'a,b' }],
    ['flags missing', { ...raw(), flags: undefined }],
    ['brandCheck missing', { ...raw(), brandCheck: null }],
    ['why null', { ...raw(), why: null }],
    ['why a string', { ...raw(), why: 'because' }],
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
        qualityFlags: undefined,
        unparsed: undefined,
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
    expect(body.artist).toBe('Flies Like Robots');
    expect(body.artistNotes).toBe('live take');
    expect(body.candidateHashtags).toEqual(candidates);
    expect(body.ffmpeg).toEqual(measurements());
    expect(system(messages)).toContain(', the artist name');
    expect(system(messages)).not.toContain('name no artist');
  });

  it('sets artist null and forbids naming one when useArtistName is false', () => {
    const messages = buildPickMessages(ctx({ useArtistName: false }));
    expect(context(messages).artist).toBeNull();
    expect(system(messages)).toContain('Use the song title only; name no artist.');
    expect(system(messages)).not.toContain('the artist name');
    expect(JSON.stringify(messages)).not.toMatch(/"artist":"Flies Like Robots"/);
  });

  it('omits empty notes, measurements, and skipped versions', () => {
    const body = context(buildPickMessages(ctx()));
    expect(body).not.toHaveProperty('artistNotes');
    expect(body).not.toHaveProperty('ffmpeg');
    expect(body).not.toHaveProperty('skippedVersions');
  });

  it('adds the skipped instruction only when there are skipped versions', () => {
    const without = buildPickMessages(ctx());
    expect(system(without)).not.toContain('Do not repeat any skipped version');
    const skipped = [{ title: 'Old Title', description: 'old' }];
    const withSkips = buildPickMessages(ctx({ skipped }));
    expect(system(withSkips)).toContain('Do not repeat any skipped version');
    expect(context(withSkips).skippedVersions).toEqual(skipped);
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
        thumbnail: 'data:image/jpeg;base64,AAA',
      },
      {
        videoId: 'b',
        title: 'B',
        description: '',
        tags: [],
        publishedAt: 'p',
        thumbnailUrl: null,
        thumbnail: null,
      },
      {
        videoId: 'c',
        title: 'C',
        description: '',
        tags: [],
        publishedAt: 'p',
        thumbnailUrl: 'u',
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
    expect(allowedLinks('http://a.b https://c.d', [])).toBe(' ');
  });

  it('leaves text without links untouched', () => {
    expect(allowedLinks('no links here', facts)).toBe('no links here');
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

describe('sameTitle', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(sameTitle(' PeekaBoo ', 'peekaboo')).toBe(true);
    expect(sameTitle('PeekaBoo', 'PeekaBoo 2')).toBe(false);
  });
});

describe('finalizePick', () => {
  it('closes the description with the picked candidate hashtags', () => {
    const pick = finalizePick(raw(), fix());
    expect(pick.hashtags).toEqual(['#synthwave', '#retrowave', '#newmusic']);
    expect(pick.description).toBe('A bright synth track.\n\n#synthwave #retrowave #newmusic');
    expect(allInCandidates(pick.description)).toBe(true);
  });

  it('drops invented hashtags and pads to 3 from candidates', () => {
    const pick = finalizePick(raw({ hashtags: ['#madeup', '#synthwave', '#alsofake'] }), fix());
    expect(pick.hashtags).toEqual(['#synthwave', '#retrowave', '#newmusic']);
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

  it('moves candidate hashtags from the body to the closing line and removes invented ones', () => {
    const pick = finalizePick(
      raw({
        hashtags: [],
        description: 'Night drive #electronic vibes #notacandidate.\n\nMore soon #indie',
      }),
      fix(),
    );
    expect(pick.hashtags).toEqual(['#electronic', '#indie', '#synthwave']);
    expect(pick.description).toBe(
      'Night drive vibes .\n\nMore soon\n\n#electronic #indie #synthwave',
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
    const pick = finalizePick(raw({ hashtags: [] }), fix({ candidates: ['#synthwave'] }));
    expect(pick.hashtags).toEqual(['#synthwave']);
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
      raw({ hashtags: ['synthwave', '#synthwave'], description: 'Body #synthwave' }),
      fix(),
    );
    expect(pick.hashtags).toEqual(['#synthwave', '#retrowave', '#newmusic']);
  });

  it('never lets angle-bracket stripping create a stray hashtag', () => {
    const pick = finalizePick(raw({ description: 'Out now #<invented>' }), fix());
    expect(allInCandidates(pick.description)).toBe(true);
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

  it('removes plain-term tags #, dedupes case-insensitively, and drops empties', () => {
    const pick = finalizePick(
      raw({
        tags: [
          '#synthwave',
          '##Retro',
          'Synthwave',
          'retro',
          '  ',
          'PeekaBoo',
          'Flies Like Robots',
        ],
      }),
      fix(),
    );
    expect(pick.tags).toEqual(['synthwave', 'Retro', 'PeekaBoo', 'Flies Like Robots']);
    expect(pick.tags.some((t) => t.startsWith('#'))).toBe(false);
  });

  it('keeps tags within 500 characters by YouTube counting', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `tag number ${i}`);
    const pick = finalizePick(raw({ tags }), fix());
    expect(tagsLength(pick.tags)).toBeLessThanOrEqual(TAGS_MAX);
    expect(pick.tags.length).toBeGreaterThan(10);
    expect(pick.tags.length).toBeLessThan(tags.length);
    expect(pick.tags[0]).toBe('tag number 0');
  });

  it('skips one oversize tag but keeps later ones that fit', () => {
    const pick = finalizePick(raw({ tags: ['a', 'x'.repeat(600), 'b'] }), fix());
    expect(pick.tags).toEqual(['a', 'b']);
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
      }),
      fix({ measurements: measurements({ truePeakDbtp: -0.3 }) }),
    );
    expect(pick.title).toBe('PeekaBoo at');
    expect(pick.description).not.toMatch(/LUFS|dBTP|bpm|-9|-0\.5|120/);
    expect(pick.brandCheck).not.toMatch(/\d\s?dB/);
    expect(pick.why.title).not.toContain('LUFS');
    expect(pick.flags).toEqual(['True peak -0.3 dBTP, above the -1 dBTP ceiling', 'Too loud at']);
  });

  it('removes the FLR name everywhere when useArtistName is false', () => {
    const pick = finalizePick(
      raw({
        title: 'PeekaBoo - Flies Like Robots',
        description: 'New from FLR. Flies  like robots fans rejoice.',
        tags: ['Flies Like Robots', 'FLR', 'PeekaBoo', 'flr synthwave'],
      }),
      fix({ useArtistName: false }),
    );
    expect(pick.title).toBe('PeekaBoo');
    expect(pick.description).not.toMatch(/flies\s+like\s+robots|\bflr\b/i);
    expect(pick.tags).toEqual(['PeekaBoo', 'synthwave']);
  });

  it('keeps the FLR name when useArtistName is true', () => {
    const pick = finalizePick(
      raw({ title: 'PeekaBoo - Flies Like Robots', tags: ['Flies Like Robots'] }),
      fix(),
    );
    expect(pick.title).toBe('PeekaBoo - Flies Like Robots');
    expect(pick.tags).toEqual(['Flies Like Robots']);
  });

  it('leaves only the song title when the artist leads the title', () => {
    const pick = finalizePick(
      raw({ title: 'Flies Like Robots - PeekaBoo' }),
      fix({ useArtistName: false }),
    );
    expect(pick.title).toBe('PeekaBoo');
  });

  it('keeps paragraph breaks when dropping the artist from a description', () => {
    const pick = finalizePick(
      raw({ description: 'First line by Flies Like Robots.\n\nSecond paragraph.' }),
      fix({ useArtistName: false }),
    );
    expect(pick.description).toMatch(/^First line by\.\n\nSecond paragraph\.\n\n#/);
  });

  it('titles signed-out own-video picks by the song alone', () => {
    const pick = finalizePick(
      raw({ title: 'PeekaBoo - Flies Like Robots (Official Music Video)' }),
      fix({ useArtistName: false, songTitle: 'PeekaBoo' }),
    );
    expect(pick.title).toBe('PeekaBoo');
  });

  it('scrubs the artist from flags, brand check, and reasons when the name is off', () => {
    const pick = finalizePick(
      raw({
        flags: ['Flies Like Robots logo flickers'],
        brandCheck: 'Matches Flies Like Robots uploads.',
        why: { title: 'FLR style', description: 'Flies Like Robots tone', tags: 'by FLR' },
      }),
      fix({ useArtistName: false }),
    );
    expect(JSON.stringify([pick.flags, pick.brandCheck, pick.why])).not.toMatch(
      /flies like robots|flr/i,
    );
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
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(body!.temperature).toBe(0.2);
    expect(body!.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(body!.response_format.type).toBe('json_schema');
    expect(body!.response_format.json_schema.name).toBe('smart_pick');
  });

  it('retries once when the title repeats a skipped version and keeps the new title', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'Old Title' }))))
      .mockResolvedValueOnce(reply(JSON.stringify(raw({ title: 'Fresh Title' }))));
    const result = await runPick(ctx({ skipped: [{ title: 'old title', description: 'x' }] }));
    expect(result!.pick.title).toBe('Fresh Title');
    expect(result!.pick.flags).not.toContain('Title repeats a skipped version');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = sentBodies()[1]!.messages;
    expect(second.at(-2)!.role).toBe('assistant');
    expect(second.at(-1)).toEqual({
      role: 'user',
      content: '"Old Title" was already skipped. Write a different title.',
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
