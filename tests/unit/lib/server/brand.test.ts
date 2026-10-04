// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { RULE_MAX, RULES_MAX, STATEMENT_MAX, type StoredBrand } from '$lib/brand';
import { ActionError } from '$lib/server/actions';
import {
  approveBrand,
  approvedBrand,
  buildBrandMessages,
  cleanGuide,
  discardBrandProposal,
  getBrand,
  isBrandGuide,
  proposeBrand,
  requireAllowlisted,
} from '$lib/server/brand';
import { resetClients } from '$lib/server/clients';
import { clearStatsCache, type CatalogVideo } from '$lib/server/youtube';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

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

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  vi.stubEnv('FLR_CHANNEL_ID', 'UCflr');
  resetStore();
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
    expect(store.has('artists/flr/brand/proposal')).toBe(false);
  });

  it('waits while another run holds the model', async () => {
    on(/\/slots$/, () => json([{ is_processing: true }]));
    expect(await proposeBrand()).toEqual({ wait: 'waiting on another run' });
    expect(called(/chat\/completions$/)).toHaveLength(0);
  });

  it('reads 30 uploads and 10 thumbnails and stores the proposal', async () => {
    const result = await proposeBrand();
    expect(result).toMatchObject({ proposal: { ...GUIDE, status: 'PROPOSED', approvedAt: null } });
    const stored = store.get('artists/flr/brand/proposal') as StoredBrand;
    expect(stored.basedOn).toEqual(uploads.slice(0, 30));
    expect(called(/i\.ytimg\.com/)).toHaveLength(10);
    const parts = chatBody().messages[1]!.content as { type: string }[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(10);
  });

  it('409s when the channel has no uploads', async () => {
    uploads = [];
    await expect(proposeBrand()).rejects.toMatchObject({ status: 409 });
    expect(called(/chat\/completions$/)).toHaveLength(0);
  });

  it('502s and stores nothing when the reply never parses', async () => {
    on(/chat\/completions$/, () => completion('{"statement": 1}'));
    await expect(proposeBrand()).rejects.toMatchObject({ status: 502 });
    expect(store.has('artists/flr/brand/proposal')).toBe(false);
  });
});

describe('approveBrand', () => {
  beforeEach(() => store.set('artists/flr/brand/proposal', PROPOSAL));

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
    expect(store.get('artists/flr/brand/approved')).toEqual(approved);
    expect(store.has('artists/flr/brand/proposal')).toBe(false);
  });

  it('replaces an earlier approved guide', async () => {
    store.set('artists/flr/brand/approved', { ...PROPOSAL, statement: 'Old', status: 'APPROVED' });
    await approveBrand({ ...GUIDE, proposedAt: PROPOSAL.createdAt });
    expect((store.get('artists/flr/brand/approved') as StoredBrand).statement).toBe(
      GUIDE.statement,
    );
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
    expect(store.has('artists/flr/brand/approved')).toBe(false);
    expect(store.has('artists/flr/brand/proposal')).toBe(true);
  });

  it('409s once the proposal is gone', async () => {
    await discardBrandProposal();
    const error = await approveBrand({ ...GUIDE, proposedAt: PROPOSAL.createdAt }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).status).toBe(409);
    expect(store.has('artists/flr/brand/approved')).toBe(false);
  });

  it('400s without the reviewed proposal named', async () => {
    await expect(approveBrand(GUIDE)).rejects.toMatchObject({ status: 400 });
    expect(store.has('artists/flr/brand/proposal')).toBe(true);
  });

  it('409s on stale text when another tab replaced the proposal, changing neither guide', async () => {
    const newer = { ...PROPOSAL, statement: 'Newer proposal.', createdAt: PROPOSAL.createdAt + 1 };
    store.set('artists/flr/brand/proposal', newer);
    const error = await approveBrand({ ...GUIDE, proposedAt: PROPOSAL.createdAt }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ status: 409 });
    expect(store.has('artists/flr/brand/approved')).toBe(false);
    expect(store.get('artists/flr/brand/proposal')).toEqual(newer);
  });
});

describe('reads', () => {
  it('has neither guide before the first proposal', async () => {
    expect(await getBrand()).toEqual({ approved: null, proposal: null });
    expect(await approvedBrand()).toBeNull();
  });

  it('gives smart pick only the guide fields', async () => {
    store.set('artists/flr/brand/approved', { ...PROPOSAL, status: 'APPROVED', approvedAt: 5 });
    expect(await approvedBrand()).toEqual(GUIDE);
  });

  it('keeps the approved guide when a proposal is discarded', async () => {
    store.set('artists/flr/brand/approved', { ...PROPOSAL, status: 'APPROVED' });
    store.set('artists/flr/brand/proposal', PROPOSAL);
    await discardBrandProposal();
    const { approved, proposal } = await getBrand();
    expect(approved).not.toBeNull();
    expect(proposal).toBeNull();
  });
});

describe('requireAllowlisted', () => {
  it.each([
    ['signed out', null],
    ['not allowlisted', { email: 'v@example.com', allowlisted: false, demo: false }],
    ['a demo account', { email: 'd@example.com', allowlisted: false, demo: true }],
  ])('404s when %s', (_label, session) => {
    let thrown: unknown;
    try {
      requireAllowlisted(session);
    } catch (error) {
      thrown = error;
    }
    expect(isHttpError(thrown) && thrown.status).toBe(404);
  });

  it('lets an allowlisted session through', () => {
    expect(() =>
      requireAllowlisted({ email: 'n@example.com', allowlisted: true, demo: false }),
    ).not.toThrow();
  });
});
