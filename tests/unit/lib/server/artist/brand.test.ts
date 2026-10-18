// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { RULE_MAX, RULES_MAX, STATEMENT_MAX, type StoredBrand } from '$lib/brand';
import { ActionError } from '$lib/server/core/errors';
import {
  approveBrand,
  approvedBrand,
  buildBrandMessages,
  cleanGuide,
  discardBrandProposal,
  getBrand,
  isBrandGuide,
  proposeBrand,
  requireArtist,
} from '$lib/server/artist/brand';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { artistBrand } from '$lib/server/core/schema';
import { clearStatsCache, type CatalogVideo } from '$lib/server/platforms/youtube/youtube';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import { seed, truncate } from '../../../../helpers/db';

type Slot = 'proposal' | 'approved';

const read = async (slot: Slot) =>
  (
    await db()
      .select({ data: artistBrand.data })
      .from(artistBrand)
      .where(and(eq(artistBrand.artistId, 'flr'), eq(artistBrand.slot, slot)))
  )[0]?.data ?? null;
const has = async (slot: Slot) => (await read(slot)) !== null;
const put = async (slot: Slot, data: StoredBrand) => {
  await db()
    .delete(artistBrand)
    .where(and(eq(artistBrand.artistId, 'flr'), eq(artistBrand.slot, slot)));
  await seed({ artistBrand: [{ artistId: 'flr', slot, data }] });
};

const GUIDE = {
  statement: 'Song title first, then a two-line story.',
  keep: ['Song title alone in the title'],
  fix: ['Put the stream links in one block'],
  drop: ['All-caps titles'],
};

const PROPOSAL: StoredBrand = {
  ...GUIDE,
  status: 'PROPOSED',
  basedOn: ['v1', 'v2'],
  createdAt: 100,
  approvedAt: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Reply = (url: string, init: RequestInit) => Response | Promise<Response>;
let routes: [RegExp, Reply][];
let calls: { url: string; init: RequestInit }[];
let uploads: string[];

const on = (test: RegExp, reply: Reply) => routes.unshift([test, reply]);
const called = (test: RegExp) => calls.filter((c) => test.test(c.url));
const chatBody = () =>
  JSON.parse(String(called(/chat\/completions$/)[0]!.init.body)) as {
    messages: { content: string | { type: string }[] }[];
  };
const completion = (content: string) =>
  json({ choices: [{ message: { content } }], usage: { total_tokens: 1 } });

beforeEach(async () => {
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  vi.stubEnv('FLR_CHANNEL_ID', 'UCflr');
  await truncate();
  resetClients();
  clearStatsCache();
  uploads = Array.from({ length: 35 }, (_, i) => `v${i + 1}`);
  calls = [];
  routes = [
    [/\/health$/, () => json({ status: 'ok' })],
    [/\/slots$/, () => json([{ is_processing: false }])],
    [/chat\/completions$/, () => completion(JSON.stringify(GUIDE))],
    [
      /youtube\/v3\/channels\?/,
      () => json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUflr' } } }] }),
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

describe('buildBrandMessages', () => {
  const video = (
    id: string,
    thumbnail: string | null,
  ): CatalogVideo & { thumbnail: string | null } => ({
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

  it('shortens descriptions and sends thumbnails as image parts', () => {
    const [, user] = buildBrandMessages([
      video('a', 'data:image/jpeg;base64,AA'),
      video('b', null),
    ]);
    const parts = user!.content as { type: string; text?: string }[];
    const uploads = (JSON.parse(parts[0]!.text!) as { uploads: { description: string }[] }).uploads;
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.description.length).toBeLessThan(500);
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1);
  });

  const sentTags = (tags: string[]) => {
    const [, user] = buildBrandMessages([{ ...video('a', null), tags }]);
    const text = (user!.content as { text: string }[])[0]!.text;
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
    const [, user] = buildBrandMessages([video('a', null)]);
    expect(user!.content).toHaveLength(1);
  });
});

describe('proposeBrand', () => {
  it('waits without reading the channel while the model loads', async () => {
    on(/\/health$/, () => new Response('loading', { status: 503 }));
    expect(await proposeBrand()).toEqual({ wait: 'waking model' });
    expect(called(/youtube/)).toHaveLength(0);
    expect(await has('proposal')).toBe(false);
  });

  it('waits while another run holds the model', async () => {
    on(/\/slots$/, () => json([{ is_processing: true }]));
    expect(await proposeBrand()).toEqual({ wait: 'waiting on another run' });
    expect(called(/chat\/completions$/)).toHaveLength(0);
  });

  it('waits when the model scales to zero after the readiness check', async () => {
    on(
      /chat\/completions$/,
      () => new Response('Model is not yet ready for inference.', { status: 429 }),
    );
    expect(await proposeBrand()).toEqual({ wait: 'waking model' });
    expect(await has('proposal')).toBe(false);
  });

  it('propagates any other model error', async () => {
    on(/chat\/completions$/, () => new Response('boom', { status: 500 }));
    await expect(proposeBrand()).rejects.toThrow('llama-server 500: boom');
    expect(await has('proposal')).toBe(false);
  });

  it('reads 30 uploads and 10 thumbnails and stores the proposal', async () => {
    const result = await proposeBrand();
    expect(result).toMatchObject({ proposal: { ...GUIDE, status: 'PROPOSED', approvedAt: null } });
    const stored = (await read('proposal')) as StoredBrand;
    expect(stored.basedOn).toEqual(uploads.slice(0, 30));
    expect(called(/i\.ytimg\.com/)).toHaveLength(10);
    const parts = chatBody().messages[1]!.content as { type: string }[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(10);
  });

  it('records the redacted request and the guide on the agent span', async () => {
    clearAgentSpan();
    await proposeBrand();
    const { input, output } = agentSpanIO();
    expect(input).toHaveLength(1);
    expect(input[0]!['gen_ai.input.messages']).toContain('"type":"image"');
    expect(input[0]!['gen_ai.input.messages']).not.toContain('base64');
    expect(JSON.parse(output[0]!)).toEqual(GUIDE);
  });

  it('records the cleaned guide, minus model audio numbers, as the agent output', async () => {
    const loud = { ...GUIDE, fix: ['Master to -14 LUFS before upload'] };
    on(/chat\/completions$/, () => completion(JSON.stringify(loud)));
    clearAgentSpan();
    const result = await proposeBrand();
    const [output] = agentSpanIO().output;
    expect(output).not.toMatch(/LUFS|\d/);
    expect(JSON.parse(output!)).toMatchObject({
      fix: (result as { proposal: StoredBrand }).proposal.fix,
    });
  });

  it('409s when the channel has no uploads', async () => {
    uploads = [];
    await expect(proposeBrand()).rejects.toMatchObject({ status: 409 });
    expect(called(/chat\/completions$/)).toHaveLength(0);
  });

  it('502s and stores nothing when the reply never parses', async () => {
    on(/chat\/completions$/, () => completion('{"statement": 1}'));
    clearAgentSpan();
    await expect(proposeBrand()).rejects.toMatchObject({ status: 502 });
    expect(await has('proposal')).toBe(false);
    expect(agentSpanIO().output).toEqual([]);
  });
});

describe('approveBrand', () => {
  beforeEach(() => put('proposal', PROPOSAL));

  it('approves the edited guide, trimmed, and clears the proposal', async () => {
    const approved = await approveBrand({
      statement: '  Edited statement. ',
      keep: [' Keep this ', '   '],
      fix: [],
      drop: ['Drop this'],
      proposedAt: PROPOSAL.createdAt,
    });
    expect(approved).toMatchObject({
      statement: 'Edited statement.',
      keep: ['Keep this'],
      fix: [],
      drop: ['Drop this'],
      status: 'APPROVED',
      basedOn: PROPOSAL.basedOn,
      createdAt: PROPOSAL.createdAt,
    });
    expect(await read('approved')).toEqual(approved);
    expect(await has('proposal')).toBe(false);
  });

  it('replaces an earlier approved guide', async () => {
    await put('approved', { ...PROPOSAL, statement: 'Old', status: 'APPROVED' });
    await approveBrand({ ...GUIDE, proposedAt: PROPOSAL.createdAt });
    expect(((await read('approved')) as StoredBrand).statement).toBe(GUIDE.statement);
  });

  it('400s on a malformed body', async () => {
    await expect(approveBrand({ statement: 'x' })).rejects.toMatchObject({ status: 400 });
  });

  it('422s on an invalid guide and writes nothing', async () => {
    await expect(
      approveBrand({ ...GUIDE, statement: '   ', proposedAt: PROPOSAL.createdAt }),
    ).rejects.toMatchObject({
      status: 422,
    });
    expect(await has('approved')).toBe(false);
    expect(await has('proposal')).toBe(true);
  });

  it('409s once the proposal is gone', async () => {
    await discardBrandProposal();
    const error = await approveBrand({ ...GUIDE, proposedAt: PROPOSAL.createdAt }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).status).toBe(409);
    expect(await has('approved')).toBe(false);
  });

  it('400s without the reviewed proposal named', async () => {
    await expect(approveBrand(GUIDE)).rejects.toMatchObject({ status: 400 });
    expect(await has('proposal')).toBe(true);
  });

  it('409s on stale text when another tab replaced the proposal, changing neither guide', async () => {
    const newer = { ...PROPOSAL, statement: 'Newer proposal.', createdAt: PROPOSAL.createdAt + 1 };
    await put('proposal', newer);
    const error = await approveBrand({ ...GUIDE, proposedAt: PROPOSAL.createdAt }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ status: 409 });
    expect(await has('approved')).toBe(false);
    expect(await read('proposal')).toEqual(newer);
  });
});

describe('reads', () => {
  it('has neither guide before the first proposal', async () => {
    expect(await getBrand()).toEqual({ approved: null, proposal: null });
    expect(await approvedBrand()).toBeNull();
  });

  it('gives smart pick only the guide fields', async () => {
    await put('approved', { ...PROPOSAL, status: 'APPROVED', approvedAt: 5 });
    expect(await approvedBrand()).toEqual(GUIDE);
  });

  it('keeps the approved guide when a proposal is discarded', async () => {
    await put('approved', { ...PROPOSAL, status: 'APPROVED' });
    await put('proposal', PROPOSAL);
    await discardBrandProposal();
    const { approved, proposal } = await getBrand();
    expect(approved).not.toBeNull();
    expect(proposal).toBeNull();
  });
});

describe('requireArtist', () => {
  it.each([
    ['signed out', null],
    ['not linked to an artist', { artistId: null }],
    ['linked to another artist', { artistId: 'other' }],
  ])('404s when %s', (_label, user) => {
    let thrown: unknown;
    try {
      requireArtist(user);
    } catch (error) {
      thrown = error;
    }
    expect(isHttpError(thrown) && thrown.status).toBe(404);
  });

  it("lets Nathan's artist through", () => {
    expect(() => requireArtist({ artistId: 'flr' })).not.toThrow();
  });
});
