// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INFLUENCE, type Influence } from '#lib/influence.js';
import type { Fact } from '#lib/server/artist/memory.js';
import { stepDeadline } from '#lib/server/ai/model.js';
import {
  buildPickRequest,
  CopiedWording,
  finalizePick,
  INFLUENCE_WARNING,
  runPick,
  type PickContext,
  type RawPick,
} from '#lib/server/ai/smart-pick.js';
import type { Part } from '#lib/server/core/tracing.js';
import type { CandidateList } from '#lib/server/pipeline/hashtags.js';
import { releaseList } from '#lib/server/pipeline/hashtags.js';
import type { PickOutcome } from '#lib/server/research/outcomes.js';
import { COPIED, evidence, PEER_TITLE } from '../../../../helpers/evidence';
import { interaction } from '../../../../helpers/gemini';
import { startSpan } from '../../../../mocks/sentry';

const ARTIST = { name: 'Test Artist', contactLine: null };
const facts: Fact[] = [{ key: 'artist-name', value: 'Test Artist', kind: 'FACT', public: true }];
const genre: CandidateList = {
  source: 'genre',
  ref: 'G1',
  videoId: 'genre-one',
  title: 'Genre one',
  hashtags: ['#synthwave', '#retrowave', '#newmusic'],
  tags: ['synthwave', 'retrowave', 'outrun', 'darkwave', 'synthpop'].map((tag) => ({ tag })),
};
const peered = evidence();

const raw = (over: Partial<RawPick> = {}): RawPick => ({
  title: 'PeekaBoo',
  description: 'A bright synth track.',
  hashtags: ['#synthwave', '#retrowave', '#newmusic'],
  tags: ['synthwave', 'retrowave'],
  brandCheck: 'Matches the recent uploads.',
  why: { title: 't', description: 'd', tags: 'g' },
  bandcamp: { about: 'Bandcamp about.', credits: '' },
  citations: {
    sound: ['analysis', 'P1'],
    feel: ['voice'],
    wording: ['voice'],
    discovery: ['P1-R1', 'G1'],
    structure: ['P1-R1', 'identity'],
  },
  recommendation: {
    approach: 'Open on the hook.',
    intendedOutcome: 'More listeners reach the end.',
    follows: 'peers',
    followsWhy: 'Next-range artists open that way.',
    evidence: ['P1', 'P1-R1'],
  },
  ...over,
});

const ctx = (over: Partial<PickContext> = {}): PickContext => ({
  artist: ARTIST,
  songTitle: 'PeekaBoo',
  notes: '',
  chunks: [],
  measurements: null,
  probe: null,
  recent: [],
  candidateLists: [genre, ...peered.releases.map(releaseList)],
  audience: [{ title: 'Genre top', description: 'Top copy.', tags: ['synthwave'], views: 9 }],
  facts,
  feedback: [],
  skipped: [],
  voice: null,
  brand: null,
  influence: DEFAULT_INFLUENCE,
  evidence: peered,
  outcomes: [],
  limits: [],
  ...over,
});

const outcome = (over: Partial<PickOutcome> = {}): PickOutcome => ({
  ref: 'A1',
  videoId: 'own-1',
  suggested: { approach: 'Open on the hook.', intendedOutcome: 'More listeners stay.' },
  published: { title: 'My title', description: 'My description', hashtags: [], tags: ['mine'] },
  editedBeforeApproval: true,
  differsFromApproved: false,
  coverage: 'unknown',
  window: { start: '2026-09-01', end: '2026-09-28' },
  metrics: { views: 900, subscribersGained: 12, subscribersLost: null },
  net: { value: null, calculated: true },
  live: { title: 'My title', description: 'My description', tags: ['mine'] },
  ...over,
});

const parts = (request: ReturnType<typeof buildPickRequest>): Extract<Part, { type: 'text' }>[] =>
  request.turns[0]!.parts.filter(
    (part): part is Extract<Part, { type: 'text' }> => part.type === 'text',
  );
const youtube = (request: ReturnType<typeof buildPickRequest>, key: string) => {
  const part = parts(request).find((p) => p.source === 'youtube' && p.text.includes(`"${key}"`));
  return part ? (JSON.parse(part.text) as Record<string, Record<string, unknown>>) : undefined;
};
const appText = (request: ReturnType<typeof buildPickRequest>) =>
  JSON.parse(parts(request)[0]!.text) as Record<string, unknown>;

describe('buildPickRequest: peers and releases', () => {
  const request = buildPickRequest(ctx());

  it('names peers only by ref, with no channel ID or title anywhere in the request', () => {
    const sent = JSON.stringify(request);
    expect(sent).not.toContain('UC-peer');
    expect(sent).not.toContain(PEER_TITLE);
    expect(Object.keys(youtube(request, 'similarArtists')!.similarArtists!)).toEqual([
      'P1',
      'P2',
      'P3',
    ]);
  });

  it('labels reported statistics and calculated values, in YouTube-tagged parts', () => {
    const peers = youtube(request, 'similarArtists')!.similarArtists!;
    expect(peers.P1).toMatchObject({
      publicReachReportedByYouTube: { subscribers: 1200, videos: 40, views: 90_000 },
    });
    const releases = youtube(request, 'peerReleases')!.peerReleases!;
    expect(releases['P1-R1']).toMatchObject({
      publicReachReportedByYouTube: { views: 1000, likes: 50, comments: 50 },
      engagementRate: { value: 0.1, calculated: true },
    });
    const tagged = parts(request).filter((p) => p.source === 'youtube');
    expect(tagged.map((p) => p.label)).toEqual(
      expect.arrayContaining(['YouTube peers', 'YouTube releases']),
    );
  });

  it('keeps our own labels out of the YouTube parts, so a reply keeps its words', () => {
    expect(appText(request).peerLabels).toEqual({
      similarArtists: {
        P1: { relation: 'next', basis: 'heard', secondary: false },
        P2: { relation: 'same', basis: 'heard', secondary: false },
        P3: { relation: 'two-up', basis: 'metadata-only', secondary: true },
      },
      peerReleases: {
        'P1-R1': { selectedAs: 'newest' },
        'P2-R1': { selectedAs: 'newest' },
        'P3-R1': { selectedAs: 'newest' },
      },
    });
  });

  it('shows hidden subscribers as hidden', () => {
    const hidden = evidence();
    hidden.peers[0]!.stats = { subscribers: null, hidden: true, videos: 1, views: 2 };
    const peers = youtube(
      buildPickRequest(ctx({ evidence: hidden })),
      'similarArtists',
    )!.similarArtists!;
    expect(peers.P1).toMatchObject({ publicReachReportedByYouTube: { subscribers: 'hidden' } });
  });

  it('lists each release as its own candidate list under its ref, never merged', () => {
    const lists = youtube(request, 'candidateLists')!.candidateLists!;
    expect(Object.keys(lists)).toEqual(['G1', 'P1-R1', 'P2-R1', 'P3-R1']);
    expect(lists['P1-R1']).toMatchObject({ hashtags: ['#peer1'] });
  });

  it('replaces the genre examples with peer releases, and keeps them without peers', () => {
    expect(youtube(request, 'audienceTopVideos')).toBeUndefined();
    expect(request.system).toContain('peerReleases are other artists');
    const alone = buildPickRequest(ctx({ evidence: null, candidateLists: [genre] }));
    expect(youtube(alone, 'audienceTopVideos')).toBeDefined();
    expect(youtube(alone, 'similarArtists')).toBeUndefined();
    expect(alone.system).toContain('No similar-artist evidence is available');
  });

  it('forbids numbers about reach and peer names in the prompt rules', () => {
    expect(request.system).toContain(
      'Never write a number about views, subscribers, likes, comments or engagement',
    );
    expect(request.system).toContain('only by ref, never by name');
  });
});

describe('buildPickRequest: the sliders', () => {
  const rules = (influence: Influence) => buildPickRequest(ctx({ influence })).system;
  const at = (level: 0 | 1 | 2 | 3 | 4): Influence => ({
    sound: level,
    feel: level,
    wording: level,
    discovery: level,
    structure: level,
  });

  it.each([
    [0, 'cite no similar artist'],
    [2, 'about evenly'],
    [4, 'follow similar artists’ sources most strongly'],
  ] as const)('writes level %i for every role', (level, text) => {
    const system = rules(at(level));
    for (const role of ['sound', 'feel', 'wording', 'discovery', 'structure']) {
      expect(system).toContain(`- ${role} (level ${level} of 4): `);
    }
    expect(system).toContain(text);
  });

  it('asks for two different artists at the top level of feel and wording only', () => {
    const system = rules(at(4));
    const lines = system.split('\n');
    const line = (role: string) => lines.find((l) => l.startsWith(`- ${role} `))!;
    expect(line('wording')).toContain('at least two different similar artists');
    expect(line('feel')).toContain('at least two different similar artists');
    expect(line('discovery')).not.toContain('at least two');
    expect(rules(at(2))).not.toContain('at least two different');
  });

  it('shows the allowed sources for each role', () => {
    const system = rules(DEFAULT_INFLUENCE);
    expect(system).toContain('- sound (level 1 of 4): ');
    expect(system).toContain('Citable: own: analysis; peers: P<n>');
    expect(system).toContain('own: identity (G<n> only when there are no peers)');
  });
});

describe('buildPickRequest: the artist’s own results', () => {
  it('adds each result with what was suggested, what was published and how it reads now', () => {
    const request = buildPickRequest(ctx({ outcomes: [outcome()] }));
    const result = youtube(request, 'artistResults')!.artistResults!.A1 as Record<string, unknown>;
    expect(result).toMatchObject({
      suggested: { approach: 'Open on the hook.' },
      published: { title: 'My title' },
      editedBeforeApproval: true,
      liveOnYouTubeNow: { title: 'My title' },
      coverage: 'unknown',
    });
    expect(parts(request).find((p) => p.label === 'YouTube outcomes')).toMatchObject({ count: 1 });
    expect(request.system).toContain('A<n> = an artistResults entry');
  });

  it('labels reported counts, a lower bound on gained, and the calculated net', () => {
    const request = buildPickRequest(ctx({ outcomes: [outcome()] }));
    const result = youtube(request, 'artistResults')!.artistResults!.A1 as Record<string, unknown>;
    expect(result.reportedByYouTube).toEqual({
      views: 900,
      subscribersGained: { value: 12, note: "counted on this video's page; a lower bound" },
      subscribersLost: null,
    });
    expect(result.netSubscribers).toEqual({ value: null, calculated: true });
  });

  it('shows a result with no publish record as unsuggested, never as zero', () => {
    const request = buildPickRequest(
      ctx({
        outcomes: [outcome({ suggested: null, published: null, editedBeforeApproval: null })],
      }),
    );
    const result = youtube(request, 'artistResults')!.artistResults!.A1 as Record<string, unknown>;
    expect(result).toMatchObject({ suggested: null, published: null, editedBeforeApproval: null });
  });

  it('adds no results part when there are none', () => {
    expect(youtube(buildPickRequest(ctx()), 'artistResults')).toBeUndefined();
  });
});

describe('finalizePick: citations and the recommendation', () => {
  const fix = (over: Partial<PickContext> = {}) => ctx(over);

  it('keeps only refs the job has and the role may cite', () => {
    const pick = finalizePick(
      raw({
        citations: {
          sound: ['analysis', 'P1', 'P1-R1', 'G1', 'P9', 'made-up'],
          feel: ['voice', 'edits', 'P2-R1', 'identity'],
          wording: ['voice', 'P3'],
          discovery: ['G1', 'analysis', 'P2-R1', 'P2', 'voice'],
          structure: ['identity', 'G1', 'P3-R1', 'P1-R1', 'P1-R1'],
        },
      }),
      fix(),
    );
    expect(pick.citations).toEqual({
      sound: ['analysis', 'P1'],
      feel: ['voice', 'edits', 'P2-R1'],
      wording: ['voice', 'P3'],
      discovery: ['G1', 'analysis', 'P2-R1'],
      // G1 is only a structure source when the job has no peers.
      structure: ['identity', 'P3-R1', 'P1-R1'],
    });
  });

  it('lets a job with no peers cite genre lists for structure', () => {
    const pick = finalizePick(
      raw({ citations: { ...raw().citations, structure: ['G1', 'P1-R1'] } }),
      fix({ evidence: null, candidateLists: [genre] }),
    );
    expect(pick.citations!.structure).toEqual(['G1']);
  });

  it('keeps recommendation evidence the job has, results included, and drops the rest', () => {
    const pick = finalizePick(
      raw({
        recommendation: { ...raw().recommendation, evidence: ['A1', 'P2', 'P1-R1', 'A7', 'zzz'] },
      }),
      fix({ outcomes: [outcome()] }),
    );
    expect(pick.recommendation!.evidence).toEqual(['A1', 'P2', 'P1-R1']);
    expect(pick.outcomeRefs).toEqual({ A1: 'own-1' });
  });

  it('replaces a peer’s channel title in the recommendation with its ref', () => {
    const pick = finalizePick(
      raw({
        recommendation: {
          ...raw().recommendation,
          approach: `Open the way ${PEER_TITLE} does.`,
          followsWhy: `${PEER_TITLE.toUpperCase()} and Velvet Static agree.`,
        },
      }),
      fix(),
    );
    expect(pick.recommendation!.approach).toBe('Open the way P1 does.');
    expect(pick.recommendation!.followsWhy).toBe('P1 and P2 agree.');
  });

  it('replaces a peer’s channel title in the brand check and the explanations with its ref', () => {
    const pick = finalizePick(
      raw({
        brandCheck: `Sounds like ${PEER_TITLE}.`,
        why: {
          title: `${PEER_TITLE} names tracks this way.`,
          description: `Velvet Static opens like this.`,
          tags: `${PEER_TITLE} tags the genre.`,
        },
      }),
      fix(),
    );
    expect(pick.brandCheck).toBe('Sounds like P1.');
    expect(pick.why).toEqual({
      title: 'P1 names tracks this way.',
      description: 'P2 opens like this.',
      tags: 'P1 tags the genre.',
    });
  });

  it('replaces a title every time it appears, and leaves a blank or length-changing one safe', () => {
    const odd = evidence();
    odd.peers[1]!.title = 'İstanbul Nights';
    odd.peers[2]!.title = '  ';
    const pick = finalizePick(
      raw({
        recommendation: {
          ...raw().recommendation,
          approach: `${PEER_TITLE} and ${PEER_TITLE.toLowerCase()} again; İstanbul Nights too.`,
        },
      }),
      fix({ evidence: odd }),
    );
    expect(pick.recommendation!.approach).toBe('P1 and P1 again; P2 too.');
  });

  it('replaces a title only as a whole word, beside punctuation too', () => {
    const short = evidence();
    short.peers[1]!.title = 'Air';
    short.peers[2]!.title = '(Low)';
    const pick = finalizePick(
      raw({
        recommendation: {
          ...raw().recommendation,
          approach: 'Follow the airy hook, like AIR, (low) and "Air". Fair is fine.',
        },
      }),
      fix({ evidence: short }),
    );
    expect(pick.recommendation!.approach).toBe(
      'Follow the airy hook, like P2, P3 and "P2". Fair is fine.',
    );
  });

  it('removes a statistic the model wrote into the recommendation', () => {
    const pick = finalizePick(
      raw({
        recommendation: {
          ...raw().recommendation,
          approach: 'Open on the hook. Views rose 20% after.',
          intendedOutcome: '1,200 views is the goal.',
          followsWhy: 'Views rose 20%. The pattern repeats across the three releases.',
        },
      }),
      fix(),
    );
    expect(pick.recommendation).toMatchObject({
      approach: 'Open on the hook.',
      intendedOutcome: 'Not stated.',
      followsWhy: 'The pattern repeats across the three releases.',
    });
  });

  it('removes a sentinel statistic from every persisted model-written field', () => {
    const stat = 'It earned 987654 views.';
    const text = (label: string) => `${label} stays. ${stat}`;
    const pick = finalizePick(
      raw({
        title: text('Title'),
        description: text('Description'),
        brandCheck: text('Brand'),
        why: {
          title: text('Why title'),
          description: text('Why description'),
          tags: text('Why tags'),
        },
        bandcamp: { about: text('About'), credits: text('Credits') },
        recommendation: {
          approach: text('Approach'),
          intendedOutcome: text('Outcome'),
          follows: 'artist',
          followsWhy: text('Because'),
          evidence: [],
        },
      }),
      fix(),
    );
    const stored = JSON.stringify(pick);
    expect(stored).not.toContain('987654');
    expect(stored).not.toContain('views');
    expect(pick.title).toBe('Title stays.');
    expect(pick.bandcamp.about).toBe('About stays.');
    expect(pick.why.tags).toBe('Why tags stays.');
  });

  it('records the influence used, the limits, and no warning', () => {
    const pick = finalizePick(raw(), fix({ limits: ['analytics-not-shared'] }));
    expect(pick.influence).toEqual(DEFAULT_INFLUENCE);
    expect(pick.limits).toEqual(['analytics-not-shared']);
    expect(pick.recommendation!.limits).toEqual(['analytics-not-shared']);
    expect(pick.influenceWarning).toBeNull();
  });
});

describe('runPick: one re-ask for every check', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const reply = (pick: RawPick) => interaction(JSON.stringify(pick));
  const asks = () =>
    fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        input: { content: { text?: string }[] }[];
      };
      return body.input
        .at(-1)!
        .content.map((part) => part.text ?? '')
        .join(' ');
    });
  const wordingPeer = (extra: Partial<RawPick['citations']> = {}) =>
    raw({ citations: { ...raw().citations, ...extra } });
  // wording at 4 needs two different artists; one peer cited is a miss.
  const wording4: Influence = { ...DEFAULT_INFLUENCE, wording: 4 };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps a pick that passes every check after a single call', async () => {
    fetchMock.mockResolvedValueOnce(reply(raw()));
    const result = await runPick(ctx(), stepDeadline());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result!.pick).toMatchObject({ influenceWarning: null });
    expect(result!.pick.recommendation).not.toBeNull();
  });

  it('re-asks once for a missed level, then keeps the pick with a warning', async () => {
    fetchMock.mockImplementation(async () => reply(wordingPeer({ wording: ['voice', 'P1'] })));
    const result = await runPick(ctx({ influence: wording4 }), stepDeadline());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(asks()[1]).toContain('at least 2 different similar artists for wording');
    expect(result!.pick.influenceWarning).toBe(INFLUENCE_WARNING);
    expect(result!.pick.recommendation).not.toBeNull();
  });

  it('clears the warning when the re-ask meets the level', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(wordingPeer({ wording: ['voice', 'P1'] })))
      .mockResolvedValueOnce(reply(wordingPeer({ wording: ['P1', 'P2'] })));
    const result = await runPick(ctx({ influence: wording4 }), stepDeadline());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result!.pick.influenceWarning).toBeNull();
  });

  it('names a copy and a missed level in the same single re-ask', async () => {
    const copied = raw({
      description: `Made in ${COPIED}.`,
      citations: { ...raw().citations, wording: ['voice', 'P1'] },
    });
    fetchMock
      .mockResolvedValueOnce(reply(copied))
      .mockResolvedValueOnce(reply(wordingPeer({ wording: ['P1', 'P2'] })));
    const result = await runPick(ctx({ influence: wording4 }), stepDeadline());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(asks()[1]).toContain('copies another artist');
    expect(asks()[1]).toContain('wording');
    expect(result!.pick.description).not.toContain('basement');
    expect(result!.pick.influenceWarning).toBeNull();
  });

  it('records the copy re-ask as a count, never its quote of the peer', async () => {
    startSpan.mockClear();
    fetchMock
      .mockResolvedValueOnce(reply(raw({ description: `Made in ${COPIED}.` })))
      .mockResolvedValueOnce(reply(raw()));
    await runPick(ctx(), stepDeadline());
    expect(asks()[1]).toContain(COPIED);
    const reask = JSON.stringify(startSpan.mock.calls.at(-1)![0]);
    expect(reask).toContain('[Copied peer wording: 1]');
    expect(reask).not.toContain('copies another artist');
  });

  it('fails the step when copied wording survives the re-ask', async () => {
    fetchMock.mockImplementation(async () => reply(raw({ description: `Made in ${COPIED}.` })));
    await expect(runPick(ctx(), stepDeadline())).rejects.toBeInstanceOf(CopiedWording);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails the step on a peer’s channel name in the Bandcamp copy', async () => {
    const named = raw({ bandcamp: { about: `Inspired by ${PEER_TITLE}.`, credits: '' } });
    fetchMock.mockImplementation(async () => reply(named));
    await expect(runPick(ctx(), stepDeadline())).rejects.toThrow(
      "copied a similar artist's wording",
    );
    expect(asks()[1]).toContain('names another artist');
  });

  it('spends the one allowance on a parse failure, so a copy after it fails the step', async () => {
    fetchMock
      .mockResolvedValueOnce(interaction('not json'))
      .mockResolvedValueOnce(reply(raw({ description: `Made in ${COPIED}.` })));
    await expect(runPick(ctx(), stepDeadline())).rejects.toBeInstanceOf(CopiedWording);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops a recommendation that rests only on secondary artists, saying why', async () => {
    const secondary = raw({
      recommendation: { ...raw().recommendation, evidence: ['P3', 'P3-R1'] },
    });
    fetchMock.mockImplementation(async () => reply(secondary));
    const result = await runPick(ctx(), stepDeadline());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(asks()[1]).toContain('only on secondary');
    expect(result!.pick.recommendation).toBeNull();
    expect(result!.pick.limits).toContain('secondary-only');
  });

  it('keeps a recommendation once the re-ask adds primary evidence', async () => {
    fetchMock
      .mockResolvedValueOnce(
        reply(raw({ recommendation: { ...raw().recommendation, evidence: ['P3'] } })),
      )
      .mockResolvedValueOnce(
        reply(raw({ recommendation: { ...raw().recommendation, evidence: ['P3', 'P1'] } })),
      );
    const result = await runPick(ctx(), stepDeadline());
    expect(result!.pick.recommendation!.evidence).toEqual(['P3', 'P1']);
    expect(result!.pick.limits).not.toContain('secondary-only');
  });

  it('turns evidence a level needs but the job lacks into a limit, not a mismatch', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(
        raw({
          citations: {
            sound: ['analysis', 'P1'],
            feel: ['voice'],
            wording: ['voice'],
            discovery: ['G1'],
            structure: ['G1'],
          },
        }),
      ),
    );
    // Peers were found but their releases weren't: discovery and structure have nothing to cite.
    const result = await runPick(
      ctx({ evidence: { ...peered, releases: [] }, candidateLists: [genre] }),
      stepDeadline(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result!.pick.influenceWarning).toBeNull();
    expect(result!.pick.limits!.join(' ')).toContain(
      'No similar-artist evidence was available for discovery',
    );
  });

  it('does not warn about the voice when wording follows peers deliberately', async () => {
    fetchMock.mockResolvedValueOnce(reply(wordingPeer({ wording: ['P1', 'P2'] })));
    const result = await runPick(ctx({ influence: wording4 }), stepDeadline());
    expect(result!.pick.influenceWarning).toBeNull();
    expect(result!.pick.brandCheck).toBe('Matches the recent uploads.');
  });
});
