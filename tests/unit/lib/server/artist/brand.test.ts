// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { RULE_MAX, RULES_MAX, STATEMENT_MAX, type BrandGuide, type Proposal } from '#lib/brand.js';
import {
  BRAND_SCHEMA,
  brandInput,
  buildBrandRequest,
  cleanGuide,
  isBrandGuide,
  proposeBrand,
} from '#lib/server/artist/brand.js';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artistGuides, connections, guideClaims, users } from '#lib/server/core/schema.js';
import {
  clearStatsCache,
  type CatalogVideo,
  type Thumbnail,
} from '#lib/server/platforms/youtube/youtube.js';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import { seed, truncate } from '../../../../helpers/db';
import {
  ARTIST_A,
  CHANNEL_A,
  pendingProposal,
  REFRESH_A,
  USER_A,
  USER_B,
  USERS,
} from '../../../../helpers/pipeline';
import {
  busy429,
  geminiError,
  interaction,
  perDay429,
  unavailable503,
} from '../../../../helpers/gemini';

vi.mock('@google-cloud/kms', () => import('../../../../e2e/fakes/kms'));

const auth = vi.hoisted(() => ({ refreshError: null as Error | null }));
// Each grant mints its own token, so a request's Authorization header names the grant behind it.
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

const FLR = ARTIST_A.id;
const propose = (user: { uid: string; artistId: string } = { uid: USER_A.uid, artistId: FLR }) =>
  withIdentity(user.uid, () => proposeBrand(user));

/** The stored brand proposal, or null. */
const pending = async () =>
  (
    await db()
      .select()
      .from(artistGuides)
      .where(eq(artistGuides.kind, 'brand'))
      .orderBy(artistGuides.id)
  ).find((row) => row.status === 'proposed') ?? null;

const GUIDE = {
  statement: 'Song title first, then a two-line story.',
  keep: ['Song title alone in the title'],
  fix: ['Put the stream links in one block'],
  drop: ['All-caps titles'],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Reply = (url: string, init: RequestInit) => Response | Promise<Response>;
let routes: [RegExp, Reply][];
let calls: { url: string; init: RequestInit }[];
let uploads: string[];

const on = (test: RegExp, reply: Reply) => routes.unshift([test, reply]);
const called = (test: RegExp) => calls.filter((c) => test.test(c.url));
const GEMINI = /generativelanguage\.googleapis\.com\/v1beta\/interactions$/;
const geminiBody = () =>
  JSON.parse(String(called(GEMINI)[0]!.init.body)) as {
    model: string;
    store: boolean;
    input: { type: string; content: { type: string }[] }[];
    response_format: unknown;
    generation_config: { max_output_tokens: number; thinking_level: string };
  };

beforeEach(async () => {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  auth.refreshError = null;
  await truncate();
  await seed(USERS);
  resetClients();
  clearStatsCache();
  uploads = Array.from({ length: 35 }, (_, i) => `v${i + 1}`);
  calls = [];
  routes = [
    [GEMINI, () => interaction(JSON.stringify(GUIDE))],
    [
      /youtube\/v3\/channels\?/,
      () =>
        json({
          items: [{ id: CHANNEL_A, contentDetails: { relatedPlaylists: { uploads: 'UUflr' } } }],
        }),
    ],
    [
      /youtube\/v3\/playlistItems\?/,
      () => json({ items: uploads.map((videoId) => ({ contentDetails: { videoId } })) }),
    ],
    [
      /youtube\/v3\/videos\?/,
      (url) =>
        json({
          items: (new URL(url).searchParams.get('id') ?? '')
            .split(',')
            .filter(Boolean)
            .map((id) => ({
              id,
              snippet: {
                title: `Song ${id}`,
                description: 'Out now.',
                thumbnails: { medium: { url: `https://i.ytimg.com/${id}.jpg` } },
              },
            })),
        }),
    ],
    [/i\.ytimg\.com/, () => new Response(new Uint8Array([1, 2, 3]))],
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      const route = routes.find(([test]) => test.test(url));
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route[1](url, init);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('isBrandGuide', () => {
  it('accepts a guide with empty lists', () => {
    expect(isBrandGuide({ statement: '', keep: [], fix: [], drop: [] })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'guide'],
    ['a missing list', { statement: 's', keep: [], fix: [] }],
    ['a numeric rule', { ...GUIDE, keep: [1] }],
    ['a numeric statement', { ...GUIDE, statement: 2 }],
  ])('rejects %s', (_label, value) => {
    expect(isBrandGuide(value)).toBe(false);
  });
});

describe('cleanGuide', () => {
  it('strips model-emitted audio numbers', () => {
    const guide = cleanGuide({ ...GUIDE, fix: ['Master to -14 LUFS before upload'] });
    expect(guide.fix.join(' ')).not.toMatch(/\d/);
  });

  it('dedupes rules case-insensitively, drops blanks, and caps each list', () => {
    const many = Array.from(
      { length: RULES_MAX + 3 },
      (_, i) => `Rule ${String.fromCodePoint(65 + i)}`,
    );
    const guide = cleanGuide({ ...GUIDE, keep: ['Same', ' same ', '', ...many] });
    expect(guide.keep[0]).toBe('Same');
    expect(guide.keep).toHaveLength(RULES_MAX);
    expect(guide.keep).not.toContain('');
  });

  it('clips the statement and each rule to their limits', () => {
    const guide = cleanGuide({
      ...GUIDE,
      statement: 'a'.repeat(STATEMENT_MAX + 50),
      drop: ['b'.repeat(RULE_MAX + 50)],
    });
    expect(guide.statement).toHaveLength(STATEMENT_MAX);
    expect(guide.drop[0]).toHaveLength(RULE_MAX);
  });
});

describe('buildBrandRequest', () => {
  const THUMB: Thumbnail = { data: 'AA', mime_type: 'image/jpeg' };
  const video = (
    id: string,
    thumbnail: Thumbnail | null,
  ): CatalogVideo & { thumbnail: Thumbnail | null } => ({
    videoId: id,
    title: `Song ${id}`,
    description: 'x'.repeat(500),
    tags: [],
    publishedAt: '',
    thumbnailUrl: null,
    views: 0,
    durationSec: 0,
    thumbnail,
  });

  const userParts = (request: ReturnType<typeof buildBrandRequest>) =>
    request.turns[0]!.parts as { type: string; text?: string }[];

  it('shortens descriptions and sends thumbnails as image parts', () => {
    const request = buildBrandRequest([video('a', THUMB), video('b', null)]);
    expect(request.system).toContain('recognizable as one channel');
    const parts = userParts(request);
    const uploads = (JSON.parse(parts[0]!.text!) as { uploads: { description: string }[] }).uploads;
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.description.length).toBeLessThan(500);
    expect(parts.filter((p) => p.type === 'image')).toEqual([{ type: 'image', ...THUMB }]);
  });

  const sentTags = (tags: string[]) => {
    const text = userParts(buildBrandRequest([{ ...video('a', null), tags }]))[0]!.text!;
    return (JSON.parse(text) as { uploads: { tags: string[] }[] }).uploads[0]!.tags;
  };

  it('keeps only the first 8 tags of each upload so the reply fits the context', () => {
    const tags = Array.from({ length: 44 }, (_, i) => `tag ${i}`);
    expect(sentTags(tags)).toEqual(tags.slice(0, 8));
  });

  it('stops at 120 characters of tag text even under 8 tags', () => {
    const long = Array.from({ length: 5 }, (_, i) => `${i}`.padEnd(50, 'x'));
    expect(sentTags(long)).toEqual(long.slice(0, 2));
  });

  it('keeps a tag that lands exactly on the 120-character cap', () => {
    const tags = ['a'.repeat(60), 'b'.repeat(60), 'c'];
    expect(sentTags(tags)).toEqual(tags.slice(0, 2));
  });

  it('sends every tag of an upload with 8 or fewer', () => {
    expect(sentTags(['synthwave', 'retrowave'])).toEqual(['synthwave', 'retrowave']);
    expect(sentTags([])).toEqual([]);
  });

  it('sends text only when no thumbnail loaded', () => {
    expect(userParts(buildBrandRequest([video('a', null)]))).toHaveLength(1);
  });
});

describe('proposeBrand', () => {
  it.each([
    ['a per-minute 429', busy429],
    ['a 503', unavailable503],
  ])('waits on %s and stores nothing', async (_, reply) => {
    on(GEMINI, () => reply());
    expect(await propose()).toEqual({ wait: 'model busy' });
    expect(called(GEMINI)).toHaveLength(1);
    expect(await pending()).toBeNull();
  });

  it('holds every propose on a spent per-day quota until the reset, with no more calls', async () => {
    on(GEMINI, () => perDay429());
    const first = await propose();
    expect(first).toEqual({ wait: 'model quota spent', limitUntil: expect.any(Number) });
    expect(await pending()).toBeNull();
    const reads = calls.length;
    expect(await propose()).toEqual(first);
    expect(calls).toHaveLength(reads);
    const [claim] = await db().select().from(guideClaims);
    expect(claim).toMatchObject({ claimToken: null, kind: 'brand' });
    expect(claim!.limitUntil!.getTime()).toBe((first as { limitUntil: number }).limitUntil);
  });

  it('keeps an earlier proposal while the model is busy', async () => {
    await seed({ artistGuides: [pendingProposal(FLR, 'brand', GUIDE)] });
    const before = await pending();
    on(GEMINI, () => busy429());
    await propose();
    expect(await pending()).toEqual(before);
  });

  it('propagates any other model error and frees the slot', async () => {
    on(GEMINI, () => geminiError(500, 'INTERNAL'));
    await expect(propose()).rejects.toThrow(/^Gemini 500/);
    expect(await pending()).toBeNull();
    expect(await db().select().from(guideClaims)).toMatchObject([{ claimToken: null }]);
  });

  it('reads 30 uploads and 10 thumbnails and stores the proposal with its upload list', async () => {
    const result = (await propose()) as { proposal: Proposal<BrandGuide> };
    expect(result.proposal).toMatchObject({ id: expect.any(Number), body: GUIDE });
    expect(result.proposal.sources.uploads).toHaveLength(30);
    expect(result.proposal.sources.uploads[0]).toEqual({
      videoId: 'v1',
      title: 'Song v1',
      publishedAt: '',
    });
    expect(result.proposal.sources).toMatchObject({ drafts: [], edits: 0, approvals: 0 });
    const stored = (await pending())!;
    expect(stored.id).toBe(result.proposal.id);
    expect(stored.grantAt).not.toBeNull();
    // The list names each upload; descriptions, tags and thumbnails are never stored.
    expect(JSON.stringify(stored)).not.toMatch(/Out now|ytimg/);
    expect(called(/i\.ytimg\.com/)).toHaveLength(10);
    const body = geminiBody();
    expect(body.input[0]!.content.filter((p) => p.type === 'image')).toHaveLength(10);
    expect(body.store).toBe(false);
    expect(body.generation_config).toMatchObject({
      max_output_tokens: 8192,
      thinking_level: 'medium',
    });
    expect(JSON.stringify(body.response_format)).toContain(JSON.stringify(BRAND_SCHEMA));
  });

  it('replaces an earlier proposal with a new id', async () => {
    const first = (await propose()) as { proposal: Proposal<BrandGuide> };
    const second = (await propose()) as { proposal: Proposal<BrandGuide> };
    expect(second.proposal.id).not.toBe(first.proposal.id);
    expect((await pending())!.id).toBe(second.proposal.id);
  });

  it("reads the owner's own channel on their own grant, with no API key or statistics", async () => {
    await propose();
    const reads = called(/youtube\/v3\//);
    expect(reads.length).toBeGreaterThan(0);
    for (const { url, init } of reads) {
      expect(new URL(url).searchParams.get('key')).toBeNull();
      expect(new URL(url).searchParams.get('part')).not.toMatch(/statistics/);
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Bearer access:${REFRESH_A}`,
      );
    }
    expect(called(/commentThreads/)).toHaveLength(0);
    expect(new URL(called(/youtube\/v3\/channels\?/)[0]!.url).searchParams.get('mine')).toBe(
      'true',
    );
  });

  it('records a count of the uploads and a placeholder for the reply, never their text', async () => {
    clearAgentSpan();
    await propose();
    const { input, output } = agentSpanIO();
    expect(input).toHaveLength(1);
    const messages = input[0]!['gen_ai.input.messages'] as string;
    expect(messages).toContain('[YouTube uploads: 30]');
    expect(messages).toContain('"type":"image"');
    expect(messages).not.toMatch(/Out now|Song v1|base64/);
    expect(output).toEqual([`[guide proposal: ${JSON.stringify(GUIDE).length} chars]`]);
  });

  it('strips model audio numbers from the stored guide', async () => {
    on(GEMINI, () =>
      interaction(JSON.stringify({ ...GUIDE, fix: ['Master to -14 LUFS before upload'] })),
    );
    await propose();
    expect(JSON.stringify((await pending())!.body)).not.toMatch(/LUFS|\d/);
  });

  it.each([
    ['revoked', { status: 401, data: { error: 'invalid_grant' } }, 'reconnect YouTube'],
    ['busy', { status: 503, data: {} }, 'waiting on YouTube'],
  ])('waits when the grant is %s, calling no model', async (_label, response, wait) => {
    auth.refreshError = Object.assign(new Error('refresh'), { response });
    expect(await propose()).toEqual({ wait });
    expect(called(GEMINI)).toHaveLength(0);
    expect(await pending()).toBeNull();
  });

  it('waits on a reconnect for an owner with no connection', async () => {
    await db().update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));
    await db().update(users).set({ artistId: FLR }).where(eq(users.uid, USER_B.uid));
    expect(await propose({ uid: USER_B.uid, artistId: FLR })).toEqual({
      wait: 'reconnect YouTube',
    });
    expect(called(/youtube/)).toHaveLength(0);
  });

  it('waits on a reconnect, calling no model, when the grant no longer decrypts', async () => {
    const foreign = Buffer.from('sealed under another key').toString('base64');
    await db()
      .update(connections)
      .set({ tokenCiphertext: foreign })
      .where(eq(connections.uid, USER_A.uid));
    expect(await propose()).toEqual({ wait: 'reconnect YouTube' });
    expect(called(/youtube/)).toHaveLength(0);
    expect(called(GEMINI)).toHaveLength(0);
    expect(await pending()).toBeNull();
    const [row] = await db().select().from(connections).where(eq(connections.uid, USER_A.uid));
    expect(row).toMatchObject({ status: 'revoked', tokenCiphertext: null });
  });

  it('waits on YouTube when a read is busy', async () => {
    on(/youtube\/v3\/playlistItems\?/, () => json({}, 503));
    expect(await propose()).toEqual({ wait: 'waiting on YouTube' });
    expect(called(GEMINI)).toHaveLength(0);
  });

  it('waits on a reconnect and stores nothing when YouTube is disconnected before the save', async () => {
    on(GEMINI, async () => {
      await db().delete(connections).where(eq(connections.uid, USER_A.uid));
      return interaction(JSON.stringify(GUIDE));
    });
    expect(await propose()).toEqual({ wait: 'reconnect YouTube' });
    expect(await pending()).toBeNull();
  });

  it('waits on the model without a call when the reads leave no model time', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now });
    on(/youtube\/v3\/videos\?/, () => {
      vi.setSystemTime(now + 100_000);
      return json({
        items: [{ id: 'v1', snippet: { title: 'Song', description: '', thumbnails: {} } }],
      });
    });
    try {
      expect(await propose()).toEqual({ wait: 'model busy' });
    } finally {
      vi.useRealTimers();
    }
    expect(called(GEMINI)).toHaveLength(0);
  });

  it('409s when the channel has no uploads', async () => {
    uploads = [];
    await expect(propose()).rejects.toMatchObject({
      status: 409,
      message: 'The channel has no public uploads to learn from.',
    });
    expect(called(GEMINI)).toHaveLength(0);
  });

  it('502s and stores nothing when the reply never parses', async () => {
    on(GEMINI, () => interaction('{"statement": 1}'));
    clearAgentSpan();
    await expect(propose()).rejects.toMatchObject({ status: 502 });
    expect(await pending()).toBeNull();
    expect(agentSpanIO().output).toEqual([]);
  });

  it('409s a second propose while the first holds the slot', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    on(GEMINI, async () => {
      await held;
      return interaction(JSON.stringify(GUIDE));
    });
    const first = propose();
    await vi.waitFor(() => expect(called(GEMINI)).toHaveLength(1));
    await expect(propose()).rejects.toMatchObject({
      status: 409,
      message: 'A proposal is already running in another tab.',
    });
    release();
    expect(await first).toMatchObject({ proposal: { body: GUIDE } });
  });
});

describe('brandInput', () => {
  it('trims the statement and rules and drops blank rules', () => {
    expect(brandInput({ statement: '  S. ', keep: [' K ', '  '], fix: [], drop: ['D'] })).toEqual({
      statement: 'S.',
      keep: ['K'],
      fix: [],
      drop: ['D'],
    });
  });

  it.each([null, { statement: 's' }, { ...GUIDE, keep: [1] }])('400s on %j', (value) => {
    expect(() => brandInput(value)).toThrow(
      expect.objectContaining({
        status: 400,
        message: 'Expected a statement and keep, fix, drop lists.',
      }),
    );
  });
});
