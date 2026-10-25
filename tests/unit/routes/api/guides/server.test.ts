// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artistGuides, connections } from '#lib/server/core/schema.js';
import { POST as approve } from '#src/routes/api/guides/[kind=guide]/approve/+server.js';
import { POST as discard } from '#src/routes/api/guides/[kind=guide]/discard/+server.js';
import { POST as propose } from '#src/routes/api/guides/[kind=guide]/propose/+server.js';
import { params } from '#src/params.js';
import { seed, truncate } from '../../../../helpers/db';
import { interaction } from '../../../../helpers/gemini';
import {
  ARTIST_A,
  ARTIST_C,
  pendingProposal,
  USER_A,
  USER_B,
  USER_C,
  USERS,
} from '../../../../helpers/pipeline';

type Handler = (event: never) => Response | Promise<Response>;
type User = typeof USER_A | typeof USER_B | typeof USER_C;
const C = ARTIST_C.id;
const GUIDE = { statement: 'S.', keep: ['K'], fix: [], drop: [] };

const call = (handler: Handler, kind: 'voice' | 'brand', user: User, body?: unknown) =>
  withIdentity(user.uid, async () =>
    handler({
      request: new Request(`http://localhost/api/guides/${kind}`, {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      locals: { user },
      params: { kind },
    } as never),
  );

const status = async (operation: Promise<Response>) => {
  try {
    return (await operation).status;
  } catch (error) {
    if (isHttpError(error)) return error.status;
    throw error;
  }
};

const proposalOf = async (artistId: string, kind: 'voice' | 'brand') =>
  (await db().select().from(artistGuides).where(eq(artistGuides.artistId, artistId))).find(
    (row) => row.kind === kind && row.status === 'proposed',
  );

beforeEach(async () => {
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  await truncate();
  await seed({
    ...USERS,
    artistGuides: [
      ...USERS.artistGuides,
      pendingProposal(C, 'voice', { rules: ['Proposed.'] }),
      pendingProposal(C, 'brand', GUIDE),
      pendingProposal(ARTIST_A.id, 'brand', GUIDE),
    ],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('guide param', () => {
  it.each([
    ['voice', true],
    ['brand', true],
    ['curated', false],
    ['Voice', false],
  ])('%s matches: %s', (value, ok) => {
    expect(params.guide['~standard'].validate(value)).toEqual(
      ok ? { value } : { issues: [expect.any(Object)] },
    );
  });
});

describe('every guide route', () => {
  it.each([approve, discard, propose])(
    '404s a user without a profile, never 403',
    async (handler) => {
      expect(await status(call(handler, 'voice', USER_B, { proposalId: 1 }))).toBe(404);
    },
  );
});

describe('POST /api/guides/{kind}/propose', () => {
  it('proposes a voice from edits alone for an owner without YouTube', async () => {
    await db().delete(connections).where(eq(connections.uid, USER_C.uid));
    await seed({
      artistMemory: [
        {
          artistId: C,
          kind: 'feedback',
          data: {
            kind: 'EDITED',
            jobId: 'j',
            songTitle: 'S',
            pickVersion: 1,
            field: 'title',
            before: 'a',
            after: 'b',
            at: 1,
          },
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => interaction(JSON.stringify({ rules: ['Lowercase.'] }))),
    );
    const response = await call(propose, 'voice', USER_C);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ proposal: { body: { rules: ['Lowercase.'] } } });
  });

  it('waits on a reconnect for a brand guide without YouTube', async () => {
    await db().delete(connections).where(eq(connections.uid, USER_C.uid));
    vi.stubGlobal('fetch', vi.fn());
    const response = await call(propose, 'brand', USER_C);
    expect(await response.json()).toEqual({ wait: 'reconnect YouTube' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('POST /api/guides/{kind}/approve', () => {
  it('approves the edited voice and answers the approved version', async () => {
    const { id } = (await proposalOf(C, 'voice'))!;
    const response = await call(approve, 'voice', USER_C, { proposalId: id, rules: [' Mine. '] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      approved: { body: { rules: ['Mine.'] }, sources: { carriedOver: false } },
    });
    expect(await proposalOf(C, 'voice')).toBeUndefined();
  });

  it('approves the edited brand guide', async () => {
    const { id } = (await proposalOf(C, 'brand'))!;
    const response = await call(approve, 'brand', USER_C, {
      proposalId: id,
      ...GUIDE,
      statement: 'New.',
    });
    expect(await response.json()).toMatchObject({
      approved: { body: { ...GUIDE, statement: 'New.' } },
    });
  });

  it.each([
    [
      'without a numeric proposalId',
      'voice',
      { proposalId: '1', rules: ['a'] },
      400,
      'Name the proposal being approved.',
    ],
    [
      'with the wrong voice shape',
      'voice',
      { proposalId: 1, rules: 'a' },
      400,
      'Expected voice rules.',
    ],
    [
      'with the wrong brand shape',
      'brand',
      { proposalId: 1, statement: 'S.' },
      400,
      'Expected a statement and keep, fix, drop lists.',
    ],
    [
      'with no voice rules',
      'voice',
      { proposalId: 1, rules: ['  '] },
      422,
      'Add at least one voice rule.',
    ],
    [
      'with an empty statement',
      'brand',
      { proposalId: 1, ...GUIDE, statement: ' ' },
      422,
      'The brand statement is required.',
    ],
  ] as const)('refuses a body %s, writing nothing', async (_label, kind, body, code, error) => {
    const response = await call(approve, kind, USER_C, body);
    expect(response.status).toBe(code);
    expect(await response.json()).toEqual({ error, fields: null });
    expect(await proposalOf(C, kind)).toBeDefined();
  });

  it("404s on another artist's proposal id, changing neither artist", async () => {
    const { id } = (await proposalOf(ARTIST_A.id, 'brand'))!;
    const response = await call(approve, 'brand', USER_C, { proposalId: id, ...GUIDE });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'The guide changed in another tab. Reload to see it.',
      fields: null,
    });
    expect(await proposalOf(ARTIST_A.id, 'brand')).toBeDefined();
    expect(await proposalOf(C, 'brand')).toBeDefined();
  });

  it('ignores an artist named in the body', async () => {
    const { id } = (await proposalOf(C, 'voice'))!;
    await call(approve, 'voice', USER_C, {
      proposalId: id,
      rules: ['Mine.'],
      artistId: ARTIST_A.id,
    });
    const nathan = await withIdentity(USER_A.uid, () =>
      db().select().from(artistGuides).where(eq(artistGuides.artistId, ARTIST_A.id)),
    );
    expect(nathan.find((row) => row.kind === 'voice')!.body).not.toEqual({ rules: ['Mine.'] });
  });
});

describe('POST /api/guides/{kind}/discard', () => {
  it('discards the named proposal', async () => {
    const { id } = (await proposalOf(C, 'brand'))!;
    const response = await call(discard, 'brand', USER_C, { proposalId: id });
    expect(await response.json()).toEqual({ proposal: null });
    expect(await proposalOf(C, 'brand')).toBeUndefined();
  });

  it('400s without a numeric proposalId', async () => {
    const response = await call(discard, 'voice', USER_C, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Name the proposal being discarded.',
      fields: null,
    });
  });

  it("404s on another artist's proposal", async () => {
    const { id } = (await proposalOf(ARTIST_A.id, 'brand'))!;
    expect((await call(discard, 'brand', USER_C, { proposalId: id })).status).toBe(404);
    expect(await proposalOf(ARTIST_A.id, 'brand')).toBeDefined();
  });
});
