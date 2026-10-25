// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_RULE_MAX, VOICE_RULES_MAX, type Proposal, type VoiceRules } from '#lib/brand.js';
import { approveGuide, approvedGuides, discardProposal } from '#lib/server/artist/guides.js';
import type { Feedback } from '#lib/server/artist/memory.js';
import {
  buildVoiceRequest,
  cleanVoice,
  isVoiceRules,
  proposeVoice,
  voiceEvidence,
  voiceInput,
  VOICE_SCHEMA,
  type VoiceEvidence,
} from '#lib/server/artist/voice.js';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artistGuides, connections } from '#lib/server/core/schema.js';
import type { CatalogVideo } from '#lib/server/platforms/youtube/youtube.js';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import { seed, truncate } from '../../../../helpers/db';
import { busy429, interaction } from '../../../../helpers/gemini';
import {
  ARTIST_A,
  ARTIST_C,
  CHANNEL_C,
  NATHAN_VOICE_RULES,
  REFRESH_C,
  USER_A,
  USER_C,
  USERS,
} from '../../../../helpers/pipeline';

vi.mock('@google-cloud/kms', () => import('../../../../e2e/fakes/kms'));

const auth = vi.hoisted(() => ({ refreshError: null as Error | null }));
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    refresh = '';
    setCredentials(credentials: { refresh_token: string }) {
      this.refresh = credentials.refresh_token;
    }
    async getAccessToken() {
      if (auth.refreshError) throw auth.refreshError;
      return { token: `access:${this.refresh}` };
    }
  },
}));

const C = ARTIST_C.id;
const PROSE =
  'Made this one in the basement with a broken drum machine and a lot of coffee, enjoy it.';
const VOICE = { rules: ['Short sentences.', 'Self-mocking asides.'] };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Reply = (url: string) => Response | Promise<Response>;
let routes: [RegExp, Reply][];
let calls: string[];
let videos: { id: string; title: string; description: string }[];
const on = (test: RegExp, reply: Reply) => routes.unshift([test, reply]);
const GEMINI = /generativelanguage\.googleapis\.com\/v1beta\/interactions$/;
const called = (test: RegExp) => calls.filter((url) => test.test(url));
const geminiInit = () => vi.mocked(fetch).mock.calls.find(([url]) => GEMINI.test(String(url)))![1]!;
const geminiBody = () =>
  JSON.parse(String(geminiInit().body)) as {
    input: { content: { type: string; text?: string }[] }[];
    response_format: unknown;
    generation_config: { max_output_tokens: number; thinking_level: string };
    store: boolean;
  };

const propose = (uid: string = USER_C.uid, artistId: string = C) =>
  withIdentity(uid, () => proposeVoice({ uid, artistId }));

const feedback = (over: Partial<Feedback>): Feedback => ({
  kind: 'EDITED',
  jobId: 'j',
  songTitle: 'Song',
  pickVersion: 1,
  at: 1,
  ...over,
});
const seedFeedback = (...rows: Partial<Feedback>[]) =>
  seed({
    artistMemory: rows.map((row) => ({ artistId: C, kind: 'feedback', data: feedback(row) })),
  });
const seedPublished = (...videoIds: string[]) =>
  seed({
    artistMemory: videoIds.map((key) => ({
      artistId: C,
      kind: 'publish',
      key,
      data: { videoId: key },
    })),
  });

beforeEach(async () => {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  auth.refreshError = null;
  await truncate();
  await seed(USERS);
  resetClients();
  videos = Array.from({ length: 6 }, (_, i) => ({
    id: `v${i + 1}`,
    title: `Song v${i + 1}`,
    description: PROSE,
  }));
  calls = [];
  routes = [
    [GEMINI, () => interaction(JSON.stringify(VOICE))],
    [
      /youtube\/v3\/channels\?/,
      () =>
        json({
          items: [{ id: CHANNEL_C, contentDetails: { relatedPlaylists: { uploads: 'UUtest' } } }],
        }),
    ],
    [
      /youtube\/v3\/playlistItems\?/,
      () => json({ items: videos.map(({ id }) => ({ contentDetails: { videoId: id } })) }),
    ],
    [
      /youtube\/v3\/videos\?/,
      () =>
        json({
          items: videos.map(({ id, title, description }) => ({
            id,
            snippet: { title, description, publishedAt: '2026-10-01T00:00:00Z' },
          })),
        }),
    ],
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const route = routes.find(([test]) => test.test(url));
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route[1](url);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const upload = (videoId: string, description = PROSE): CatalogVideo => ({
  videoId,
  title: `Song ${videoId}`,
  description,
  tags: ['synthwave'],
  publishedAt: '2026-10-01T00:00:00Z',
  thumbnailUrl: null,
  views: 0,
  durationSec: 0,
});

describe('isVoiceRules', () => {
  it.each([
    [{ rules: [] }, true],
    [{ rules: ['a'] }, true],
    [{ rules: [1] }, false],
    [{}, false],
    [null, false],
  ])('%j → %s', (value, ok) => {
    expect(isVoiceRules(value)).toBe(ok);
  });
});

describe('voiceEvidence', () => {
  it("splits the artist's own writing from published Soundboard drafts and drops empty ones", async () => {
    await seedPublished('v2');
    const evidence = await withIdentity(USER_C.uid, () =>
      voiceEvidence(C, [upload('v1'), upload('v2'), upload('v3', '   ')]),
    );
    expect(evidence.written.map((u) => u.videoId)).toEqual(['v1']);
    expect(evidence.drafts.map((u) => u.videoId)).toEqual(['v2']);
  });

  it('clips descriptions and edits, and keeps only title and description edits', async () => {
    await seedFeedback(
      { field: 'description', before: 'b'.repeat(700), after: 'a'.repeat(700) },
      { field: 'title', before: 'Old', after: 'New' },
      { field: 'tags', before: 'x', after: 'y' },
      { kind: 'SKIPPED' },
      { kind: 'ACCEPTED', after: 'Kept Title' },
    );
    const evidence = await withIdentity(USER_C.uid, () =>
      voiceEvidence(C, [upload('v1', 'w '.repeat(1000))]),
    );
    expect(evidence.written[0]!.description.length).toBeLessThanOrEqual(1500);
    expect(evidence.edits).toEqual([
      { field: 'title', song: 'Song', before: 'Old', after: 'New' },
      { field: 'description', song: 'Song', before: 'b'.repeat(600), after: 'a'.repeat(600) },
    ]);
    expect(evidence.approvals).toEqual(['Kept Title']);
  });

  it('calls the evidence thin under 5 prose descriptions and edits, not counting short ones', async () => {
    const short = 'Out now on Bandcamp https://x.bandcamp.com #synthwave #newmusic';
    const thin = await withIdentity(USER_C.uid, () =>
      voiceEvidence(C, [
        upload('v1'),
        upload('v2'),
        upload('v3'),
        upload('v4', short),
        upload('v5', short),
      ]),
    );
    expect(thin.thin).toBe(true);
    await seedFeedback(
      { field: 'title', before: 'a', after: 'b' },
      { field: 'title', before: 'c', after: 'd' },
    );
    const enough = await withIdentity(USER_C.uid, () =>
      voiceEvidence(C, [upload('v1'), upload('v2'), upload('v3')]),
    );
    expect(enough.thin).toBe(false);
  });

  it("never reads another artist's memory", async () => {
    await seed({
      artistMemory: [
        {
          artistId: ARTIST_A.id,
          kind: 'feedback',
          data: feedback({ field: 'title', after: 'His' }),
        },
        { artistId: ARTIST_A.id, kind: 'publish', key: 'v1', data: {} },
      ],
    });
    const evidence = await withIdentity(USER_C.uid, () => voiceEvidence(C, [upload('v1')]));
    expect(evidence).toMatchObject({ edits: [], approvals: [], drafts: [] });
    expect(evidence.written).toHaveLength(1);
  });
});

describe('buildVoiceRequest', () => {
  const evidence = (over: Partial<VoiceEvidence> = {}): VoiceEvidence => ({
    written: [{ videoId: 'v1', title: 'Mine', publishedAt: '', description: PROSE }],
    drafts: [{ videoId: 'v2', title: 'Drafted', publishedAt: '', description: 'Drafted text.' }],
    edits: [{ field: 'title', song: 'S', before: 'a', after: 'b' }],
    approvals: ['Kept'],
    thin: false,
    ...over,
  });

  it('tags both upload groups as YouTube parts with counts, the drafts at lower weight', () => {
    const request = buildVoiceRequest(evidence());
    const parts = request.turns[0]!.parts as { text: string; source?: string; count?: number }[];
    expect(parts.map((p) => [p.text.split(':\n')[0], p.source, p.count])).toEqual([
      ['Written by the artist', 'youtube', 1],
      ['Approved Soundboard drafts (lower weight)', 'youtube', 1],
      ['Soundboard edits, newest first', undefined, undefined],
    ]);
    expect(parts[2]!.text).toContain('"weight":"strong"');
    expect(parts[2]!.text).toContain('"weight":"weak","title":"Kept"');
    expect(request.system).toContain("weigh them below the artist's own writing and edits");
    expect(request.system).toContain(`At most ${VOICE_RULES_MAX} rules.`);
    expect(request.system).toMatch(/No rules about hashtags, tags, links, contact lines/);
  });

  it('sends no empty upload group and caps thin evidence at 3 rules', () => {
    const request = buildVoiceRequest(evidence({ written: [], drafts: [], thin: true }));
    expect(request.turns[0]!.parts).toHaveLength(1);
    expect(request.system).toContain('The evidence is thin: write at most 3 rules.');
  });
});

describe('cleanVoice', () => {
  it('strips audio numbers, clips, dedupes and caps the rules', () => {
    const rules = [
      'Master to -14 LUFS',
      'Same',
      ' same ',
      'x'.repeat(VOICE_RULE_MAX + 20),
      ...Array.from({ length: 20 }, (_, i) => `Rule ${String.fromCodePoint(65 + i)}`),
    ];
    const clean = cleanVoice({ rules });
    expect(clean.rules.join(' ')).not.toMatch(/LUFS|-14/);
    expect(clean.rules).toHaveLength(VOICE_RULES_MAX);
    expect(clean.rules.filter((r) => r.toLowerCase() === 'same')).toHaveLength(1);
    expect(clean.rules.find((r) => r.startsWith('x'))).toHaveLength(VOICE_RULE_MAX);
    expect(cleanVoice({ rules }, true).rules).toHaveLength(3);
  });
});

describe('voiceInput', () => {
  it('trims rules and drops blank lines', () => {
    expect(voiceInput({ rules: [' a ', '  ', 'b'] })).toEqual({ rules: ['a', 'b'] });
  });

  it.each([null, {}, { rules: 'a' }])('400s on %j', (value) => {
    expect(() => voiceInput(value)).toThrow(
      expect.objectContaining({ status: 400, message: 'Expected voice rules.' }),
    );
  });
});

describe('proposeVoice', () => {
  const pending = async () =>
    (await db().select().from(artistGuides).where(eq(artistGuides.artistId, C))).find(
      (row) => row.status === 'proposed',
    ) ?? null;

  it('proposes from the owner uploads and edits, listing each source group', async () => {
    await seedPublished('v2');
    await seedFeedback(
      { field: 'title', before: 'a', after: 'b' },
      { kind: 'ACCEPTED', after: 'T' },
    );
    const result = (await propose()) as { proposal: Proposal<VoiceRules> };
    expect(result.proposal.body).toEqual(VOICE);
    expect(result.proposal.sources).toEqual({
      uploads: ['v1', 'v3', 'v4', 'v5', 'v6'].map((id) => ({
        videoId: id,
        title: `Song ${id}`,
        publishedAt: '2026-10-01T00:00:00Z',
      })),
      drafts: [{ videoId: 'v2', title: 'Song v2', publishedAt: '2026-10-01T00:00:00Z' }],
      edits: 1,
      approvals: 1,
      thin: false,
    });
    expect((await pending())!.grantAt).not.toBeNull();
    const body = geminiBody();
    expect(body.store).toBe(false);
    expect(body.generation_config).toMatchObject({
      max_output_tokens: 8192,
      thinking_level: 'medium',
    });
    expect(JSON.stringify(body.response_format)).toContain(JSON.stringify(VOICE_SCHEMA));
    expect(body.input[0]!.content.some((p) => p.type === 'image')).toBe(false);
    for (const url of called(/youtube\/v3\//)) {
      expect(new URL(url).searchParams.get('part')).not.toMatch(/statistics/);
    }
    const reads = vi.mocked(fetch).mock.calls.filter(([url]) => /youtube/.test(String(url)));
    expect(reads.length).toBeGreaterThan(0);
    for (const [, init] of reads) {
      expect((init!.headers as Record<string, string>).authorization).toBe(
        `Bearer access:${REFRESH_C}`,
      );
    }
  });

  it('learns from edits alone without a YouTube connection', async () => {
    await db().delete(connections).where(eq(connections.uid, USER_C.uid));
    await seedFeedback({ field: 'description', before: 'a', after: PROSE });
    const result = (await propose()) as { proposal: Proposal<VoiceRules> };
    expect(result.proposal.sources).toMatchObject({
      uploads: [],
      drafts: [],
      edits: 1,
      thin: true,
    });
    expect(called(/youtube/)).toEqual([]);
    expect((await pending())!.grantAt).toBeNull();
  });

  it('409s with nothing to learn from, calling no model', async () => {
    await db().delete(connections).where(eq(connections.uid, USER_C.uid));
    await expect(propose()).rejects.toMatchObject({
      status: 409,
      message: 'Nothing to learn from yet. Connect YouTube or finish a few releases first.',
    });
    expect(called(GEMINI)).toEqual([]);
  });

  it('skips YouTube for a connection with no channel', async () => {
    await db()
      .update(connections)
      .set({ status: 'no_channel', channelId: null, tokenCiphertext: null })
      .where(eq(connections.uid, USER_C.uid));
    await seedFeedback({ field: 'title', before: 'a', after: 'b' });
    expect(await propose()).toMatchObject({ proposal: { body: VOICE } });
    expect(called(/youtube/)).toEqual([]);
  });

  it('waits on a reconnect when the grant is revoked, storing nothing', async () => {
    auth.refreshError = Object.assign(new Error('refresh'), {
      response: { status: 400, data: { error: 'invalid_grant' } },
    });
    expect(await propose()).toEqual({ wait: 'reconnect YouTube' });
    expect(called(GEMINI)).toEqual([]);
    expect(await pending()).toBeNull();
  });

  it('waits on a busy model, storing nothing', async () => {
    on(GEMINI, () => busy429());
    expect(await propose()).toEqual({ wait: 'model busy' });
    expect(await pending()).toBeNull();
  });

  it('waits on the model without a call when the reads leave no model time', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now });
    on(/youtube\/v3\/videos\?/, () => {
      vi.setSystemTime(now + 100_000);
      return json({ items: [{ id: 'v1', snippet: { title: 'S', description: PROSE } }] });
    });
    try {
      expect(await propose()).toEqual({ wait: 'model busy' });
    } finally {
      vi.useRealTimers();
    }
    expect(called(GEMINI)).toEqual([]);
  });

  it.each([
    ['an unparseable reply', '{"rules": 1}'],
    ['an empty rule list', '{"rules": ["  "]}'],
  ])('502s on %s, storing nothing', async (_label, reply) => {
    on(GEMINI, () => interaction(reply));
    await expect(propose()).rejects.toMatchObject({
      status: 502,
      message: 'The model reply did not parse as a voice. Try again.',
    });
    expect(await pending()).toBeNull();
  });

  it('records counts and a reply placeholder on the span, never upload text or rules', async () => {
    clearAgentSpan();
    await propose();
    const { input, output } = agentSpanIO();
    const messages = input[0]!['gen_ai.input.messages'] as string;
    expect(messages).toContain('[YouTube uploads: 6]');
    expect(messages).not.toContain('basement');
    expect(output).toEqual([`[guide proposal: ${JSON.stringify(VOICE).length} chars]`]);
    expect(JSON.stringify(output)).not.toContain('Short sentences');
  });
});

describe("Nathan's voice", () => {
  const nathan = () => withIdentity(USER_A.uid, () => approvedGuides(ARTIST_A.id));

  it('changes only when a new proposal is approved', async () => {
    routes.unshift([
      /youtube\/v3\/channels\?/,
      () =>
        json({
          items: [{ id: 'UCflr', contentDetails: { relatedPlaylists: { uploads: 'UUflr' } } }],
        }),
    ]);
    const first = (await propose(USER_A.uid, ARTIST_A.id)) as { proposal: Proposal<VoiceRules> };
    expect((await nathan()).voice).toEqual({ rules: NATHAN_VOICE_RULES });
    await withIdentity(USER_A.uid, () => discardProposal(ARTIST_A.id, 'voice', first.proposal.id));
    expect((await nathan()).voice).toEqual({ rules: NATHAN_VOICE_RULES });
    const second = (await propose(USER_A.uid, ARTIST_A.id)) as { proposal: Proposal<VoiceRules> };
    const approved = await withIdentity(USER_A.uid, () =>
      approveGuide(ARTIST_A.id, 'voice', second.proposal.id, VOICE),
    );
    expect(approved.sources.carriedOver).toBe(false);
    expect((await nathan()).voice).toEqual(VOICE);
  });
});
